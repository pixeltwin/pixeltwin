import type { OpenAPIHono } from '@hono/zod-openapi';
import type { Child } from 'hono/jsx';
import type { Project, ReviewAction } from '../../db/schema';
import { positionOf } from '../../diff/summary';
import type { DiffData, DiffErrorData, Rect, Region, Size } from '../../diff/types';
import { type Area, aroundChange, createArea, deleteArea, ignoreChanges, listAreas } from '../../domain/areas';
import { hasPermission } from '../../domain/auth/policy';
import { baselineHistory } from '../../domain/baselines';
import { type BuildView, getBuild } from '../../domain/builds';
import { type CheckView, checkNeighbors, compareWithoutAreas, getCheck, listChecks } from '../../domain/checks';
import { imageSizes } from '../../domain/images';
import { getProjectById } from '../../domain/projects';
import { AUTO_APPROVER, approveCheck, listReviews, rejectCheck, resetReview } from '../../domain/reviews';
import { AppError } from '../../errors';
import type { AppEnv, Services } from '../../http/env';
import { Ago, CheckStatus, Dot, thumbnailSha, toneOf, Variant } from '../components';
import { field, noticeOf, type Ui, uiOf, userOf } from '../context';
import { type CheckFilter, filterFromQuery } from '../filters';
import { Layout } from '../layout';

function isDiffData(diff: CheckView['diff']): diff is DiffData {
  return diff !== null && !('error' in diff);
}

/** Who reviewed: a user's email, or the name of the project token that did it. */
async function reviewerName(s: Services, id: string): Promise<string> {
  if (id === AUTO_APPROVER) return 'auto-approve (project setting)';
  const user = await s.deps.db.selectFrom('users').select('email').where('id', '=', id).executeTakeFirst();
  if (user) return user.email;
  const token = await s.deps.db.selectFrom('projectTokens').select('name').where('id', '=', id).executeTakeFirst();
  return token ? `token “${token.name}”` : 'a deleted account';
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
}) {
  const { ui, sha, alt, size, regions } = props;
  return (
    <div class="shot">
      <img
        src={ui.url(`/api/v1/images/${sha}`)}
        alt={alt}
        width={size?.width}
        height={size?.height}
        draggable="false"
      />
      {size && regions && regions.length > 0 && (
        // Region boxes as SVG attributes: the CSP forbids inline styles.
        <svg viewBox={`0 0 ${size.width} ${size.height}`} preserveAspectRatio="none" aria-hidden="true">
          {regions.map((r, i) => (
            <rect x={r.x} y={r.y} width={r.width} height={r.height} data-change={i} />
          ))}
        </svg>
      )}
      {size && <AreaLayer areas={props.areas} apiIgnore={props.apiIgnore} size={size} />}
    </div>
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
            areas={areas}
            apiIgnore={check.ignoreRegions}
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
  comment: string | null;
  at: number;
}

const HISTORY_VERB: Record<ReviewAction, string> = { approved: 'Approved', rejected: 'Rejected', reset: 'Undone' };

async function historyOf(s: Services, checkId: string): Promise<HistoryEntry[]> {
  const events = await listReviews(s.deps, checkId);
  const names = new Map<string, string>();
  for (const { actor } of events) if (!names.has(actor)) names.set(actor, await reviewerName(s, actor));
  return events.map((e) => ({
    action: e.action,
    who: names.get(e.actor) ?? e.actor,
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
}) {
  const { ui, check, areas, size } = props;
  const api = check.ignoreRegions;
  if (areas.length === 0 && api.length === 0) return null;
  return (
    <section class="areas" aria-label="Areas">
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
                  data-area-edit={a.id}
                  hidden
                  aria-label="Edit this area"
                  title="Move or resize this area"
                >
                  <EditIcon />
                </button>
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
                    title="Delete this area"
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
  index: number;
  size: Size | undefined;
  filter: CheckFilter;
  blocked: boolean;
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
        class="small ignore-change"
        aria-label={`Ignore change ${props.index + 1}`}
        title={
          props.blocked
            ? 'Delete the compare areas first to ignore a change'
            : 'Add an ignore area over this change, for every check of this snapshot'
        }
        disabled={props.blocked}
      >
        Ignore
      </button>
    </form>
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
}) {
  const { check, branch, size } = props;
  const diff = isDiffData(check.diff) ? check.diff : null;
  const diffError = check.diff && !isDiffData(check.diff) ? (check.diff as DiffErrorData).error : null;
  const dims = diff?.dimensions;
  return (
    <aside class="review-info" aria-label="About this check">
      {props.areasOff && (
        <p class="areas-off">Areas are off: this is what they hide. The check and its areas stay as they are.</p>
      )}
      {diffError && <p class="diff-error">{diffError.message}</p>}
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
      />
      {diff && diff.regions.length > 0 && (
        // A few changes are listed open; a long list starts folded under its count.
        <details class="changes" open={diff.regions.length <= CHANGES_OPEN ? true : undefined}>
          <summary>
            Changes <span class="count">{`${diff.regions.length}${diff.regionsTruncated ? '+' : ''}`}</span>
          </summary>
          <ul class="regions" aria-label="Changes">
            {diff.regions.map((r, i) => (
              <li>
                <button
                  type="button"
                  class="small ghost"
                  data-change={i}
                  aria-pressed="false"
                  title="Highlight this change on the screenshots"
                >
                  <span class="region-name">{`Change ${i + 1}`}</span>
                  <span class="region-place muted">{`${areaPlace(r, size)}${r.width}×${r.height} px`}</span>
                </button>
                {props.canReview && (
                  <IgnoreChange
                    ui={props.ui}
                    check={check}
                    region={r}
                    index={i}
                    size={size}
                    filter={props.filter}
                    blocked={props.areas.some((a) => a.kind === 'compare')}
                  />
                )}
              </li>
            ))}
            {diff.regionsTruncated && <li class="muted">and more, smaller</li>}
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
                  props.areas.some((a) => a.kind === 'compare')
                    ? 'Delete the compare areas first to ignore changes'
                    : 'Add an ignore area over every change, for every check of this snapshot'
                }
                disabled={props.areas.some((a) => a.kind === 'compare')}
              >
                {`Ignore all ${diff.regions.length} changes`}
              </button>
            </form>
          )}
        </details>
      )}
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
}) {
  const { ui, project, build, check, filter, strip } = props;
  const off = props.withoutAreas !== undefined;
  const shown: CheckView = props.withoutAreas ? { ...check, ...props.withoutAreas, ignoreRegions: [] } : check;
  const at = strip.findIndex((c) => c.id === check.id);
  // When the check is outside the filter (reviewed meanwhile), its neighbours are found by order.
  // The strip is newest first: the previous check is the next newer one, the next is older.
  const prevCheck = at >= 0 ? strip[at - 1] : strip.filter((c) => c.id > check.id).at(-1);
  const nextCheck = at >= 0 ? strip[at + 1] : strip.find((c) => c.id < check.id);
  const href = (c: CheckView | undefined) => (c ? ui.url(`/ui/checks/${c.id}?filter=${filter.key}`) : null);
  const prev = href(prevCheck);
  const next = href(nextCheck);
  const buildHref = ui.url(`/ui/builds/${build.id}?filter=${filter.key}`);
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
          />
          <Info
            ui={ui}
            check={shown}
            branch={build.branch}
            history={props.history}
            baselines={props.baselines}
            size={props.sizes.get(check.imageSha)}
            areas={off ? [] : props.areas}
            filter={filter}
            canReview={props.canReview && !off}
            areasOff={off}
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
    const check = await getCheck(s.deps, c.req.param('id'));
    // Focus mode walks what waits for review unless told otherwise (UI spec §5.1).
    const filter = filterFromQuery({ filter: c.req.query('filter') }, 'pending');
    const [project, build, strip, history, areas, decidedBy] = await Promise.all([
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
    ]);
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
        canReview={hasPermission(userOf(c), 'check.review')}
        history={history}
        baselines={baselines}
        areas={areas}
        decidedBy={decidedBy}
        notice={noticeOf(c)}
        areasSwitch={areasSwitch}
        withoutAreas={withoutAreas ?? undefined}
      />,
    );
  });

  for (const action of ['approve', 'reject'] as const) {
    app.post(`/ui/checks/:id/${action}`, async (c) => {
      const ui = uiOf(c, s);
      const user = userOf(c);
      if (!hasPermission(user, 'check.review')) {
        throw new AppError('forbidden', 403, 'Only admins and reviewers can review checks.');
      }
      const form = await c.req.parseBody();
      const comment = field(form, 'comment');
      const filterKey = field(form, 'filter');
      const filter = filterKey ? `filter=${filterFromQuery({ filter: filterKey }).key}&` : '';
      const id = c.req.param('id');
      const review = action === 'approve' ? approveCheck : rejectCheck;
      const check = await review(s.deps, id, user.id, comment ? { comment } : {});
      const done = action === 'approve' ? 'approved' : 'rejected';
      // From a card on the build page: back to that page and card.
      if (field(form, 'back') === 'build') {
        const at = filterKey ? `filter=${filterFromQuery({ filter: filterKey }).key}&` : '';
        return c.redirect(ui.url(`/ui/builds/${check.buildId}?${at}done=${done}#${check.id}`), 303);
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

  app.post('/ui/checks/:id/areas', async (c) => {
    const ui = uiOf(c, s);
    if (!hasPermission(userOf(c), 'check.review')) {
      throw new AppError('forbidden', 403, 'Only admins and reviewers can change areas.');
    }
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
    if (!hasPermission(userOf(c), 'check.review')) {
      throw new AppError('forbidden', 403, 'Only admins and reviewers can change areas.');
    }
    const form = await c.req.parseBody();
    const filter = filterFromQuery({ filter: field(form, 'filter') }, 'pending');
    const { check } = await ignoreChanges(s.deps, c.req.param('id'), userOf(c).id);
    return c.redirect(ui.url(`/ui/checks/${check.id}?filter=${filter.key}&done=changes-ignored`), 303);
  });

  app.post('/ui/checks/:id/areas/:areaId/delete', async (c) => {
    const ui = uiOf(c, s);
    if (!hasPermission(userOf(c), 'check.review')) {
      throw new AppError('forbidden', 403, 'Only admins and reviewers can change areas.');
    }
    const form = await c.req.parseBody();
    const filter = filterFromQuery({ filter: field(form, 'filter') }, 'pending');
    const check = await deleteArea(s.deps, c.req.param('id'), c.req.param('areaId'));
    return c.redirect(ui.url(`/ui/checks/${check.id}?filter=${filter.key}&done=area-deleted`), 303);
  });

  app.post('/ui/checks/:id/reset', async (c) => {
    const ui = uiOf(c, s);
    if (!hasPermission(userOf(c), 'check.review')) {
      throw new AppError('forbidden', 403, 'Only admins and reviewers can review checks.');
    }
    const check = await resetReview(s.deps, c.req.param('id'), userOf(c).id);
    return c.redirect(ui.url(`/ui/checks/${check.id}?done=reset`), 303);
  });
}
