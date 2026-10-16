import type { OpenAPIHono } from '@hono/zod-openapi';
import type { Child } from 'hono/jsx';
import type { Project } from '../../db/schema';
import { positionOf } from '../../diff/summary';
import type { DiffData, DiffErrorData, Region, Size } from '../../diff/types';
import { hasPermission } from '../../domain/auth/policy';
import { type BuildView, getBuild } from '../../domain/builds';
import { type CheckView, checkNeighbors, getCheck, listChecks } from '../../domain/checks';
import { imageSizes } from '../../domain/images';
import { getProjectById } from '../../domain/projects';
import { approveCheck, rejectCheck, resetReview } from '../../domain/reviews';
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
async function reviewerName(s: Services, id: string | null): Promise<string | null> {
  if (!id) return null;
  const user = await s.deps.db.selectFrom('users').select('email').where('id', '=', id).executeTakeFirst();
  if (user) return user.email;
  const token = await s.deps.db.selectFrom('projectTokens').select('name').where('id', '=', id).executeTakeFirst();
  return token ? `token “${token.name}”` : 'a deleted account';
}

/** A screenshot with region boxes; `soft` boxes only outline (side by side), diff boxes are filled. */
function Shot(props: {
  ui: Ui;
  sha: string;
  alt: string;
  size?: Size | undefined;
  regions?: Region[] | undefined;
  soft?: boolean;
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
        <svg
          class={props.soft ? 'soft' : undefined}
          viewBox={`0 0 ${size.width} ${size.height}`}
          preserveAspectRatio="none"
          aria-hidden="true"
        >
          {regions.map((r) => (
            <rect x={r.x} y={r.y} width={r.width} height={r.height} />
          ))}
        </svg>
      )}
    </div>
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

function Stage({ ui, check, sizes }: { ui: Ui; check: CheckView; sizes: Map<string, Size> }) {
  const diff = isDiffData(check.diff) ? check.diff : null;
  const baseline = check.baseline;
  if (!baseline) {
    return (
      <section class="stage" id="stage" data-mode="new" aria-label="New snapshot">
        <div class="panes">
          <Pane kind="current" caption="New snapshot — no baseline yet">
            <Shot ui={ui} sha={check.imageSha} alt="new snapshot" size={sizes.get(check.imageSha)} />
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
  if (check.diffImageSha) modes.push(['diff', 'Diff', '4']);
  const baseSize = sizes.get(baseline.imageSha);
  const currentSize = sizes.get(check.imageSha);
  return (
    // `all` is the no-JavaScript view: side by side, then the diff. The island switches modes.
    <section class="stage" id="stage" data-mode="all" aria-label="Comparison">
      <div class="stage-toolbar" hidden>
        <fieldset class="segmented modes">
          <legend class="visually-hidden">Compare mode</legend>
          {modes.map(([mode, label, key]) => (
            <button type="button" data-mode-button={mode} aria-pressed="false">
              {label} <kbd>{key}</kbd>
            </button>
          ))}
        </fieldset>
        <label class="onion-control" hidden>
          <span class="muted">Opacity</span>
          <input type="range" min="0" max="100" value="50" data-onion />
        </label>
        <div class="zoom-controls">
          <button type="button" class="small" data-zoom="toggle" aria-label="Toggle fit and 100% (Z)">
            <span data-zoom-label>Fit</span> <kbd>Z</kbd>
          </button>
        </div>
      </div>
      <div class="panes">
        <Pane kind="baseline" caption={`Baseline · ${baseline.branch}`}>
          <Shot ui={ui} sha={baseline.imageSha} alt="baseline" size={baseSize} regions={diff?.regions} soft />
        </Pane>
        <Pane kind="current" caption="This build">
          <Shot ui={ui} sha={check.imageSha} alt="this build" size={currentSize} regions={diff?.regions} soft />
        </Pane>
        {check.diffImageSha && (
          <Pane kind="diff" caption="Diff · changes in red">
            <Shot
              ui={ui}
              sha={check.diffImageSha}
              alt="diff"
              size={sizes.get(check.diffImageSha)}
              regions={diff?.regions}
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
            <div class="divider" aria-hidden="true" />
          </div>
        </Pane>
      </div>
    </section>
  );
}

/** “top left · ” for an area of an image of known size; empty when the size is unknown. */
function areaPlace(region: Region, size: Size | undefined): string {
  return size ? `${positionOf(region, size.width, size.height).replace('-', ' ')} · ` : '';
}

function Info(props: { check: CheckView; branch: string; reviewer: string | null; size: Size | undefined }) {
  const { check, branch, reviewer, size } = props;
  const diff = isDiffData(check.diff) ? check.diff : null;
  const diffError = check.diff && !isDiffData(check.diff) ? (check.diff as DiffErrorData).error : null;
  const dims = diff?.dimensions;
  return (
    <aside class="review-info" aria-label="About this check">
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
        {diff && diff.regions.length > 0 && (
          <>
            <dt>Changes</dt>
            <dd>{`${diff.regions.length}${diff.regionsTruncated ? '+' : ''} area${diff.regions.length === 1 && !diff.regionsTruncated ? '' : 's'}`}</dd>
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
      {diff && diff.regions.length > 0 && (
        <ul class="regions" aria-label="Changed areas">
          {diff.regions.map((r, i) => (
            <li>
              <button
                type="button"
                class="small ghost"
                data-region={`${r.x},${r.y},${r.width},${r.height}`}
                title="Zoom to this area"
              >
                <span>{`Area ${i + 1}`}</span>
                <span class="muted">{`${areaPlace(r, size)}${r.width}×${r.height} px`}</span>
              </button>
            </li>
          ))}
          {diff.regionsTruncated && <li class="muted">and more, smaller</li>}
        </ul>
      )}
      {check.reviewedAt !== null && reviewer && (
        <p class="reviewed" data-reviewed-by={reviewer}>
          {`${check.review === 'approved' ? 'Approved' : 'Rejected'} by ${reviewer} `}
          <Ago at={check.reviewedAt} />
          {check.reviewComment && <span class="comment">{`“${check.reviewComment}”`}</span>}
        </p>
      )}
    </aside>
  );
}

function ActionBar(props: { ui: Ui; check: CheckView; filter: CheckFilter; next: string | null; canReview: boolean }) {
  const { ui, check, filter, next } = props;
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
  reviewer: string | null;
  notice?: string | undefined;
}) {
  const { ui, project, build, check, filter, strip } = props;
  const at = strip.findIndex((c) => c.id === check.id);
  // When the check is outside the filter (reviewed meanwhile), its neighbours are found by order.
  const prevCheck = at >= 0 ? strip[at - 1] : strip.filter((c) => c.id < check.id).at(-1);
  const nextCheck = at >= 0 ? strip[at + 1] : strip.find((c) => c.id > check.id);
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
          <Stage ui={ui} check={check} sizes={props.sizes} />
          <Info check={check} branch={build.branch} reviewer={props.reviewer} size={props.sizes.get(check.imageSha)} />
        </div>
        <ActionBar ui={ui} check={check} filter={filter} next={next} canReview={props.canReview} />
        <Filmstrip ui={ui} checks={strip} current={check.id} filter={filter} sizes={props.sizes} />
      </div>
    </Layout>
  );
}

export function registerCheckPages(app: OpenAPIHono<AppEnv>, s: Services): void {
  app.get('/ui/checks/:id', async (c) => {
    const ui = uiOf(c, s);
    const check = await getCheck(s.deps, c.req.param('id'));
    // Focus mode walks what waits for review unless told otherwise (UI spec §5.1).
    const filter = filterFromQuery({ filter: c.req.query('filter') }, 'pending');
    const [project, build, strip, reviewer] = await Promise.all([
      getProjectById(s.deps, check.projectId),
      getBuild(s.deps, check.buildId),
      listChecks(s.deps, check.buildId, { result: filter.result, review: filter.review, limit: 200 }),
      reviewerName(s, check.reviewedBy),
    ]);
    const sizes = await imageSizes(s.deps, [
      ...[check.imageSha, check.baseline?.imageSha, check.diffImageSha].filter((x): x is string => !!x),
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
        reviewer={reviewer}
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
      const filterKey = field(form, 'filter');
      const filter = filterKey ? `filter=${filterFromQuery({ filter: filterKey }).key}&` : '';
      const id = c.req.param('id');
      const review = action === 'approve' ? approveCheck : rejectCheck;
      const check = await review(s.deps, id, user.id, comment ? { comment } : {});
      // Keep the reviewer moving: the next check awaiting review, else back to the build.
      const { nextPending } = await checkNeighbors(s.deps, check);
      const done = action === 'approve' ? 'approved' : 'rejected';
      return c.redirect(
        ui.url(
          nextPending ? `/ui/checks/${nextPending}?${filter}done=${done}` : `/ui/builds/${check.buildId}?done=${done}`,
        ),
        303,
      );
    });
  }

  app.post('/ui/checks/:id/reset', async (c) => {
    const ui = uiOf(c, s);
    if (!hasPermission(userOf(c), 'check.review')) {
      throw new AppError('forbidden', 403, 'Only admins and reviewers can review checks.');
    }
    const check = await resetReview(s.deps, c.req.param('id'));
    return c.redirect(ui.url(`/ui/checks/${check.id}?done=reset`), 303);
  });
}
