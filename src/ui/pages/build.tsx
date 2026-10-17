import type { OpenAPIHono } from '@hono/zod-openapi';
import type { Project } from '../../db/schema';
import type { Size } from '../../diff/types';
import { type BuildView, finalizeBuild, getBuild } from '../../domain/builds';
import { type CheckView, firstPendingCheckId, listChecks, type VariantTag, variantTags } from '../../domain/checks';
import { imageSizes } from '../../domain/images';
import { getProjectById } from '../../domain/projects';
import { approveBuild } from '../../domain/reviews';
import { visibleBuild } from '../../http/access';
import type { AppEnv, Services } from '../../http/env';
import { Ago, BuildStatus, BuildTime, cardStatus, countsText, statusText, thumbnailSha, Variant } from '../components';
import { noticeOf, type Ui, uiOf, userOf } from '../context';
import { CHECK_FILTERS, type CheckFilter, countFor, filterFromQuery } from '../filters';
import { Layout } from '../layout';

/**
 * One check: a link to it, and for reviewers an Approve button on a new screenshot waiting for
 * review (nothing to compare it with, so the thumbnail is enough). The form sits beside the link.
 */
function CheckCard(props: { ui: Ui; check: CheckView; size?: Size; filter: CheckFilter; canReview: boolean }) {
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
        title={statusText(check)}
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
            {check.result === 'changed' && check.review !== 'rejected' && diff && (
              <span class="diff-pct" title="Pixels changed">{`${diff.percent}%`}</span>
            )}
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
            {checks.map((check) => (
              <CheckCard
                ui={ui}
                check={check}
                size={props.sizes.get(check.result === 'changed' ? check.imageSha : thumbnailSha(check))}
                filter={filter}
                canReview={props.canReview}
              />
            ))}
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
    const [page, firstPending, tags] = await Promise.all([
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
    ]);
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

  app.post('/ui/builds/:id/approve', async (c) => {
    const ui = uiOf(c, s);
    const user = userOf(c);
    const id = c.req.param('id');
    await visibleBuild(c, s.deps, id, 'check.review');
    await approveBuild(s.deps, id, user.id);
    return c.redirect(ui.url(`/ui/builds/${id}?done=approved-all`), 303);
  });
}
