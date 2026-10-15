import type { OpenAPIHono } from '@hono/zod-openapi';
import type { Project } from '../../db/schema';
import type { DiffData, DiffErrorData, Size } from '../../diff/types';
import { hasPermission } from '../../domain/auth/policy';
import { type CheckNeighbors, type CheckView, checkNeighbors, getCheck } from '../../domain/checks';
import { imageSizes } from '../../domain/images';
import { getProjectById } from '../../domain/projects';
import { approveCheck, rejectCheck } from '../../domain/reviews';
import { AppError } from '../../errors';
import type { AppEnv, Services } from '../../http/env';
import { Badge, Variant, When } from '../components';
import { field, noticeOf, type Ui, uiOf, userOf } from '../context';
import { Layout } from '../layout';

type View = 'side' | 'diff';

function isDiffData(diff: CheckView['diff']): diff is DiffData {
  return diff !== null && !('error' in diff);
}

function Shot({
  ui,
  sha,
  alt,
  size,
  regions,
}: {
  ui: Ui;
  sha: string;
  alt: string;
  size?: Size | undefined;
  regions?: DiffData['regions'];
}) {
  return (
    <div class="shot">
      <img src={ui.url(`/api/v1/images/${sha}`)} alt={alt} width={size?.width} height={size?.height} />
      {size && regions && regions.length > 0 && (
        // Region boxes as SVG attributes: the CSP forbids inline styles.
        <svg viewBox={`0 0 ${size.width} ${size.height}`} preserveAspectRatio="none" aria-hidden="true">
          {regions.map((r) => (
            <rect x={r.x} y={r.y} width={r.width} height={r.height} />
          ))}
        </svg>
      )}
    </div>
  );
}

function CheckPage(props: {
  ui: Ui;
  project: Project;
  check: CheckView;
  view: View;
  sizes: Map<string, Size>;
  nav: CheckNeighbors;
  canReview: boolean;
  notice?: string | undefined;
  error?: string | undefined;
}) {
  const { ui, project, check, view, sizes, nav } = props;
  const diff = isDiffData(check.diff) ? check.diff : null;
  const diffError = check.diff && !isDiffData(check.diff) ? (check.diff as DiffErrorData).error : null;
  const reviewable = props.canReview && (check.review === 'pending' || check.review === 'rejected');
  const here = (v: View) => ui.url(`/ui/checks/${check.id}?view=${v}`);

  return (
    <Layout ui={ui} title={check.name} notice={props.notice} error={props.error}>
      <p class="muted">
        <a href={ui.url(`/ui/p/${project.slug}`)}>{project.name}</a>
        {' / '}
        <a href={ui.url(`/ui/builds/${check.buildId}`)}>build</a>
        {nav.previous && (
          <>
            {' · '}
            <a href={ui.url(`/ui/checks/${nav.previous}`)} data-key="k">
              ← previous <kbd>k</kbd>
            </a>
          </>
        )}
        {nav.next && (
          <>
            {' · '}
            <a href={ui.url(`/ui/checks/${nav.next}`)} data-key="j">
              next <kbd>j</kbd> →
            </a>
          </>
        )}
      </p>
      <h1>
        {`${check.name} `}
        <Badge value={check.result} /> {check.review !== 'none' && <Badge value={check.review} />}
      </h1>
      <p class="sub">
        <Variant variant={check.variant} />
      </p>

      <div class="layout">
        <section>
          {check.baseline && check.diffImageSha && (
            <nav class="tabs">
              <a class={view === 'diff' ? 'current' : ''} href={here('diff')}>
                Diff
              </a>
              <a class={view === 'side' ? 'current' : ''} href={here('side')}>
                Side by side
              </a>
            </nav>
          )}
          {view === 'diff' && check.diffImageSha && diff ? (
            <figure class="diffview">
              <figcaption>Changed pixels in red, regions outlined</figcaption>
              <Shot
                ui={ui}
                sha={check.diffImageSha}
                alt="diff"
                size={sizes.get(check.diffImageSha)}
                regions={diff.regions}
              />
            </figure>
          ) : check.baseline ? (
            <div class="compare">
              <figure>
                <figcaption>{`Baseline (${check.baseline.branch})`}</figcaption>
                <Shot ui={ui} sha={check.baseline.imageSha} alt="baseline" size={sizes.get(check.baseline.imageSha)} />
              </figure>
              <figure>
                <figcaption>This build</figcaption>
                <Shot ui={ui} sha={check.imageSha} alt="current" size={sizes.get(check.imageSha)} />
              </figure>
            </div>
          ) : (
            <figure class="diffview">
              <figcaption>New snapshot: no baseline yet. Approve to make it the baseline.</figcaption>
              <Shot ui={ui} sha={check.imageSha} alt="current" size={sizes.get(check.imageSha)} />
            </figure>
          )}
        </section>

        <aside class="panel">
          <dl>
            <dt>Summary</dt>
            <dd>{diff?.summary ?? diffError?.message ?? 'New snapshot.'}</dd>
            {diff && (
              <>
                <dt>Changed</dt>
                <dd>{`${diff.pixels} px (${diff.percent}%), ${diff.regions.length}${diff.regionsTruncated ? '+' : ''} region${diff.regions.length === 1 && !diff.regionsTruncated ? '' : 's'}`}</dd>
              </>
            )}
            <dt>Baseline</dt>
            <dd>
              {check.baseline
                ? `${check.baseline.branch}${check.baseline.fallback ? ' (fallback from base branch)' : ''}`
                : 'none'}
            </dd>
            <dt>Thresholds</dt>
            <dd>{`colour ${check.colorThreshold}, tolerance ${check.tolerancePercent}%`}</dd>
            {check.reviewedAt !== null && (
              <>
                <dt>Reviewed</dt>
                <dd>
                  <When at={check.reviewedAt} />
                  {check.reviewComment && <div>{`“${check.reviewComment}”`}</div>}
                </dd>
              </>
            )}
          </dl>
          {reviewable && (
            <div class="actions">
              <form class="stack" method="post" action={ui.url(`/ui/checks/${check.id}/approve`)} data-key="a">
                <button class="approve" type="submit">
                  Approve <kbd>a</kbd>
                </button>
              </form>
              <form class="stack" method="post" action={ui.url(`/ui/checks/${check.id}/reject`)} data-key="r">
                <textarea name="comment" rows={2} maxlength={1000} placeholder="Optional comment" />
                <button class="reject" type="submit">
                  Reject <kbd>r</kbd>
                </button>
              </form>
            </div>
          )}
          {nav.nextPending && (
            <p>
              <a href={ui.url(`/ui/checks/${nav.nextPending}`)}>Next to review →</a>
            </p>
          )}
        </aside>
      </div>
    </Layout>
  );
}

export function registerCheckPages(app: OpenAPIHono<AppEnv>, s: Services): void {
  app.get('/ui/checks/:id', async (c) => {
    const ui = uiOf(c, s);
    const check = await getCheck(s.deps, c.req.param('id'));
    const [project, nav, sizes] = await Promise.all([
      getProjectById(s.deps, check.projectId),
      checkNeighbors(s.deps, check),
      imageSizes(
        s.deps,
        [check.imageSha, check.baseline?.imageSha, check.diffImageSha].filter((x): x is string => !!x),
      ),
    ]);
    const asked = c.req.query('view');
    const view: View = asked === 'side' || asked === 'diff' ? asked : check.result === 'changed' ? 'diff' : 'side';
    const canReview = hasPermission(userOf(c), 'check.review');
    return c.html(
      <CheckPage
        ui={ui}
        project={project}
        check={check}
        view={view}
        sizes={sizes}
        nav={nav}
        canReview={canReview}
        notice={noticeOf(c)}
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
      const id = c.req.param('id');
      const review = action === 'approve' ? approveCheck : rejectCheck;
      const check = await review(s.deps, id, user.id, comment ? { comment } : {});
      // Keep the reviewer moving: the next check awaiting review, else back to the build.
      const { nextPending } = await checkNeighbors(s.deps, check);
      const done = action === 'approve' ? 'approved' : 'rejected';
      return c.redirect(
        ui.url(nextPending ? `/ui/checks/${nextPending}?done=${done}` : `/ui/builds/${check.buildId}?done=${done}`),
        303,
      );
    });
  }
}
