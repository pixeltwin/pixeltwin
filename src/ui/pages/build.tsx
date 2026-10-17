import type { OpenAPIHono } from '@hono/zod-openapi';
import type { Project } from '../../db/schema';
import type { DiffData, Rect, Size } from '../../diff/types';
import { type BuildView, finalizeBuild, getBuild } from '../../domain/builds';
import { type CheckView, firstPendingCheckId, listChecks, type VariantTag, variantTags } from '../../domain/checks';
import { type FlakySignal, screenHistories } from '../../domain/flaky';
import { type ChangeGroup, listGroups, reviewGroup } from '../../domain/groups';
import { imageSizes } from '../../domain/images';
import { getProjectById } from '../../domain/projects';
import { REJECT_REASON_INFO } from '../../domain/reject-reasons';
import { approveBuild } from '../../domain/reviews';
import { visibleBuild } from '../../http/access';
import type { AppEnv, Services } from '../../http/env';
import {
  Ago,
  BuildStatus,
  BuildTime,
  cardStatus,
  countsText,
  FlakyBadge,
  statusText,
  thumbnailSha,
  Variant,
} from '../components';
import { field, noticeOf, type Ui, uiOf, userOf } from '../context';
import { CHECK_FILTERS, type CheckFilter, countFor, filterFromQuery } from '../filters';
import { Layout } from '../layout';
import { RejectMenu, reasonInput } from '../reject-menu';

/** A card's tooltip: its status and, rejected, why (category and comment). */
function cardTitle(check: CheckView): string {
  if (check.review !== 'rejected') return statusText(check);
  const why = check.reviewReasonCode ? REJECT_REASON_INFO[check.reviewReasonCode].meaning : null;
  const parts = [why, check.reviewComment ? `“${check.reviewComment}”` : null].filter(Boolean);
  return parts.length ? `${statusText(check)}: ${parts.join(' · ')}` : statusText(check);
}

/**
 * One check: a link to it, and for reviewers an Approve button on a new screenshot waiting for
 * review (nothing to compare it with, so the thumbnail is enough). The form sits beside the link.
 */
function CheckCard(props: {
  ui: Ui;
  check: CheckView;
  size?: Size | undefined;
  filter: CheckFilter;
  canReview: boolean;
  flaky?: FlakySignal | undefined;
}) {
  const { ui, check, size, filter } = props;
  // A changed check shows its new screenshot; the thumbs island paints the diff's changes over it.
  const diffSrc =
    check.result === 'changed' && check.diffImageSha ? ui.url(`/api/v1/images/${check.diffImageSha}`) : null;
  const sha = diffSrc ? check.imageSha : thumbnailSha(check);
  const diff = check.diff && 'percent' in check.diff ? check.diff : null;
  const approvable = props.canReview && check.result === 'new' && check.review === 'pending';
  return (
    <div
      class={approvable ? 'check-card-wrap approvable' : 'check-card-wrap'}
      id={check.id}
      data-search={[check.name, ...Object.values(check.variant)].join(' ').toLowerCase()}
    >
      <a
        class={`check-card card-${cardStatus(check)}`}
        title={cardTitle(check)}
        href={ui.url(`/ui/checks/${check.id}?filter=${filter.key}`)}
      >
        <div class="thumb" data-diff={diffSrc ?? undefined}>
          <span class="thumb-stack">
            <img
              src={ui.url(`/api/v1/images/${sha}`)}
              alt={check.name}
              loading="lazy"
              width={size?.width}
              height={size?.height}
            />
          </span>
        </div>
        <div class="check-card-body">
          <span class="check-name" title={check.name}>
            {check.name}
          </span>
          <Variant variant={check.variant} />
          <span class="card-status">
            <span class="card-state">{cardStatus(check)}</span>
            {check.review === 'rejected' && check.reviewReasonCode && (
              <span class="card-reason" title={cardTitle(check)}>
                {REJECT_REASON_INFO[check.reviewReasonCode].label.toLowerCase()}
              </span>
            )}
            {check.result === 'changed' && check.review !== 'rejected' && diff && (
              <span class="diff-pct" title="Pixels changed">{`${diff.percent}%`}</span>
            )}
            {check.suggestion && (
              <span
                class="badge-agent"
                title={`Agent suggests ${check.suggestion.action === 'approve' ? 'approving' : 'rejecting'}${check.suggestion.reason ? `: ${check.suggestion.reason}` : ''}`}
              >
                {check.suggestion.action === 'approve' ? 'agent: approve' : 'agent: reject'}
              </span>
            )}
            <FlakyBadge flaky={props.flaky} />
          </span>
        </div>
      </a>
      {approvable && (
        <form
          class="card-approve"
          method="post"
          action={ui.url(`/ui/checks/${check.id}/approve`)}
          data-inplace={`/checks/${check.id}/approve`}
          data-inplace-done={`Approved ${check.name}`}
          data-inplace-undo={`/checks/${check.id}/reset`}
        >
          <input type="hidden" name="filter" value={filter.key} />
          <input type="hidden" name="back" value="build" />
          <button type="submit" class="small approve" title="Approve this new screenshot: it becomes the baseline">
            Approve
          </button>
        </form>
      )}
    </div>
  );
}

const isDiff = (diff: CheckView['diff']): diff is DiffData => diff !== null && 'regions' in diff;

/** Room left around the shared change in a group's thumbnail. */
const CROP_PAD = 8;
/** Width to height of each half of a group's thumbnail; the crop grows to it around the change. */
const CROP_ASPECT = 3;

/** The changes' bounding box with some room, grown to CROP_ASPECT, inside the screenshot. */
function cropBox(regions: Rect[], size: Size): Rect {
  let x = Math.max(0, Math.min(...regions.map((r) => r.x)) - CROP_PAD);
  let y = Math.max(0, Math.min(...regions.map((r) => r.y)) - CROP_PAD);
  let width = Math.min(size.width, Math.max(...regions.map((r) => r.x + r.width)) + CROP_PAD) - x;
  let height = Math.min(size.height, Math.max(...regions.map((r) => r.y + r.height)) + CROP_PAD) - y;
  const clamp = (v: number, max: number) => Math.max(0, Math.min(v, max));
  if (width / height > CROP_ASPECT) {
    const grown = Math.min(size.height, Math.ceil(width / CROP_ASPECT));
    y = clamp(Math.round(y - (grown - height) / 2), size.height - grown);
    height = grown;
  } else {
    const grown = Math.min(size.width, Math.ceil(height * CROP_ASPECT));
    x = clamp(Math.round(x - (grown - width) / 2), size.width - grown);
    width = grown;
  }
  return { x, y, width, height };
}

/**
 * A group's thumbnail: the shared change before and after, cropped from the first check's
 * baseline and screenshot (SVG viewBoxes: no image is made, and the CSP allows no inline styles).
 */
function GroupCrop(props: { ui: Ui; check: CheckView; size: Size | undefined }) {
  const { ui, check, size } = props;
  const regions = isDiff(check.diff) ? check.diff.regions : [];
  if (!size || !check.baseline || regions.length === 0) {
    return (
      <span class="thumb-stack">
        <img src={ui.url(`/api/v1/images/${check.imageSha}`)} alt={check.name} loading="lazy" />
      </span>
    );
  }
  const box = cropBox(regions, size);
  const shot = (sha: string, label: string, marks: boolean) => (
    <span class="crop-pane">
      <svg
        class="crop"
        viewBox={`${box.x} ${box.y} ${box.width} ${box.height}`}
        preserveAspectRatio="xMidYMid meet"
        role="img"
        aria-label={`${label}: ${check.name}`}
      >
        <image href={ui.url(`/api/v1/images/${sha}`)} x="0" y="0" width={size.width} height={size.height} />
        {marks &&
          regions.map((r) => (
            <rect
              class="crop-change"
              x={r.x}
              y={r.y}
              width={r.width}
              height={r.height}
              vector-effect="non-scaling-stroke"
            />
          ))}
      </svg>
      <span class="crop-label">{label}</span>
    </span>
  );
  return (
    <span class="group-crop">
      {shot(check.baseline.imageSha, 'Before', false)}
      {shot(check.imageSha, 'After', true)}
    </span>
  );
}

/** A group card's status, as a check card's: unresolved while one of its checks waits. */
function groupStatus(members: CheckView[]): string {
  const statuses = members.map(cardStatus);
  for (const status of ['unresolved', 'error', 'rejected']) if (statuses.includes(status)) return status;
  return statuses.every((s) => s === 'outdated') ? 'outdated' : 'resolved';
}

/** `home, cart, account +4`: the screens of a group by name, each once. */
function namesOf(members: CheckView[]): string {
  const names = [...new Set(members.map((m) => m.name))];
  return names.length > 3 ? `${names.slice(0, 3).join(', ')} +${names.length - 3}` : names.join(', ');
}

/**
 * The checks of a change group this page shows, as one stacked card: the shared change before and
 * after, the screens (unfold to list them) and, for reviewers, Approve all and Reject all, in
 * place. Focused (Tab or a click), A and R review the whole group and U undoes it (live island).
 */
function GroupCard(props: {
  ui: Ui;
  build: BuildView;
  group: ChangeGroup | undefined;
  members: CheckView[];
  sizes: Map<string, Size>;
  filter: CheckFilter;
  canReview: boolean;
  flaky: Map<string, FlakySignal>;
}) {
  const { ui, build, members, filter } = props;
  const first = members[0] as CheckView;
  const groupId = first.groupId as string;
  const status = groupStatus(members);
  const pending = members.filter((m) => m.review === 'pending').length;
  const suggested = members.filter((m) => m.suggestion);
  const suggestions = new Set(suggested.map((m) => m.suggestion?.action));
  const size = props.group?.size ?? members.length;
  const byName = new Map<string, CheckView[]>();
  for (const m of members) byName.set(m.name, [...(byName.get(m.name) ?? []), m]);
  const title =
    byName.size === 1 ? `Same change in ${members.length} variants` : `Same change on ${members.length} screens`;
  const api = `/builds/${build.id}/groups/${groupId}`;
  const hidden = (
    <>
      <input type="hidden" name="filter" value={filter.key} />
      <input type="hidden" name="back" value="build" />
      {members.map((m) => (
        <input type="hidden" name="checkIds" value={m.id} />
      ))}
    </>
  );
  // Reject all asks why first, in the same popover as a single check; the reason goes on every member.
  const reject = (
    <RejectMenu
      action={ui.url(`/ui/builds/${build.id}/groups/${groupId}/reject`)}
      label="Reject all"
      small
      title={`Reject the ${pending} screens of this group that wait for review, with why (R when the card is focused; Shift+R without a reason)`}
      formAttrs={{
        class: 'reject-popover group-action',
        'data-inplace': `${api}/reject`,
        'data-inplace-done': 'Rejected the same change on {n} screens',
        'data-inplace-undo': `${api}/reset`,
        'data-inplace-tone': 'danger',
        'data-group-action': 'reject',
      }}
    >
      {hidden}
    </RejectMenu>
  );
  const action = (kind: 'approve' | 'reject') => (
    <form
      class="group-action"
      method="post"
      action={ui.url(`/ui/builds/${build.id}/groups/${groupId}/${kind}`)}
      data-inplace={`${api}/${kind}`}
      data-inplace-done={`${kind === 'approve' ? 'Approved' : 'Rejected'} the same change on {n} screens`}
      data-inplace-undo={`${api}/reset`}
      data-inplace-tone={kind === 'reject' ? 'danger' : undefined}
      data-group-action={kind}
    >
      <input type="hidden" name="filter" value={filter.key} />
      <input type="hidden" name="back" value="build" />
      {members.map((m) => (
        <input type="hidden" name="checkIds" value={m.id} />
      ))}
      <button
        type="submit"
        class={`small ${kind}`}
        title={
          kind === 'approve'
            ? `Approve the ${pending} screens of this group that wait for review (A when the card is focused)`
            : `Reject the ${pending} screens of this group that wait for review (R when the card is focused)`
        }
      >
        {kind === 'approve' ? `Approve all ${pending}` : 'Reject all'}
      </button>
    </form>
  );
  return (
    <article
      class={props.canReview ? 'check-card-wrap group-card-wrap reviewable' : 'check-card-wrap group-card-wrap'}
      id={`group-${groupId}`}
      tabindex={0}
      data-group-card={groupId}
      aria-label={`${title}: ${namesOf(members)}`}
      data-search={members
        .flatMap((m) => [m.name, ...Object.values(m.variant)])
        .join(' ')
        .toLowerCase()}
    >
      <div class={`check-card group-card card-${status}`}>
        <a class="thumb" href={ui.url(`/ui/checks/${first.id}?filter=${filter.key}`)} title="Open the first screen">
          <GroupCrop ui={ui} check={first} size={props.sizes.get(first.imageSha)} />
        </a>
        <div class="check-card-body">
          <span class="check-name" title={size > members.length ? `${size} screens in this build` : undefined}>
            {title}
          </span>
          <span class="group-names muted" title={members.map((m) => m.name).join(', ')}>
            {namesOf(members)}
          </span>
          <span class="card-status">
            <span class="card-state">{status}</span>
            {pending > 0 && pending < members.length && (
              <span class="diff-pct">{`${pending} of ${members.length} wait`}</span>
            )}
            {suggested.length > 0 && (
              <span
                class="badge-agent"
                title={`An agent suggests a decision on ${suggested.length} of these screens: open one to accept or dismiss it`}
              >
                {suggestions.size === 1 ? `agent: ${[...suggestions][0]}` : 'agent: mixed'}
                {suggested.length < members.length ? ` ${suggested.length}` : ''}
              </span>
            )}
          </span>
          <details class="group-members">
            <summary>
              Screens <span class="count">{byName.size}</span>
            </summary>
            {/* A line per screen, with a link per variant in the colour of its status. */}
            <ul>
              {[...byName].map(([name, checks]) => (
                <li>
                  <span class="member-name">{name}</span>
                  {checks.map((m) => (
                    <a
                      class="member-check"
                      href={ui.url(`/ui/checks/${m.id}?filter=${filter.key}`)}
                      title={`${m.name} ${Object.values(m.variant).join(' ')}: ${cardTitle(m)}`}
                    >
                      <span class={`member-state state-${cardStatus(m)}`}>{cardStatus(m)}</span>
                      {Object.values(m.variant).join(' ').replaceAll('_', ' ') || 'no variant'}
                      <FlakyBadge flaky={props.flaky.get(m.snapshotKey)} />
                    </a>
                  ))}
                </li>
              ))}
            </ul>
          </details>
        </div>
        {props.canReview && (
          <div class="group-actions">
            {pending > 0 ? (
              <>
                {reject}
                {action('approve')}
              </>
            ) : (
              <span class="muted">{status === 'resolved' ? 'All approved' : 'Nothing waits'}</span>
            )}
          </div>
        )}
      </div>
    </article>
  );
}

type GridItem = { kind: 'check'; check: CheckView } | { kind: 'group'; members: CheckView[] };

/**
 * The grid in the page's order (newest first): checks of one change group that this page shows
 * (two or more, after filters and tags) become one card where the newest of them is.
 */
function gridItems(checks: CheckView[]): GridItem[] {
  const listed = new Map<string, CheckView[]>();
  for (const c of checks) if (c.groupId) listed.set(c.groupId, [...(listed.get(c.groupId) ?? []), c]);
  const items: GridItem[] = [];
  for (const check of checks) {
    const members = check.groupId ? listed.get(check.groupId) : undefined;
    if (!members || members.length < 2) items.push({ kind: 'check', check });
    else if (members[0] === check) items.push({ kind: 'group', members });
  }
  return items;
}

/** A tag picked in `?tag=key:value` (repeatable). */
interface PickedTag {
  key: string;
  value: string;
}

/** `?tag=device:pixel_7&tag=os:ios_17` → the picked tags; malformed ones are skipped. */
function tagsFromQuery(values: string[] | undefined): PickedTag[] {
  return (values ?? []).slice(0, 20).flatMap((raw) => {
    const at = raw.indexOf(':');
    return at > 0 && at < raw.length - 1 ? [{ key: raw.slice(0, at), value: raw.slice(at + 1) }] : [];
  });
}

const tagQuery = (tags: PickedTag[]) => tags.map((t) => `&tag=${encodeURIComponent(`${t.key}:${t.value}`)}`).join('');

const sameTag = (a: PickedTag, b: PickedTag) => a.key === b.key && a.value === b.value;

/**
 * The build's variant values as chips with their counts: a chip turns its tag on or off (values of
 * one key add up, keys narrow), Clear drops them all. Links, so it works without JavaScript.
 */
function TagFilter(props: { ui: Ui; build: BuildView; base: string; tags: VariantTag[]; picked: PickedTag[] }) {
  const { ui, build, base, tags, picked } = props;
  if (tags.length === 0) return null;
  const href = (next: PickedTag[]) => ui.url(`/ui/builds/${build.id}?${base}${tagQuery(next)}`);
  return (
    <nav class="tag-filter" aria-label="Filter by tag" data-live="tags">
      {tags.map((tag) => {
        const on = picked.some((p) => sameTag(p, tag));
        const next = on ? picked.filter((p) => !sameTag(p, tag)) : [...picked, { key: tag.key, value: tag.value }];
        return (
          <a
            class={on ? 'tag-chip on' : 'tag-chip'}
            href={href(next)}
            aria-current={on ? 'true' : undefined}
            title={`${tag.key}: ${tag.value}`}
          >
            {tag.value.replaceAll('_', ' ')} <span class="count">{tag.count}</span>
          </a>
        );
      })}
      {picked.length > 0 && (
        <a class="tag-clear" href={href([])}>
          Clear
        </a>
      )}
    </nav>
  );
}

/** A check mark in a circle with a few sparkles: shown when nothing is left to review. */
function AllDoneArt() {
  return (
    <svg class="all-done-art" viewBox="0 0 120 120" aria-hidden="true">
      <circle class="all-done-halo" cx="60" cy="62" r="40" />
      <circle class="all-done-disc" cx="60" cy="62" r="30" />
      <path class="all-done-tick" d="M46 62l10 10 19-21" />
      <path class="all-done-spark" d="M20 24v10M15 29h10M100 16v8M96 20h8M104 86v10M99 91h10" />
    </svg>
  );
}

const EMPTY_FILTER: Record<string, string> = {
  changed: 'No changed checks',
  new: 'No new checks',
  error: 'No errors',
  unchanged: 'No unchanged checks',
  rejected: 'No rejected checks',
};

/** What an empty grid says: celebrate a reviewed build, otherwise name what is missing. */
function EmptyChecks(props: { ui: Ui; build: BuildView; filter: CheckFilter }) {
  const { ui, build, filter } = props;
  const total = build.counts.total;
  const all = ui.url(`/ui/builds/${build.id}?filter=all`);
  const showAll = total > 0 && (
    <a class="button" href={all}>
      {total === 1 ? 'Show the check' : `Show all ${total} checks`}
    </a>
  );
  if (total === 0) {
    return (
      <div class="empty">
        <h3>No checks yet</h3>
        <p class="muted">Screenshots appear here as the test run posts them.</p>
      </div>
    );
  }
  if (filter.key === 'pending') {
    const nothingChanged = build.counts.result.changed + build.counts.result.new + build.counts.result.error === 0;
    return (
      <div class="empty all-done">
        <AllDoneArt />
        <h3>{nothingChanged ? 'No changes' : 'Nothing to review'}</h3>
        <p class="muted">
          {nothingChanged
            ? 'Every screenshot matches its baseline.'
            : `Every check in build #${build.number} is decided. Nice work.`}
        </p>
        {showAll}
      </div>
    );
  }
  return (
    <div class="empty">
      <h3>{`${EMPTY_FILTER[filter.key] ?? 'No checks'} in this build`}</h3>
      {showAll}
    </div>
  );
}

function BuildPage(props: {
  ui: Ui;
  project: Project;
  build: BuildView;
  checks: CheckView[];
  groups: Map<string, ChangeGroup>;
  flaky: Map<string, FlakySignal>;
  sizes: Map<string, Size>;
  filter: CheckFilter;
  firstPending: string | null;
  canReview: boolean;
  canAdmin: boolean;
  /** The search, empty when none. */
  q: string;
  /** The build's variant tags, and those picked in the address. */
  tags: VariantTag[];
  picked: PickedTag[];
  older?: string | undefined;
  notice?: string | undefined;
}) {
  const { ui, project, build, checks, filter, q, picked } = props;
  const narrowed = q !== '' || picked.length > 0;
  const search = (q ? `&q=${encodeURIComponent(q)}` : '') + tagQuery(picked);
  const pending = build.counts.review.pending;
  // An open build still receives checks; the live island refreshes the header, chips and grid.
  const open = build.state === 'open';
  return (
    <Layout
      ui={ui}
      title={`Build #${build.number}`}
      notice={props.notice}
      crumbs={[
        { label: project.name, href: ui.url(`/ui/p/${project.slug}`) },
        {
          label: build.branch,
          href: ui.url(`/ui/p/${project.slug}/builds?branch=${encodeURIComponent(build.branch)}`),
        },
        { label: `#${build.number}` },
      ]}
      project={project.slug}
      canManage={props.canAdmin}
      islands={['search', 'live', 'thumbs']}
    >
      {/* Running: every 5 s. Finalized: still watched (10 s), so reviews by others show up. */}
      <div
        class="page-head"
        data-live="build-head"
        data-live-open={open ? '' : undefined}
        data-live-watch={open ? undefined : ''}
      >
        <div>
          <div class="title-row">
            <h1>{`Build #${build.number}`}</h1>
            <BuildStatus build={build} />
          </div>
          <p class="sub meta-line">
            <span class="mono">{build.branch}</span>
            {build.branch !== build.baseBranch && <span class="muted">vs {build.baseBranch}</span>}
            {build.commitSha && <span class="mono">{build.commitSha.slice(0, 7)}</span>}
            {build.pullRequest !== null && (
              <span title={build.repository ? `Pull (merge) request in ${build.repository}` : 'Pull (merge) request'}>
                {`PR #${build.pullRequest}`}
              </span>
            )}
            {build.externalId && <span>{build.externalId}</span>}
            <Ago at={build.createdAt} />
            <span>{countsText(build.counts)}</span>
            <BuildTime timing={build.timing} />
            {open && build.parallelTotal !== null && (
              <span title="A parallel build: each CI job finalizes its part; the last one closes the build">
                {`${build.partsFinished} of ${build.parallelTotal} parts finished`}
              </span>
            )}
          </p>
        </div>
        <div class="page-actions">
          {props.canAdmin && open && (
            <form method="post" action={ui.url(`/ui/builds/${build.id}/finalize`)}>
              <button
                type="submit"
                data-confirm={`Finalize build #${build.number} now? It takes no more checks, also from CI jobs still running.`}
                data-confirm-label="Finalize"
              >
                Finalize
              </button>
            </form>
          )}
          {props.canReview && pending > 0 && (
            <form method="post" action={ui.url(`/ui/builds/${build.id}/approve`)}>
              <button
                type="submit"
                data-confirm={`Approve all ${pending} checks waiting for review? Their screenshots become the baselines on ${build.branch}.`}
                data-confirm-label="Approve all"
              >
                {`Approve all ${pending}`}
              </button>
            </form>
          )}
          {props.firstPending && (
            <a
              class="button primary"
              href={ui.url(`/ui/checks/${props.firstPending}?filter=pending`)}
              data-palette-review
            >
              Start review
            </a>
          )}
        </div>
      </div>
      <div class="build-tools">
        <nav class="chips" aria-label="Filter checks" data-live="chips">
          {CHECK_FILTERS.map((f) => {
            const count = countFor(f, build.counts);
            if (count === 0 && f.key !== 'all' && f.key !== filter.key) return null;
            return (
              <a
                href={ui.url(`/ui/builds/${build.id}?filter=${f.key}${search}`)}
                aria-current={f.key === filter.key ? 'page' : undefined}
              >
                {f.label} <span class="count">{count}</span>
              </a>
            );
          })}
        </nav>
        {/* Newest first; the search island narrows the grid as you type, the form searches without it. */}
        <form class="check-search" method="get" action={ui.url(`/ui/builds/${build.id}`)}>
          <input type="hidden" name="filter" value={filter.key} />
          {picked.map((t) => (
            <input type="hidden" name="tag" value={`${t.key}:${t.value}`} />
          ))}
          <input
            type="search"
            name="q"
            value={q}
            placeholder="Search screenshots"
            aria-label="Search screenshots by name or variant"
            maxlength={200}
            data-check-search
          />
        </form>
      </div>
      <TagFilter
        ui={ui}
        build={build}
        base={`filter=${filter.key}${q ? `&q=${encodeURIComponent(q)}` : ''}`}
        tags={props.tags}
        picked={picked}
      />
      <div data-live="checks">
        {/* The search island shows this when typing hides every card. */}
        <div class="empty" data-search-empty hidden={!(narrowed && checks.length === 0)}>
          <h3>No checks match this search.</h3>
        </div>
        {checks.length === 0 && !narrowed && <EmptyChecks ui={ui} build={build} filter={filter} />}
        {checks.length > 0 && (
          <div class="check-grid">
            {gridItems(checks).map((item) =>
              item.kind === 'group' ? (
                <GroupCard
                  ui={ui}
                  build={build}
                  group={props.groups.get(item.members[0]?.groupId ?? '')}
                  members={item.members}
                  sizes={props.sizes}
                  filter={filter}
                  canReview={props.canReview}
                  flaky={props.flaky}
                />
              ) : (
                <CheckCard
                  ui={ui}
                  check={item.check}
                  size={props.sizes.get(
                    item.check.result === 'changed' ? item.check.imageSha : thumbnailSha(item.check),
                  )}
                  filter={filter}
                  canReview={props.canReview}
                  flaky={props.flaky.get(item.check.snapshotKey)}
                />
              ),
            )}
          </div>
        )}
      </div>
      {props.older && (
        <div class="pager">
          <span />
          <a href={props.older}>More checks →</a>
        </div>
      )}
    </Layout>
  );
}

export function registerBuildPages(app: OpenAPIHono<AppEnv>, s: Services): void {
  app.get('/ui/builds/:id', async (c) => {
    const ui = uiOf(c, s);
    const id = c.req.param('id');
    const { access } = await visibleBuild(c, s.deps, id, 'project.read');
    const build = await getBuild(s.deps, id);
    const project = await getProjectById(s.deps, build.projectId);
    const filter = filterFromQuery({
      filter: c.req.query('filter'),
      result: c.req.query('result'),
      review: c.req.query('review'),
    });
    const cursor = c.req.query('cursor') || undefined;
    const q = (c.req.query('q') ?? '').trim().slice(0, 200);
    const picked = tagsFromQuery(c.req.queries('tag'));
    const [page, firstPending, tags, groups] = await Promise.all([
      listChecks(s.deps, id, {
        result: filter.result,
        review: filter.review,
        status: filter.status,
        q,
        tags: picked,
        order: 'desc',
        cursor,
        limit: 200,
      }),
      firstPendingCheckId(s.deps, id),
      variantTags(s.deps, id),
      listGroups(s.deps, id),
    ]);
    const histories = await screenHistories(
      s.deps,
      build.projectId,
      page.items.map((c) => c.snapshotKey),
      build.branch,
    );
    const flaky = new Map(histories.flatMap((h) => (h.flaky ? [[h.snapshotKey, h.flaky] as const] : [])));
    const sizes = await imageSizes(
      s.deps,
      page.items.flatMap((c) => [thumbnailSha(c), c.imageSha]),
    );
    const search = (q ? `&q=${encodeURIComponent(q)}` : '') + tagQuery(picked);
    const older = page.nextCursor
      ? ui.url(`/ui/builds/${id}?filter=${filter.key}${search}&cursor=${encodeURIComponent(page.nextCursor)}`)
      : undefined;
    return c.html(
      <BuildPage
        ui={ui}
        project={project}
        build={build}
        checks={page.items}
        groups={new Map(groups.map((g) => [g.id, g]))}
        flaky={flaky}
        sizes={sizes}
        filter={filter}
        firstPending={firstPending}
        canReview={access.can('check.review')}
        canAdmin={access.can('project.admin')}
        q={q}
        tags={tags}
        picked={picked}
        older={older}
        notice={noticeOf(c)}
      />,
    );
  });

  app.post('/ui/builds/:id/finalize', async (c) => {
    const ui = uiOf(c, s);
    const id = c.req.param('id');
    await visibleBuild(c, s.deps, id, 'project.admin');
    await finalizeBuild(s.deps, id);
    return c.redirect(ui.url(`/ui/builds/${id}?done=finalized`), 303);
  });

  // Approve all and Reject all on a group card, without JavaScript (with it, they post in place).
  for (const action of ['approve', 'reject'] as const) {
    app.post(`/ui/builds/:id/groups/:groupId/${action}`, async (c) => {
      const ui = uiOf(c, s);
      const user = userOf(c);
      const id = c.req.param('id');
      await visibleBuild(c, s.deps, id, 'check.review');
      const groupId = c.req.param('groupId');
      const form = await c.req.parseBody({ all: true });
      const checkIds = ([] as unknown[]).concat(form.checkIds ?? []).filter((v): v is string => typeof v === 'string');
      const why = reasonInput(form, action === 'reject');
      await reviewGroup(s.deps, id, groupId, action, user.id, { ...why, ...(checkIds.length > 0 ? { checkIds } : {}) });
      const filter = filterFromQuery({ filter: field(form, 'filter') });
      const done = action === 'approve' ? 'approved' : 'rejected';
      // From the check page: on to the next check waiting for review.
      if (field(form, 'back') === 'check') {
        const next = await firstPendingCheckId(s.deps, id);
        return c.redirect(
          ui.url(next ? `/ui/checks/${next}?filter=${filter.key}&done=${done}` : `/ui/builds/${id}?done=${done}`),
          303,
        );
      }
      return c.redirect(ui.url(`/ui/builds/${id}?filter=${filter.key}&done=${done}#group-${groupId}`), 303);
    });
  }

  app.post('/ui/builds/:id/approve', async (c) => {
    const ui = uiOf(c, s);
    const user = userOf(c);
    const id = c.req.param('id');
    await visibleBuild(c, s.deps, id, 'check.review');
    await approveBuild(s.deps, id, user.id);
    return c.redirect(ui.url(`/ui/builds/${id}?done=approved-all`), 303);
  });
}
