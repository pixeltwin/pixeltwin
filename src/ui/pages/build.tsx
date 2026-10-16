import type { OpenAPIHono } from '@hono/zod-openapi';
import type { Project } from '../../db/schema';
import type { Size } from '../../diff/types';
import { hasPermission } from '../../domain/auth/policy';
import { type BuildView, getBuild } from '../../domain/builds';
import { type CheckView, firstPendingCheckId, listChecks } from '../../domain/checks';
import { imageSizes } from '../../domain/images';
import { getProjectById } from '../../domain/projects';
import { approveBuild } from '../../domain/reviews';
import { AppError } from '../../errors';
import type { AppEnv, Services } from '../../http/env';
import { Ago, BuildStatus, CheckStatus, countsText, thumbnailSha, Variant } from '../components';
import { noticeOf, type Ui, uiOf, userOf } from '../context';
import { CHECK_FILTERS, type CheckFilter, countFor, filterFromQuery } from '../filters';
import { Layout } from '../layout';

function CheckCard({ ui, check, size, filter }: { ui: Ui; check: CheckView; size?: Size; filter: CheckFilter }) {
  const sha = thumbnailSha(check);
  return (
    <a
      class="check-card"
      href={ui.url(`/ui/checks/${check.id}?filter=${filter.key}`)}
      data-search={[check.name, ...Object.values(check.variant)].join(' ').toLowerCase()}
    >
      <div class="thumb">
        <img
          src={ui.url(`/api/v1/images/${sha}`)}
          alt={check.name}
          loading="lazy"
          width={size?.width}
          height={size?.height}
        />
      </div>
      <div class="check-card-body">
        <span class="check-name">{check.name}</span>
        <Variant variant={check.variant} />
        <CheckStatus check={check} />
      </div>
    </a>
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
  /** The search, empty when none. */
  q: string;
  older?: string | undefined;
  notice?: string | undefined;
}) {
  const { ui, project, build, checks, filter, q } = props;
  const search = q ? `&q=${encodeURIComponent(q)}` : '';
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
      islands={['search', 'live']}
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
          </p>
        </div>
        <div class="page-actions">
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
      <div data-live="checks">
        <div class="empty" data-search-empty hidden={checks.length > 0}>
          <h3>{q ? 'No checks match this search.' : 'No checks match this filter.'}</h3>
        </div>
        {checks.length > 0 && (
          <div class="check-grid">
            {checks.map((check) => (
              <CheckCard ui={ui} check={check} size={props.sizes.get(thumbnailSha(check))} filter={filter} />
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
    const build = await getBuild(s.deps, id);
    const project = await getProjectById(s.deps, build.projectId);
    const filter = filterFromQuery({
      filter: c.req.query('filter'),
      result: c.req.query('result'),
      review: c.req.query('review'),
    });
    const cursor = c.req.query('cursor') || undefined;
    const q = (c.req.query('q') ?? '').trim().slice(0, 200);
    const [page, firstPending] = await Promise.all([
      listChecks(s.deps, id, { result: filter.result, review: filter.review, q, order: 'desc', cursor, limit: 200 }),
      firstPendingCheckId(s.deps, id),
    ]);
    const sizes = await imageSizes(s.deps, page.items.map(thumbnailSha));
    const search = q ? `&q=${encodeURIComponent(q)}` : '';
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
        canReview={hasPermission(userOf(c), 'check.review')}
        q={q}
        older={older}
        notice={noticeOf(c)}
      />,
    );
  });

  app.post('/ui/builds/:id/approve', async (c) => {
    const ui = uiOf(c, s);
    const user = userOf(c);
    if (!hasPermission(user, 'check.review')) {
      throw new AppError('forbidden', 403, 'Only admins and reviewers can approve.');
    }
    const id = c.req.param('id');
    await approveBuild(s.deps, id, user.id);
    return c.redirect(ui.url(`/ui/builds/${id}?done=approved-all`), 303);
  });
}
