import type { OpenAPIHono } from '@hono/zod-openapi';
import type { Child } from 'hono/jsx';
import type { ActorKind, Project, ReviewAction } from '../../db/schema';
import { positionOf } from '../../diff/summary';
import type { DiffData, DiffErrorData, ElementChange, Rect, Region, Size } from '../../diff/types';
import { actorName } from '../../domain/actors';
import {
  type Area,
  aroundChange,
  createArea,
  deleteArea,
  ignoreChanges,
  listAreas,
  MAX_AREAS_PER_SNAPSHOT,
} from '../../domain/areas';
import { baselineHistory } from '../../domain/baselines';
import { type BuildView, getBuild } from '../../domain/builds';
import { type CheckView, checkNeighbors, compareWithoutAreas, listChecks } from '../../domain/checks';
import { type ScreenHistory, screenHistory } from '../../domain/flaky';
import { type ChangeGroup, getGroup } from '../../domain/groups';
import { imageSizes } from '../../domain/images';
import { getProjectById } from '../../domain/projects';
import {
  acceptSuggestion,
  approveCheck,
  dismissSuggestion,
  listReviews,
  rejectCheck,
  resetReview,
} from '../../domain/reviews';
import { visibleCheck } from '../../http/access';
import type { AppEnv, Services } from '../../http/env';
import {
  Ago,
  CheckStatus,
  cardStatus,
  Dot,
  FlakyBadge,
  flakyText,
  HistoryStrip,
  thumbnailSha,
  toneOf,
  Variant,
} from '../components';
import { field, noticeOf, type Ui, uiOf, userOf } from '../context';
import { type CheckFilter, filterFromQuery } from '../filters';
import { Layout } from '../layout';

function isDiffData(diff: CheckView['diff']): diff is DiffData {
  return diff !== null && !('error' in diff);
}

/** Who reviewed: a user's email, the name of the project token that did it, auto-approve or a GitHub merge. */
function reviewerName(s: Services, id: string): Promise<string> {
  return actorName(s.deps, id);
}

/** A box on a screenshot that lights up with its entry in the list of changes. */
interface Mark {
  id: string;
  rect: Rect;
  /** Where a moved or resized element was (drawn dashed). */
  was?: boolean;
}

/** The list of changes: element changes first (ids `e0`, `e1`…), then the regions none of them explains. */
interface ListedChanges {
  elements: Array<{ id: string; change: ElementChange }>;
  regions: Array<{ id: string; region: Region; n: number }>;
  marks: Mark[];
}

function listedChanges(diff: DiffData | null): ListedChanges {
  if (!diff) return { elements: [], regions: [], marks: [] };
  const changes = diff.changes ?? [];
  const explained = new Set(changes.flatMap((c) => c.regions));
  const elements = changes.map((change, i) => ({ id: `e${i}`, change }));
  const marks: Mark[] = [];
  for (const { id, change } of elements) {
    const now = change.to ?? change.from;
    if (now) marks.push({ id, rect: now });
    if (change.to && change.from && (change.kinds.includes('moved') || change.kinds.includes('resized'))) {
      marks.push({ id, rect: change.from, was: true });
    }
  }
  const regions = diff.regions
    .map((region, i) => ({ id: String(i), region }))
    .filter(({ id }) => !explained.has(Number(id)))
    .map((r, n) => ({ ...r, n: n + 1 }));
  return { elements, regions, marks };
}

/** Text with `backticked` selectors shown as code. */
function Ticks({ text }: { text: string }) {
  return <>{text.split('`').map((part, i) => (i % 2 === 1 ? <code>{part}</code> : part))}</>;
}

const capitalize = (text: string) => text.replace(/^[a-z]/, (c) => c.toUpperCase());

/** What changed, without the element's name: "moved 12 px down". */
function whatChanged(change: ElementChange): string {
  return change.description.startsWith(`${change.label} `)
    ? change.description.slice(change.label.length + 1)
    : change.description;
}

/** “top left” for a change on an image of known size. */
function placeOf(change: ElementChange, size: Size | undefined): string {
  return areaPlace(around(change), size).replace(/ · $/, '') || `${around(change).width}×${around(change).height} px`;
}

/** The smallest rectangle around both boxes of a change. */
function around(change: ElementChange): Rect {
  const boxes = [change.from, change.to].filter((r): r is Rect => r !== null);
  const x = Math.min(...boxes.map((b) => b.x));
  const y = Math.min(...boxes.map((b) => b.y));
  const right = Math.max(...boxes.map((b) => b.x + b.width));
  const bottom = Math.max(...boxes.map((b) => b.y + b.height));
  return { x, y, width: right - x, height: bottom - y };
}

/** A screenshot with its change regions (boxes that light up from the info strip) and areas. */
function Shot(props: {
  ui: Ui;
  sha: string;
  alt: string;
  size?: Size | undefined;
  regions?: Region[] | undefined;
  areas?: Area[] | undefined;
  /** Ignore regions the test sent with this check (`ignoreRegions` in the API). */
  apiIgnore?: Rect[] | undefined;
  /** Boxes of element changes: where the element is, and (dashed) where it was. */
  marks?: Mark[] | undefined;
  /** Where a flaky screen keeps changing: shown while the reviewer points at its Ignore. */
  unstable?: Rect | undefined;
}) {
  const { ui, sha, alt, size, regions } = props;
  const marks = props.marks ?? [];
  return (
    <div class="shot">
      <img
        src={ui.url(`/api/v1/images/${sha}`)}
        alt={alt}
        width={size?.width}
        height={size?.height}
        draggable="false"
      />
      {size && ((regions && regions.length > 0) || marks.length > 0) && (
        // Region boxes as SVG attributes: the CSP forbids inline styles.
        <svg viewBox={`0 0 ${size.width} ${size.height}`} preserveAspectRatio="none" aria-hidden="true">
          {(regions ?? []).map((r, i) => (
            <rect x={r.x} y={r.y} width={r.width} height={r.height} data-change={i} />
          ))}
          {marks.map((m) => (
            <rect
              x={m.rect.x}
              y={m.rect.y}
              width={m.rect.width}
              height={m.rect.height}
              data-change={m.id}
              class={m.was ? 'was' : undefined}
            />
          ))}
        </svg>
      )}
      {size && <AreaLayer areas={props.areas} apiIgnore={props.apiIgnore} size={size} />}
      <UnstableLayer area={props.unstable} size={size} />
    </div>
  );
}

/** The area a flaky screen keeps changing in, over a screenshot; hidden until asked for (CSS). */
function UnstableLayer({ area, size }: { area: Rect | undefined; size: Size | undefined }) {
  if (!area || !size) return null;
  return (
    <svg
      class="area-layer unstable-layer"
      viewBox={`0 0 ${size.width} ${size.height}`}
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      <rect class="area area-ignore unstable-rect" x={area.x} y={area.y} width={area.width} height={area.height} />
    </svg>
  );
}

/**
 * The snapshot's ignore and compare areas, drawn over a screenshot in its own coordinates, and
 * the ignore regions the test sent through the API (same colour, never editable).
 */
function AreaLayer(props: { areas: Area[] | undefined; apiIgnore?: Rect[] | undefined; size: Size | undefined }) {
  const { areas = [], apiIgnore = [], size } = props;
  if (!size || (areas.length === 0 && apiIgnore.length === 0)) return null;
  return (
    <svg class="area-layer" viewBox={`0 0 ${size.width} ${size.height}`} preserveAspectRatio="none" aria-hidden="true">
      {apiIgnore.map((r) => (
        <rect class="area area-ignore area-from-api" x={r.x} y={r.y} width={r.width} height={r.height} />
      ))}
      {areas.map((a) => (
        <rect class={`area area-${a.kind}`} x={a.x} y={a.y} width={a.width} height={a.height} data-area={a.id} />
      ))}
    </svg>
  );
}

const AREA_PLURAL: Record<Area['kind'], string> = { ignore: 'ignore areas', compare: 'compare areas' };

/**
 * Drawing tools for reviewers (Plan 6): pick a kind, then drag over a screenshot. A snapshot has
 * one kind of area, so once it has some, the other kind is disabled. The edit bar shows while an
 * area is being moved or resized (the island needs JavaScript, so it starts hidden).
 */
function DrawTools({ areas, off = false }: { areas: Area[]; off?: boolean }) {
  const present = areas[0]?.kind;
  const tool = (kind: Area['kind'], label: string, key: string) => {
    // While Show diff is on nothing can be drawn; the buttons stay so the toolbar does not move.
    if (off) {
      return (
        <button type="button" data-draw-off={kind} disabled title="Back to the comparison with the areas to draw one">
          {label} <kbd>{key.toUpperCase()}</kbd>
        </button>
      );
    }
    const blocked = present !== undefined && present !== kind;
    const what = `Draw ${kind === 'ignore' ? 'an ignore' : 'a compare'} area`;
    return (
      <button
        type="button"
        data-draw={kind}
        data-key={key}
        data-key-label={what}
        aria-pressed="false"
        disabled={blocked}
        title={blocked ? `Delete the ${AREA_PLURAL[present]} first to use ${AREA_PLURAL[kind]}` : what}
      >
        {label} <kbd>{key.toUpperCase()}</kbd>
      </button>
    );
  };
  return (
    <>
      <fieldset class="segmented draw-tools">
        <legend class="visually-hidden">Draw an area</legend>
        {tool('ignore', 'Ignore', 'i')}
        {tool('compare', 'Compare', 'c')}
      </fieldset>
      <div class="area-edit-bar" hidden>
        {/* A ring that empties as the autosave nears, with the seconds left in it. */}
        <span class="autosave" data-autosave hidden>
          <svg class="autosave-ring" viewBox="0 0 24 24" aria-hidden="true">
            <circle class="autosave-track" cx="12" cy="12" r="10" />
            <circle class="autosave-progress" cx="12" cy="12" r="10" />
          </svg>
          <span class="autosave-left" data-autosave-left>
            5s
          </span>
        </span>
        <button type="button" class="small primary" data-area-save aria-label="Save area">
          Save <kbd>↵</kbd>
        </button>
        <button type="button" class="small" data-area-cancel>
          Cancel <kbd>Esc</kbd>
        </button>
        <button
          type="button"
          class="small ghost"
          data-area-duplicate-picked
          data-mod-title="Duplicate this area ({mod}D), or Alt+drag it"
          title="Duplicate this area (Ctrl+D), or Alt+drag it"
        >
          Duplicate <kbd data-mod-key="D">Ctrl+D</kbd>
        </button>
      </div>
    </>
  );
}

/** One image area; the viewport clips, the canvas is what the island zooms and pans. */
function Pane({ kind, caption, children }: { kind: string; caption: Child; children: Child }) {
  return (
    <figure class={`pane pane-${kind}`}>
      <figcaption>{caption}</figcaption>
      <div class="viewport">
        <div class="canvas">{children}</div>
      </div>
    </figure>
  );
}

/** The Areas switch: on shows the check as compared; off links to it compared without any area. */
interface AreasSwitch {
  on: boolean;
  href: string;
}

function Stage(props: {
  ui: Ui;
  check: CheckView;
  sizes: Map<string, Size>;
  areas: Area[];
  canReview: boolean;
  areasSwitch?: AreasSwitch | undefined;
  unstable?: Rect | undefined;
}) {
  const { ui, check, sizes, areas } = props;
  const diff = isDiffData(check.diff) ? check.diff : null;
  const baseline = check.baseline;
  if (!baseline) {
    return (
      <section class="stage" id="stage" data-mode="new" aria-label="New snapshot">
        <div class="panes">
          <Pane kind="current" caption="New snapshot — no baseline yet">
            <Shot
              ui={ui}
              sha={check.imageSha}
              alt="new snapshot"
              size={sizes.get(check.imageSha)}
              areas={areas}
              apiIgnore={check.ignoreRegions}
            />
          </Pane>
        </div>
      </section>
    );
  }
  const modes: Array<[mode: string, label: string, key: string]> = [
    ['side', 'Side', '1'],
    ['slider', 'Slider', '2'],
    ['onion', 'Onion', '3'],
  ];
  // With Show diff the toolbar keeps the same buttons either way (nothing moves under the pointer):
  // Diff and Changes are there, disabled, when the areas hide every change.
  const steady = props.areasSwitch !== undefined;
  const noDiff = !check.diffImageSha;
  if (check.diffImageSha || steady) modes.push(['diff', 'Diff', '4']);
  const drawingOff = props.areasSwitch !== undefined && !props.areasSwitch.on;
  const baseSize = sizes.get(baseline.imageSha);
  const currentSize = sizes.get(check.imageSha);
  const { marks } = listedChanges(diff);
  return (
    // `all` is the no-JavaScript view: side by side, then the diff. The island switches modes.
    <section
      class="stage"
      id="stage"
      data-mode="all"
      data-areas-off={props.areasSwitch && !props.areasSwitch.on ? '' : undefined}
      aria-label="Comparison"
    >
      <div class="stage-toolbar" hidden>
        <fieldset class="segmented modes">
          <legend class="visually-hidden">Compare mode</legend>
          {modes.map(([mode, label, key]) => (
            <button
              type="button"
              data-mode-button={mode}
              aria-pressed="false"
              disabled={mode === 'diff' && noDiff}
              title={mode === 'diff' && noDiff ? 'No changes left to show: the areas hide them' : undefined}
            >
              {label} <kbd>{key}</kbd>
            </button>
          ))}
        </fieldset>
        {check.diffImageSha ? (
          <button
            type="button"
            class="small highlight-toggle"
            data-highlight
            aria-pressed="true"
            title="Highlight changed pixels on the screenshots (H)"
          >
            Changes <kbd>H</kbd>
          </button>
        ) : (
          steady && (
            <button type="button" class="small highlight-toggle" disabled title="No changes left to highlight">
              Changes <kbd>H</kbd>
            </button>
          )
        )}
        {props.areasSwitch && (
          <a
            class="button small areas-toggle"
            href={props.areasSwitch.href}
            data-areas={props.areasSwitch.on ? 'on' : 'off'}
            title={
              props.areasSwitch.on
                ? 'Show the diff without the areas: what they hide (the check stays as it is)'
                : 'Back to the comparison with the areas'
            }
          >
            Show diff
          </a>
        )}
        <label class="onion-control" hidden>
          <span class="muted">Opacity</span>
          <input type="range" min="0" max="100" value="50" data-onion />
        </label>
        <div class="stage-actions">
          {props.canReview && <DrawTools areas={areas} off={drawingOff} />}
          <div class="zoom-controls">
            <button
              type="button"
              class="small zoom-toggle"
              data-zoom="toggle"
              aria-label="Toggle fit and 100% (Z)"
              title="Fit / 100% (Z)"
            >
              <span data-zoom-label>Fit</span>
              <FitIcon />
            </button>
          </div>
        </div>
      </div>
      <div class="panes">
        <Pane kind="baseline" caption={`Baseline · ${baseline.branch}`}>
          {/* No marks on the baseline: changes and areas are this build's. */}
          <Shot ui={ui} sha={baseline.imageSha} alt="baseline" size={baseSize} />
        </Pane>
        <Pane kind="current" caption="This build">
          <Shot
            ui={ui}
            sha={check.imageSha}
            alt="this build"
            size={currentSize}
            regions={diff?.regions}
            marks={marks}
            areas={areas}
            apiIgnore={check.ignoreRegions}
            unstable={props.unstable}
          />
        </Pane>
        {check.diffImageSha && (
          <Pane kind="diff" caption="Diff · changes in red">
            <Shot
              ui={ui}
              sha={check.diffImageSha}
              alt="diff"
              size={sizes.get(check.diffImageSha)}
              regions={diff?.regions}
              marks={marks}
              areas={areas}
              apiIgnore={check.ignoreRegions}
            />
          </Pane>
        )}
        <Pane
          kind="overlay"
          caption={
            <>
              <span>{`Baseline · ${baseline.branch}`}</span>
              <span>This build</span>
            </>
          }
        >
          <div class="layers">
            <img
              draggable="false"
              src={ui.url(`/api/v1/images/${baseline.imageSha}`)}
              alt=""
              width={baseSize?.width}
              height={baseSize?.height}
            />
            <img
              draggable="false"
              class="layer-top"
              src={ui.url(`/api/v1/images/${check.imageSha}`)}
              alt=""
              width={currentSize?.width}
              height={currentSize?.height}
            />
            <AreaLayer areas={areas} apiIgnore={check.ignoreRegions} size={currentSize} />
            <UnstableLayer area={props.unstable} size={currentSize} />
            <div class="divider" aria-hidden="true" />
          </div>
        </Pane>
      </div>
    </section>
  );
}

/** “top left · ” for an area of an image of known size; empty when the size is unknown. */
function areaPlace(region: Rect, size: Size | undefined): string {
  return size ? `${positionOf({ ...region, pixels: 0 }, size.width, size.height).replace('-', ' ')} · ` : '';
}

/** One entry of a check's review history, with the actor's name resolved. */
interface HistoryEntry {
  action: ReviewAction;
  who: string;
  kind: ActorKind;
  comment: string | null;
  at: number;
}

const HISTORY_VERB: Record<ReviewAction, string> = {
  approved: 'Approved',
  rejected: 'Rejected',
  reset: 'Undone',
  suggested_approval: 'Suggested approving',
  suggested_rejection: 'Suggested rejecting',
  suggestion_dismissed: 'Dismissed the suggestion',
};

async function historyOf(s: Services, checkId: string): Promise<HistoryEntry[]> {
  const events = await listReviews(s.deps, checkId);
  const names = new Map<string, string>();
  for (const { actor, actorName } of events) {
    // A token is named as it was when it acted (it may be deleted or renamed since).
    if (!names.has(actor)) names.set(actor, actorName ? `token “${actorName}”` : await reviewerName(s, actor));
  }
  return events.map((e) => ({
    action: e.action,
    who: names.get(e.actor) ?? e.actor,
    kind: e.actorKind,
    comment: e.comment,
    at: e.createdAt,
  }));
}

/** How many approvals of a screen the baseline history shows. */
const BASELINE_HISTORY = 10;

/** One baseline of the screen: the image, where it came from, who approved it and when. */
interface BaselineEntry {
  id: string;
  imageSha: string;
  /** The check that became this baseline and its build; null for a seeded one. */
  checkId: string | null;
  buildNumber: number | null;
  who: string;
  at: number;
}

/** The last approvals of this check's screen on its baseline's branch, newest first. */
async function baselineHistoryOf(s: Services, project: Project, check: CheckView): Promise<BaselineEntry[]> {
  if (!check.baseline) return [];
  const page = await baselineHistory(s.deps, project.slug, check.snapshotKey, {
    branch: check.baseline.branch,
    limit: BASELINE_HISTORY,
  });
  const sources = page.items.map((b) => b.sourceCheckId).filter((id): id is string => !!id);
  const builds = new Map<string, number>();
  if (sources.length > 0) {
    const rows = await s.deps.db
      .selectFrom('checks')
      .innerJoin('builds', 'builds.id', 'checks.buildId')
      .select(['checks.id', 'builds.number'])
      .where('checks.id', 'in', sources)
      .execute();
    for (const row of rows) builds.set(row.id, Number(row.number));
  }
  const names = new Map<string, string>();
  for (const { approvedBy } of page.items) {
    if (!names.has(approvedBy)) names.set(approvedBy, await reviewerName(s, approvedBy));
  }
  return page.items.map((b) => ({
    id: b.id,
    imageSha: b.imageSha,
    checkId: b.sourceCheckId && builds.has(b.sourceCheckId) ? b.sourceCheckId : null,
    buildNumber: b.sourceCheckId ? (builds.get(b.sourceCheckId) ?? null) : null,
    who: names.get(b.approvedBy) ?? b.approvedBy,
    at: b.createdAt,
  }));
}

/**
 * How the screen's baseline changed: the last approvals, newest (current) first, each with its
 * image, build, approver and time. Folded under its count.
 */
function BaselineHistory(props: { ui: Ui; check: CheckView; entries: BaselineEntry[] }) {
  const { ui, check, entries } = props;
  if (entries.length === 0) return null;
  return (
    <details class="baselines">
      <summary>
        Baseline history <span class="count">{entries.length}</span>
      </summary>
      <ol>
        {entries.map((e, i) => {
          const thumb = (
            <img
              class="baseline-img"
              src={ui.url(`/api/v1/images/${e.imageSha}`)}
              alt=""
              loading="lazy"
              draggable="false"
            />
          );
          return (
            <li class="baseline-entry">
              {e.checkId ? (
                <a class="baseline-thumb" href={ui.url(`/ui/checks/${e.checkId}`)}>
                  {thumb}
                </a>
              ) : (
                <span class="baseline-thumb">{thumb}</span>
              )}
              <span class="baseline-meta">
                <span class="baseline-title">
                  {e.checkId && e.buildNumber !== null ? (
                    <a href={ui.url(`/ui/checks/${e.checkId}`)}>{`Build #${e.buildNumber}`}</a>
                  ) : (
                    <span>Seeded</span>
                  )}
                  {i === 0 && <span class="pill tone-green">current</span>}
                  {i > 0 && e.id === check.baseline?.id && <span class="pill tone-grey">compared</span>}
                </span>
                <span class="muted">
                  {`by ${e.who} · `}
                  <Ago at={e.at} />
                </span>
              </span>
            </li>
          );
        })}
      </ol>
    </details>
  );
}

/** Who approved, rejected or undid, newest first. The newest entry names the current reviewer. */
function History({ check, history }: { check: CheckView; history: HistoryEntry[] }) {
  if (history.length === 0) return null;
  const reviewed = check.review === 'approved' || check.review === 'rejected';
  return (
    <section class="review-history" aria-label="Review history">
      <h3>History</h3>
      <ol>
        {history.map((entry, i) => (
          <li class={`event event-${entry.action}`} data-reviewed-by={i === 0 && reviewed ? entry.who : undefined}>
            <span class="event-what">
              <strong>{HISTORY_VERB[entry.action]}</strong>
              {` by ${entry.who}`}
              {entry.kind === 'token' && (
                <span class="badge-agent" title="A project token: an agent or CI">
                  agent
                </span>
              )}
            </span>
            <Ago at={entry.at} />
            {entry.comment && <span class="comment">{`“${entry.comment}”`}</span>}
          </li>
        ))}
      </ol>
    </section>
  );
}

/** A pencil: edit. Drawn with `currentColor`, so it follows the button's colour. */
function EditIcon() {
  return (
    <svg class="icon icon-edit" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M11 2.5l2.5 2.5L5.5 13H3v-2.5z" />
      <path d="M9.5 4l2.5 2.5" />
    </svg>
  );
}

/** Four corners: fit the screenshot to the stage, or show it at 100 %. */
function FitIcon() {
  return (
    <svg class="icon icon-fit" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M2.5 6V2.5H6M10 2.5h3.5V6M13.5 10v3.5H10M6 13.5H2.5V10" />
    </svg>
  );
}

/** Two overlapping boxes: duplicate. */
function DuplicateIcon() {
  return (
    <svg class="icon icon-duplicate" viewBox="0 0 16 16" aria-hidden="true">
      <rect x="5.5" y="5.5" width="8" height="8" rx="1" />
      <path d="M10.5 3V2.5h-8v8H3" />
    </svg>
  );
}

/** A bin: delete. */
function DeleteIcon() {
  return (
    <svg class="icon icon-delete" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M2.5 4h11" />
      <path d="M6 4V2.5h4V4" />
      <path d="M4 4l.75 9.5h6.5L12 4" />
      <path d="M6.75 6.5v4.5M9.25 6.5v4.5" />
    </svg>
  );
}

const AREA_VERB: Record<Area['kind'], string> = { ignore: 'Ignored', compare: 'Compared' };

/** The snapshot's drawn areas, each with what it does and, for reviewers, Delete. */
function Areas(props: {
  ui: Ui;
  check: CheckView;
  areas: Area[];
  size: Size | undefined;
  filter: CheckFilter;
  canReview: boolean;
  /** Show diff is on: the areas are listed where they are, disabled. */
  off?: boolean;
}) {
  const { ui, check, areas, size } = props;
  const api = check.ignoreRegions;
  if (areas.length === 0 && api.length === 0) return null;
  return (
    <section class={props.off ? 'areas is-off' : 'areas'} aria-label="Areas">
      <h3>Areas</h3>
      <ul>
        {areas.map((a) => (
          <li class={`area-item area-item-${a.kind}`} data-area-item={a.id}>
            <span class="area-text">
              <span class="area-title">
                <strong>{AREA_VERB[a.kind]}</strong>{' '}
                <span
                  class="badge-source"
                  title="Drawn in pixeltwin: applies to every check of this snapshot, on every branch"
                >
                  UI
                </span>
              </span>
              <span class="area-place muted">{`${areaPlace(a, size)}${a.width}×${a.height} px`}</span>
            </span>
            {props.canReview && (
              <span class="area-actions">
                <button
                  type="button"
                  class="small ghost icon-button"
                  data-area-edit={props.off ? undefined : a.id}
                  hidden
                  aria-label="Edit this area"
                  title="Move or resize this area"
                >
                  <EditIcon />
                </button>
                {!props.off && (
                  <button
                    type="button"
                    class="small ghost icon-button"
                    data-area-duplicate={a.id}
                    hidden
                    aria-label="Duplicate this area"
                    data-mod-title="Duplicate this area: a copy of the same size below it (pick it, then {mod}D)"
                    title="Duplicate this area: a copy of the same size below it"
                  >
                    <DuplicateIcon />
                  </button>
                )}
                <form
                  method="post"
                  action={ui.url(`/ui/checks/${check.id}/areas/${a.id}/delete`)}
                  data-area-delete={a.id}
                >
                  <input type="hidden" name="filter" value={props.filter.key} />
                  <button
                    type="submit"
                    class="small ghost icon-button danger-hover"
                    aria-label="Delete this area"
                    title={props.off ? 'Back to the comparison with the areas to change them' : 'Delete this area'}
                    disabled={props.off}
                  >
                    <DeleteIcon />
                  </button>
                </form>
              </span>
            )}
          </li>
        ))}
        {api.map((r) => (
          <li class="area-item area-item-api">
            <span class="area-text">
              <span class="area-title">
                <strong>Ignored</strong>{' '}
                <span class="badge-source" title="Sent with the check through the API (ignoreRegions)">
                  API
                </span>
              </span>
              <span class="area-place muted">{`${areaPlace(r, size)}${r.width}×${r.height} px`}</span>
            </span>
          </li>
        ))}
      </ul>
      {areas.length > 0 && <p class="hint">Areas apply to every check of this snapshot, on every branch.</p>}
    </section>
  );
}

/** Up to this many changes are listed open; more start folded. */
const CHANGES_OPEN = 3;

/** Ignore next to a change: a form that adds an ignore area over it (works without JavaScript too). */
function IgnoreChange(props: {
  ui: Ui;
  check: CheckView;
  region: Rect;
  /** What the button ignores, for its accessible name: "change 2", "button#buy". */
  label: string;
  size: Size | undefined;
  filter: CheckFilter;
  blocked: boolean;
  /** Show diff is on: nothing can be ignored until the areas are back. */
  off?: boolean;
}) {
  const area = aroundChange(props.region, props.size);
  return (
    <form method="post" action={props.ui.url(`/ui/checks/${props.check.id}/areas`)} data-area-add>
      <input type="hidden" name="filter" value={props.filter.key} />
      <input type="hidden" name="kind" value="ignore" />
      <input type="hidden" name="x" value={String(area.x)} />
      <input type="hidden" name="y" value={String(area.y)} />
      <input type="hidden" name="width" value={String(area.width)} />
      <input type="hidden" name="height" value={String(area.height)} />
      <button
        type="submit"
        class="small ignore-action"
        aria-label={`Ignore ${props.label}`}
        title={
          props.off
            ? 'Back to the comparison with the areas to ignore a change'
            : props.blocked
              ? 'Delete the compare areas first to ignore a change'
              : 'Add an ignore area over this change, for every check of this snapshot'
        }
        disabled={props.blocked || props.off}
      >
        Ignore
      </button>
    </form>
  );
}

const SUGGESTS: Record<'approve' | 'reject', string> = { approve: 'approving', reject: 'rejecting' };

/**
 * An agent's open suggestion (agent review policy): what it suggests and why, with one-click
 * Accept and Dismiss for people who can review.
 */
function Suggestion(props: { ui: Ui; check: CheckView; filter: CheckFilter; canReview: boolean }) {
  const { ui, check, filter } = props;
  const suggestion = check.suggestion;
  if (!suggestion) return null;
  const decidable = check.review === 'pending' || (suggestion.action === 'approve' && check.review === 'rejected');
  return (
    <section class={`suggestion suggestion-${suggestion.action}`} aria-label="Agent suggestion" data-suggestion>
      <p class="suggestion-text">
        <strong>{`Agent suggests ${SUGGESTS[suggestion.action]}`}</strong>
        {suggestion.reason ? `: ${suggestion.reason}` : ''}
      </p>
      <p class="suggestion-who muted">
        <span class="badge-agent">agent</span>
        {` token “${suggestion.by.name ?? suggestion.by.id}” · `}
        <Ago at={suggestion.at} />
      </p>
      {props.canReview && decidable && (
        <div class="suggestion-actions">
          <form method="post" action={ui.url(`/ui/checks/${check.id}/suggestion/accept`)}>
            <input type="hidden" name="filter" value={filter.key} />
            <button type="submit" class={`small ${suggestion.action === 'approve' ? 'approve' : 'reject'}`}>
              {suggestion.action === 'approve' ? 'Accept and approve' : 'Accept and reject'}
            </button>
          </form>
          <form method="post" action={ui.url(`/ui/checks/${check.id}/suggestion/dismiss`)}>
            <input type="hidden" name="filter" value={filter.key} />
            <button type="submit" class="small ghost">
              Dismiss
            </button>
          </form>
        </div>
      )}
    </section>
  );
}

/**
 * A check of a change group: the same change is on other screens of the build. Lists them and,
 * for reviewers, approves all that wait at once (the review island does it in place).
 */
function GroupNote(props: { ui: Ui; check: CheckView; group: ChangeGroup; filter: CheckFilter; canReview: boolean }) {
  const { ui, check, group, filter } = props;
  const others = group.checks.filter((c) => c.id !== check.id);
  const pending = group.counts.pending;
  const path = `/builds/${check.buildId}/groups/${group.id}`;
  return (
    <section class="group-note" aria-label="The same change on other screens">
      <p>
        <strong>{`Also on ${others.length} other screen${others.length === 1 ? '' : 's'}`}</strong>
        <span class="muted"> of this build: exactly the same change</span>
      </p>
      <details class="group-others">
        <summary>
          Screens <span class="count">{others.length}</span>
        </summary>
        <ul>
          {others.map((c) => (
            <li>
              <a href={ui.url(`/ui/checks/${c.id}?filter=${filter.key}`)}>
                <span class={`member-state state-${cardStatus({ result: 'changed', ...c })}`}>{c.review}</span>
                <span class="member-name">{c.name}</span>
                <Variant variant={c.variant} />
              </a>
            </li>
          ))}
        </ul>
      </details>
      {props.canReview && pending > 0 && (
        <form
          class="group-approve"
          method="post"
          action={ui.url(`/ui${path}/approve`)}
          data-group-review={`${path}/approve`}
          data-group-undo={`${path}/reset`}
        >
          <input type="hidden" name="filter" value={filter.key} />
          <input type="hidden" name="back" value="check" />
          <button type="submit" class="small approve" title="Approve every screen of this build with this change">
            {`Approve all ${pending}`}
          </button>
        </form>
      )}
    </section>
  );
}

/**
 * The screen's last results on this branch and, when it keeps flipping, why it is flaky and a way
 * to ignore the area that keeps changing: a preview of the area first, then one click.
 */
function ScreenSection(props: {
  ui: Ui;
  check: CheckView;
  screen: ScreenHistory | null;
  size: Size | undefined;
  areas: Area[];
  filter: CheckFilter;
  canReview: boolean;
  /** Show diff is on: nothing can be ignored until the areas are back. */
  off?: boolean;
}) {
  const { ui, check, screen, size } = props;
  if (!screen || screen.history.length < 2) return null;
  const flaky = screen.flaky;
  const area = flaky?.unstableArea ? aroundChange(flaky.unstableArea, size) : null;
  const blocked = props.areas.some((a) => a.kind === 'compare');
  return (
    <section class="screen-section" aria-label="This screen's history">
      <h3>
        This screen <span class="muted">{`on ${screen.branch}`}</span> <FlakyBadge flaky={flaky} />
      </h3>
      <HistoryStrip ui={ui} history={screen.history} current={check.id} />
      {flaky && (
        <p class="hint">{`It keeps changing back and forth: ${flakyText(flaky)}. Its changes are likely noise.`}</p>
      )}
      {flaky && area && props.canReview && (
        <details class="unstable" data-unstable-trigger>
          <summary
            class="button small ignore-action"
            aria-disabled={blocked || props.off ? 'true' : undefined}
            title="Preview the area that keeps changing, then ignore it for every check of this snapshot"
          >
            Ignore noisy area
          </summary>
          <div class="unstable-preview">
            {size && (
              <span class="unstable-shot">
                <img
                  class="unstable-img"
                  src={ui.url(`/api/v1/images/${check.imageSha}`)}
                  alt=""
                  width={size.width}
                  height={size.height}
                />
                <svg
                  class="unstable-mark"
                  viewBox={`0 0 ${size.width} ${size.height}`}
                  preserveAspectRatio="none"
                  aria-hidden="true"
                >
                  <rect class="area area-ignore" x={area.x} y={area.y} width={area.width} height={area.height} />
                </svg>
              </span>
            )}
            <p class="muted">
              {`${areaPlace(area, size)}${area.width}×${area.height} px. An ignore area applies to every check of this snapshot, on every branch.`}
            </p>
            <form class="unstable-actions" method="post" action={ui.url(`/ui/checks/${check.id}/areas`)} data-area-add>
              <input type="hidden" name="filter" value={props.filter.key} />
              <input type="hidden" name="kind" value="ignore" />
              <input type="hidden" name="x" value={String(area.x)} />
              <input type="hidden" name="y" value={String(area.y)} />
              <input type="hidden" name="width" value={String(area.width)} />
              <input type="hidden" name="height" value={String(area.height)} />
              <button type="button" class="small ghost" data-unstable-close>
                Cancel
              </button>
              <button
                type="submit"
                class="small primary"
                disabled={blocked || props.off}
                title={
                  props.off
                    ? 'Back to the comparison with the areas to ignore this area'
                    : blocked
                      ? 'Delete the compare areas first to ignore an area'
                      : 'Add this ignore area; the check is compared again at once'
                }
              >
                Ignore this area
              </button>
            </form>
          </div>
        </details>
      )}
    </section>
  );
}

function Info(props: {
  ui: Ui;
  check: CheckView;
  branch: string;
  history: HistoryEntry[];
  baselines: BaselineEntry[];
  size: Size | undefined;
  areas: Area[];
  filter: CheckFilter;
  canReview: boolean;
  /** Shown compared without any area (the Areas switch is off). */
  areasOff?: boolean;
  group: ChangeGroup | null;
  screen: ScreenHistory | null;
}) {
  const { check, branch, size } = props;
  const diff = isDiffData(check.diff) ? check.diff : null;
  const diffError = check.diff && !isDiffData(check.diff) ? (check.diff as DiffErrorData).error : null;
  const dims = diff?.dimensions;
  const listed = listedChanges(diff);
  return (
    <aside class="review-info" aria-label="About this check">
      {check.suggestion && <Suggestion ui={props.ui} check={check} filter={props.filter} canReview={props.canReview} />}
      {diffError && <p class="diff-error">{diffError.message}</p>}
      {props.group && (
        <GroupNote ui={props.ui} check={check} group={props.group} filter={props.filter} canReview={props.canReview} />
      )}
      <dl class="facts">
        {diff && (
          <>
            <dt>Diff</dt>
            <dd>{`${diff.percent}%`}</dd>
          </>
        )}
        {diff && (
          <>
            <dt>Tolerance</dt>
            <dd>{`${check.tolerancePercent}%`}</dd>
          </>
        )}
        {check.baseline && (
          <>
            <dt>Branch</dt>
            <dd>
              <span class="mono">{check.baseline.branch}</span>
              {check.baseline.fallback && <span class="muted">{` (fallback: ${branch} has none yet)`}</span>}
            </dd>
          </>
        )}
        {dims && (dims.baseline.width !== dims.current.width || dims.baseline.height !== dims.current.height) && (
          <>
            <dt>Size</dt>
            <dd>{`${dims.baseline.width}×${dims.baseline.height} → ${dims.current.width}×${dims.current.height}`}</dd>
          </>
        )}
      </dl>
      <Areas
        ui={props.ui}
        check={check}
        areas={props.areas}
        size={size}
        filter={props.filter}
        canReview={props.canReview}
        off={props.areasOff ?? false}
      />
      {diff && diff.regions.length > 0 && (
        // A few changes are listed open; a long list starts folded under its count.
        <details
          class="changes"
          open={listed.elements.length + listed.regions.length <= CHANGES_OPEN ? true : undefined}
        >
          <summary>
            Changes{' '}
            <span class="count">{`${listed.elements.length + listed.regions.length}${diff.regionsTruncated || diff.changesTruncated ? '+' : ''}`}</span>
          </summary>
          <ul class="regions" aria-label="Changes">
            {listed.elements.map(({ id, change }) => (
              <li>
                <button
                  type="button"
                  class="small ghost"
                  data-change={id}
                  aria-pressed="false"
                  title="Highlight this element on the screenshots"
                >
                  <span class="region-name">
                    <Ticks text={capitalize(change.label)} />
                  </span>
                  <span class="region-place muted">{`${capitalize(whatChanged(change))} · ${placeOf(change, size)}`}</span>
                </button>
                {props.canReview && (
                  <IgnoreChange
                    ui={props.ui}
                    check={check}
                    region={around(change)}
                    label={change.label.replaceAll('`', '')}
                    size={size}
                    filter={props.filter}
                    blocked={props.areas.some((a) => a.kind === 'compare')}
                    off={props.areasOff ?? false}
                  />
                )}
              </li>
            ))}
            {listed.regions.map(({ id, region: r, n }) => (
              <li>
                <button
                  type="button"
                  class="small ghost"
                  data-change={id}
                  aria-pressed="false"
                  title="Highlight this change on the screenshots"
                >
                  <span class="region-name">{`${listed.elements.length > 0 ? 'Other change' : 'Change'} ${n}`}</span>
                  <span class="region-place muted">{`${areaPlace(r, size)}${r.width}×${r.height} px`}</span>
                </button>
                {props.canReview && (
                  <IgnoreChange
                    ui={props.ui}
                    check={check}
                    region={r}
                    label={`change ${n}`}
                    size={size}
                    filter={props.filter}
                    blocked={props.areas.some((a) => a.kind === 'compare')}
                    off={props.areasOff ?? false}
                  />
                )}
              </li>
            ))}
            {(diff.regionsTruncated || diff.changesTruncated) && <li class="muted">and more, smaller</li>}
          </ul>
          {props.canReview && diff.regions.length > 1 && (
            <form
              class="ignore-all"
              method="post"
              action={props.ui.url(`/ui/checks/${check.id}/areas/ignore-changes`)}
              data-ignore-changes
            >
              <input type="hidden" name="filter" value={props.filter.key} />
              <button
                type="submit"
                class="small"
                title={
                  props.areasOff
                    ? 'Back to the comparison with the areas to ignore changes'
                    : props.areas.some((a) => a.kind === 'compare')
                      ? 'Delete the compare areas first to ignore changes'
                      : 'Add an ignore area over every change, for every check of this snapshot'
                }
                disabled={props.areasOff || props.areas.some((a) => a.kind === 'compare')}
              >
                {listed.elements.length > 0 ? 'Ignore all changes' : `Ignore all ${diff.regions.length} changes`}
              </button>
            </form>
          )}
        </details>
      )}
      <ScreenSection
        ui={props.ui}
        check={check}
        screen={props.screen}
        size={size}
        areas={props.areas}
        filter={props.filter}
        canReview={props.canReview}
        off={props.areasOff ?? false}
      />
      <BaselineHistory ui={props.ui} check={check} entries={props.baselines} />
      <History check={check} history={props.history} />
    </aside>
  );
}

/** The newer check whose approval made this one outdated, with its build number. */
interface DecidedBy {
  checkId: string;
  buildNumber: number;
}

function ActionBar(props: {
  ui: Ui;
  check: CheckView;
  filter: CheckFilter;
  next: string | null;
  canReview: boolean;
  decidedBy: DecidedBy | null;
}) {
  const { ui, check, filter, next, decidedBy } = props;
  // An outdated check is not reviewed here: a newer build already decided its screen.
  if (check.review === 'outdated' && decidedBy) {
    return (
      <div class="action-bar">
        <p class="outdated-note">
          {`Build #${decidedBy.buildNumber} already approved this screen; this older screenshot can no longer replace it. `}
          <a href={ui.url(`/ui/checks/${decidedBy.checkId}`)}>{`Open #${decidedBy.buildNumber} →`}</a>
        </p>
      </div>
    );
  }
  if (!props.canReview) return null;
  const reviewable = check.review === 'pending' || check.review === 'rejected';
  const resettable = check.review === 'approved' || check.review === 'rejected';
  if (!reviewable && !resettable) return null;
  return (
    <div class="action-bar">
      {resettable && (
        <form method="post" action={ui.url(`/ui/checks/${check.id}/reset`)} data-reset-form>
          <button type="submit" class="ghost" data-key="u" data-key-label="Undo review">
            Undo review <kbd>U</kbd>
          </button>
        </form>
      )}
      {reviewable && (
        <form class="review-form" method="post" action={ui.url(`/ui/checks/${check.id}/approve`)} data-review-form>
          <input type="hidden" name="filter" value={filter.key} />
          <div class="review-buttons">
            {check.review === 'pending' && (
              // Spec §3.4: only a pending check can be rejected; a rejected one can still be approved.
              <button
                type="submit"
                class="reject"
                formaction={ui.url(`/ui/checks/${check.id}/reject`)}
                data-key="r"
                data-key-label="Reject"
              >
                Reject <kbd>R</kbd>
              </button>
            )}
            {next && (
              <a class="button ghost" href={next} data-skip>
                Skip
              </a>
            )}
            <button type="submit" class="approve" data-key="a" data-key-label="Approve">
              Approve <kbd>A</kbd>
            </button>
          </div>
        </form>
      )}
    </div>
  );
}

function Filmstrip(props: {
  ui: Ui;
  checks: CheckView[];
  current: string;
  filter: CheckFilter;
  sizes: Map<string, Size>;
}) {
  const { ui, checks, current, filter } = props;
  return (
    <nav class="filmstrip" aria-label="Checks in this build">
      <ol>
        {checks.map((c) => {
          const sha = thumbnailSha(c);
          const size = props.sizes.get(sha);
          const state = c.review === 'none' ? c.result : c.review;
          return (
            <li>
              <a
                class="frame"
                href={ui.url(`/ui/checks/${c.id}?filter=${filter.key}`)}
                aria-current={c.id === current ? 'true' : undefined}
                data-frame={c.id}
                data-review={c.review}
              >
                <img
                  draggable="false"
                  src={ui.url(`/api/v1/images/${sha}`)}
                  alt=""
                  loading="lazy"
                  width={size?.width}
                  height={size?.height}
                />
                <Dot tone={toneOf(state)} label={`${c.name}: ${state}`} />
              </a>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

function CheckPage(props: {
  ui: Ui;
  project: Project;
  build: BuildView;
  check: CheckView;
  filter: CheckFilter;
  strip: CheckView[];
  sizes: Map<string, Size>;
  canReview: boolean;
  history: HistoryEntry[];
  baselines: BaselineEntry[];
  areas: Area[];
  decidedBy: DecidedBy | null;
  notice?: string | undefined;
  areasSwitch?: AreasSwitch | undefined;
  /** The check compared without any area, while the Areas switch is off. */
  withoutAreas?: Pick<CheckView, 'result' | 'diff' | 'diffImageSha'> | undefined;
  group: ChangeGroup | null;
  screen: ScreenHistory | null;
}) {
  const { ui, project, build, check, filter, strip } = props;
  const off = props.withoutAreas !== undefined;
  // Show diff: the comparison without any area. The stage draws none; the panel keeps listing them.
  const compared: CheckView = props.withoutAreas ? { ...check, ...props.withoutAreas } : check;
  const shown: CheckView = props.withoutAreas ? { ...compared, ignoreRegions: [] } : check;
  const at = strip.findIndex((c) => c.id === check.id);
  // When the check is outside the filter (reviewed meanwhile), its neighbours are found by order.
  // The strip is newest first: the previous check is the next newer one, the next is older.
  const prevCheck = at >= 0 ? strip[at - 1] : strip.filter((c) => c.id > check.id).at(-1);
  const nextCheck = at >= 0 ? strip[at + 1] : strip.find((c) => c.id < check.id);
  const href = (c: CheckView | undefined) => (c ? ui.url(`/ui/checks/${c.id}?filter=${filter.key}`) : null);
  const prev = href(prevCheck);
  const next = href(nextCheck);
  // Back on the build page, the page of cards that holds this check, with its card focused.
  const buildHref = ui.url(`/ui/builds/${build.id}?filter=${filter.key}&focus=${check.id}`);
  return (
    <Layout
      ui={ui}
      title={check.name}
      notice={props.notice}
      islands={['review']}
      project={project.slug}
      variant="focus"
      crumbs={[
        { label: project.name, href: ui.url(`/ui/p/${project.slug}`) },
        {
          label: build.branch,
          href: ui.url(`/ui/p/${project.slug}/builds?branch=${encodeURIComponent(build.branch)}`),
        },
        { label: `#${build.number}`, href: ui.url(`/ui/builds/${build.id}`) },
        { label: check.name },
      ]}
    >
      <div
        class="review"
        id="review"
        data-check={check.id}
        data-area-limit={String(MAX_AREAS_PER_SNAPSHOT)}
        data-build={build.id}
        data-build-number={String(build.number)}
        data-project-href={ui.url(`/ui/p/${project.slug}`)}
        data-filter={filter.key}
      >
        <header class="review-head">
          <a class="button ghost small" href={buildHref} data-key="escape" data-key-label="Back to the build">
            {`← #${build.number}`}
          </a>
          <div class="review-title">
            <h1>{check.name}</h1>
            <Variant variant={check.variant} />
          </div>
          <CheckStatus check={check} />
          <FlakyBadge flaky={props.screen?.flaky} />
          <span class="review-nav">
            {prev && (
              <a
                class="button small"
                href={prev}
                data-key="k"
                data-key-label="Previous check"
                aria-label="Previous check"
              >
                ←
              </a>
            )}
            <span class="review-position">{`${at >= 0 ? at + 1 : '–'} / ${strip.length}`}</span>
            {next && (
              <a class="button small" href={next} data-key="j" data-key-label="Next check" aria-label="Next check">
                →
              </a>
            )}
          </span>
        </header>
        <div class="progress" data-progress hidden>
          <span />
        </div>
        <div class="review-body">
          {/* Areas off: the comparison without any area, nothing drawn on it, nothing to ignore. */}
          <Stage
            ui={ui}
            check={shown}
            sizes={props.sizes}
            areas={off ? [] : props.areas}
            canReview={props.canReview}
            areasSwitch={props.areasSwitch}
            unstable={off ? undefined : (props.screen?.flaky?.unstableArea ?? undefined)}
          />
          <Info
            ui={ui}
            check={compared}
            branch={build.branch}
            history={props.history}
            baselines={props.baselines}
            size={props.sizes.get(check.imageSha)}
            areas={props.areas}
            filter={filter}
            canReview={props.canReview}
            areasOff={off}
            group={props.group}
            screen={props.screen}
          />
        </div>
        <ActionBar
          ui={ui}
          check={check}
          filter={filter}
          next={next}
          canReview={props.canReview}
          decidedBy={props.decidedBy}
        />
        <Filmstrip ui={ui} checks={strip} current={check.id} filter={filter} sizes={props.sizes} />
      </div>
    </Layout>
  );
}

async function decidedByOf(s: Services, checkId: string): Promise<DecidedBy | null> {
  const row = await s.deps.db
    .selectFrom('checks')
    .innerJoin('builds', 'builds.id', 'checks.buildId')
    .select('builds.number')
    .where('checks.id', '=', checkId)
    .executeTakeFirst();
  return row ? { checkId, buildNumber: row.number } : null;
}

export function registerCheckPages(app: OpenAPIHono<AppEnv>, s: Services): void {
  app.get('/ui/checks/:id', async (c) => {
    const ui = uiOf(c, s);
    const { check, access } = await visibleCheck(c, s.deps, c.req.param('id'), 'project.read');
    // Focus mode walks what waits for review unless told otherwise (UI spec §5.1).
    const filter = filterFromQuery({ filter: c.req.query('filter') }, 'pending');
    const [project, build, strip, history, areas, decidedBy, group] = await Promise.all([
      getProjectById(s.deps, check.projectId),
      getBuild(s.deps, check.buildId),
      listChecks(s.deps, check.buildId, {
        result: filter.result,
        review: filter.review,
        status: filter.status,
        order: 'desc',
        limit: 200,
      }),
      historyOf(s, check.id),
      listAreas(s.deps, check.id),
      check.supersededBy ? decidedByOf(s, check.supersededBy) : Promise.resolve(null),
      check.groupId ? getGroup(s.deps, check.buildId, check.groupId) : Promise.resolve(null),
    ]);
    const screen = await screenHistory(s.deps, {
      projectId: check.projectId,
      snapshotKey: check.snapshotKey,
      branch: build.branch,
    });
    // The Areas switch: a check with areas and a baseline can be shown compared without them.
    const hasAreas = areas.length > 0 || check.ignoreRegions.length > 0;
    const base = `/ui/checks/${check.id}?filter=${filter.key}`;
    const wantsOff = c.req.query('areas') === 'off';
    const withoutAreas = hasAreas && wantsOff ? await compareWithoutAreas(s.deps, check.id) : null;
    const areasSwitch =
      hasAreas && check.baseline
        ? { on: !withoutAreas, href: ui.url(withoutAreas ? base : `${base}&areas=off`) }
        : undefined;
    const baselines = await baselineHistoryOf(s, project, check);
    const sizes = await imageSizes(s.deps, [
      ...[check.imageSha, check.baseline?.imageSha, check.diffImageSha, withoutAreas?.diffImageSha].filter(
        (x): x is string => !!x,
      ),
      ...strip.items.map(thumbnailSha),
    ]);
    return c.html(
      <CheckPage
        ui={ui}
        project={project}
        build={build}
        check={check}
        filter={filter}
        strip={strip.items}
        sizes={sizes}
        canReview={access.can('check.review')}
        history={history}
        baselines={baselines}
        areas={areas}
        decidedBy={decidedBy}
        notice={noticeOf(c)}
        areasSwitch={areasSwitch}
        withoutAreas={withoutAreas ?? undefined}
        group={group}
        screen={screen}
      />,
    );
  });

  for (const action of ['approve', 'reject'] as const) {
    app.post(`/ui/checks/:id/${action}`, async (c) => {
      const ui = uiOf(c, s);
      const user = userOf(c);
      const id = c.req.param('id');
      await visibleCheck(c, s.deps, id, 'check.review');
      const form = await c.req.parseBody();
      const comment = field(form, 'comment');
      const filterKey = field(form, 'filter');
      const filter = filterKey ? `filter=${filterFromQuery({ filter: filterKey }).key}&` : '';
      const review = action === 'approve' ? approveCheck : rejectCheck;
      const check = await review(s.deps, id, user.id, comment ? { comment } : {});
      const done = action === 'approve' ? 'approved' : 'rejected';
      // From a card on the build page: back to that page and card.
      if (field(form, 'back') === 'build') {
        const at = filterKey ? `filter=${filterFromQuery({ filter: filterKey }).key}&` : '';
        const page = /^\d{1,5}$/.test(field(form, 'page') ?? '') ? `page=${field(form, 'page')}&` : '';
        return c.redirect(ui.url(`/ui/builds/${check.buildId}?${at}${page}done=${done}#${check.id}`), 303);
      }
      // Keep the reviewer moving: the next check awaiting review, else back to the build.
      const { nextPending } = await checkNeighbors(s.deps, check);
      return c.redirect(
        ui.url(
          nextPending ? `/ui/checks/${nextPending}?${filter}done=${done}` : `/ui/builds/${check.buildId}?done=${done}`,
        ),
        303,
      );
    });
  }

  app.post('/ui/checks/:id/suggestion/accept', async (c) => {
    const ui = uiOf(c, s);
    const user = userOf(c);
    await visibleCheck(c, s.deps, c.req.param('id'), 'check.review');
    const form = await c.req.parseBody();
    const filterKey = field(form, 'filter');
    const filter = filterKey ? `filter=${filterFromQuery({ filter: filterKey }).key}&` : '';
    const check = await acceptSuggestion(s.deps, c.req.param('id'), user.id);
    const done = check.review === 'rejected' ? 'rejected' : 'approved';
    const { nextPending } = await checkNeighbors(s.deps, check);
    return c.redirect(
      ui.url(
        nextPending ? `/ui/checks/${nextPending}?${filter}done=${done}` : `/ui/builds/${check.buildId}?done=${done}`,
      ),
      303,
    );
  });

  app.post('/ui/checks/:id/suggestion/dismiss', async (c) => {
    const ui = uiOf(c, s);
    const user = userOf(c);
    await visibleCheck(c, s.deps, c.req.param('id'), 'check.review');
    const form = await c.req.parseBody();
    const filter = filterFromQuery({ filter: field(form, 'filter') }, 'pending');
    const check = await dismissSuggestion(s.deps, c.req.param('id'), user.id);
    return c.redirect(ui.url(`/ui/checks/${check.id}?filter=${filter.key}&done=suggestion-dismissed`), 303);
  });

  app.post('/ui/checks/:id/areas', async (c) => {
    const ui = uiOf(c, s);
    await visibleCheck(c, s.deps, c.req.param('id'), 'check.review');
    const form = await c.req.parseBody();
    const filter = filterFromQuery({ filter: field(form, 'filter') }, 'pending');
    const number = (name: string) => Number(field(form, name));
    const { check } = await createArea(s.deps, c.req.param('id'), userOf(c).id, {
      kind: field(form, 'kind'),
      x: number('x'),
      y: number('y'),
      width: number('width'),
      height: number('height'),
    });
    return c.redirect(ui.url(`/ui/checks/${check.id}?filter=${filter.key}&done=area-added`), 303);
  });

  app.post('/ui/checks/:id/areas/ignore-changes', async (c) => {
    const ui = uiOf(c, s);
    await visibleCheck(c, s.deps, c.req.param('id'), 'check.review');
    const form = await c.req.parseBody();
    const filter = filterFromQuery({ filter: field(form, 'filter') }, 'pending');
    const { check } = await ignoreChanges(s.deps, c.req.param('id'), userOf(c).id);
    return c.redirect(ui.url(`/ui/checks/${check.id}?filter=${filter.key}&done=changes-ignored`), 303);
  });

  app.post('/ui/checks/:id/areas/:areaId/delete', async (c) => {
    const ui = uiOf(c, s);
    await visibleCheck(c, s.deps, c.req.param('id'), 'check.review');
    const form = await c.req.parseBody();
    const filter = filterFromQuery({ filter: field(form, 'filter') }, 'pending');
    const check = await deleteArea(s.deps, c.req.param('id'), c.req.param('areaId'));
    return c.redirect(ui.url(`/ui/checks/${check.id}?filter=${filter.key}&done=area-deleted`), 303);
  });

  app.post('/ui/checks/:id/reset', async (c) => {
    const ui = uiOf(c, s);
    await visibleCheck(c, s.deps, c.req.param('id'), 'check.review');
    const check = await resetReview(s.deps, c.req.param('id'), userOf(c).id);
    return c.redirect(ui.url(`/ui/checks/${check.id}?done=reset`), 303);
  });
}
