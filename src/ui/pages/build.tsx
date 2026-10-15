import type { OpenAPIHono } from '@hono/zod-openapi';
import type { Project } from '../../db/schema';
import { CHECK_RESULTS, CHECK_REVIEWS, type CheckResult, type CheckReview } from '../../db/schema';
import { hasPermission } from '../../domain/auth/policy';
import { type BuildView, getBuild } from '../../domain/builds';
import { type CheckView, listChecks } from '../../domain/checks';
import { getProjectById } from '../../domain/projects';
import { approveBuild } from '../../domain/reviews';
import { AppError } from '../../errors';
import type { AppEnv, Services } from '../../http/env';
import { Badge, Pager, Variant, When } from '../components';
import { noticeOf, type Ui, uiOf, userOf } from '../context';
import { Layout } from '../layout';

interface Filter {
  label: string;
  result?: CheckResult;
  review?: CheckReview;
}

const FILTERS: Filter[] = [
  { label: 'All' },
  { label: 'To review', review: 'pending' },
  { label: 'Changed', result: 'changed' },
  { label: 'New', result: 'new' },
  { label: 'Errors', result: 'error' },
  { label: 'Unchanged', result: 'unchanged' },
  { label: 'Rejected', review: 'rejected' },
];

function filterQuery(f: Filter): string {
  const params = new URLSearchParams();
  if (f.result) params.set('result', f.result);
  if (f.review) params.set('review', f.review);
  const q = params.toString();
  return q ? `?${q}` : '';
}

/** The thumbnail: the diff for changed checks (changes in red), otherwise the screenshot. */
function thumbnailSha(check: CheckView): string {
  return check.result === 'changed' && check.diffImageSha ? check.diffImageSha : check.imageSha;
}

function BuildPage(props: {
  ui: Ui;
  project: Project;
  build: BuildView;
  checks: CheckView[];
  active: Filter;
  canReview: boolean;
  older?: string | undefined;
  notice?: string | undefined;
}) {
  const { ui, project, build, checks, active } = props;
  return (
    <Layout ui={ui} title={`Build ${build.externalId ?? build.id.slice(-8)}`} notice={props.notice}>
      <p class="muted">
        <a href={ui.url(`/ui/p/${project.slug}`)}>{project.name}</a>
      </p>
      <h1>
        {`Build ${build.externalId ?? build.id.slice(-8)} `}
        <Badge value={build.verdict} />
      </h1>
      <p class="sub">
        {`${build.branch}${build.branch !== build.baseBranch ? ` (compared with ${build.baseBranch})` : ''} · ${build.state} · `}
        <When at={build.createdAt} />
        {build.commitSha && ` · ${build.commitSha.slice(0, 12)}`}
      </p>
      <div class="toolbar">
        <nav class="tabs">
          {FILTERS.map((f) => (
            <a
              class={f.label === active.label ? 'current' : ''}
              href={ui.url(`/ui/builds/${build.id}${filterQuery(f)}`)}
            >
              {f.label}
            </a>
          ))}
        </nav>
        {props.canReview && build.counts.review.pending > 0 && (
          <form class="inline" method="post" action={ui.url(`/ui/builds/${build.id}/approve`)}>
            <button
              class="approve"
              type="submit"
              data-confirm={`Approve all ${build.counts.review.pending} pending checks? Their screenshots become baselines on ${build.branch}.`}
            >
              {`Approve all ${build.counts.review.pending}`}
            </button>
          </form>
        )}
      </div>
      {checks.length === 0 ? (
        <p class="panel">No checks match.</p>
      ) : (
        <div class="grid">
          {checks.map((check) => (
            <a class="card" href={ui.url(`/ui/checks/${check.id}`)}>
              <img src={ui.url(`/api/v1/images/${thumbnailSha(check)}`)} alt={check.name} loading="lazy" />
              <div class="meta">
                <span class="name">{check.name}</span>
                <Variant variant={check.variant} />
                <span>
                  <Badge value={check.result} /> {check.review !== 'none' && <Badge value={check.review} />}
                </span>
              </div>
            </a>
          ))}
        </div>
      )}
      <Pager older={props.older} />
    </Layout>
  );
}

export function registerBuildPages(app: OpenAPIHono<AppEnv>, s: Services): void {
  app.get('/ui/builds/:id', async (c) => {
    const ui = uiOf(c, s);
    const id = c.req.param('id');
    const build = await getBuild(s.deps, id);
    const project = await getProjectById(s.deps, build.projectId);
    const result = CHECK_RESULTS.find((r) => r === c.req.query('result'));
    const review = CHECK_REVIEWS.find((r) => r === c.req.query('review'));
    const active = FILTERS.find((f) => f.result === result && f.review === review) ?? (FILTERS[0] as Filter);
    const cursor = c.req.query('cursor') || undefined;
    const page = await listChecks(s.deps, id, { result: active.result, review: active.review, cursor, limit: 200 });
    const older = page.nextCursor
      ? ui.url(
          `/ui/builds/${id}?${new URLSearchParams({ ...(active.result ? { result: active.result } : {}), ...(active.review ? { review: active.review } : {}), cursor: page.nextCursor })}`,
        )
      : undefined;
    return c.html(
      <BuildPage
        ui={ui}
        project={project}
        build={build}
        checks={page.items}
        active={active}
        canReview={hasPermission(userOf(c), 'check.review')}
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
