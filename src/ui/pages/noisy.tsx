import type { OpenAPIHono } from '@hono/zod-openapi';
import type { Project } from '../../db/schema';
import { positionOf } from '../../diff/summary';
import type { Rect, Size } from '../../diff/types';
import { aroundChange } from '../../domain/areas';
import { hasPermission } from '../../domain/auth/policy';
import { type HistoryEntry, noisyScreens, type ScreenHistory } from '../../domain/flaky';
import { imageSizes } from '../../domain/images';
import { getProjectBySlug } from '../../domain/projects';
import type { AppEnv, Services } from '../../http/env';
import { FlakyBadge, flakyText, HistoryStrip, ProjectTabs, Variant } from '../components';
import { noticeOf, type Ui, uiOf, userOf } from '../context';
import { Layout } from '../layout';

/** One noisy screen: its latest screenshot with the area that keeps changing, and Ignore it. */
function NoisyItem(props: {
  ui: Ui;
  screen: ScreenHistory;
  size: Size | undefined;
  canReview: boolean;
  /** The snapshot has compare areas: no ignore area can be added next to them. */
  blocked: boolean;
}) {
  const { ui, screen, size } = props;
  const latest = screen.history.at(-1) as HistoryEntry;
  const flaky = screen.flaky;
  const area: Rect | null = flaky?.unstableArea ? aroundChange(flaky.unstableArea, size) : null;
  const where = area && size ? positionOf({ ...area, pixels: 0 }, size.width, size.height).replace('-', ' ') : '';
  return (
    <article class="noisy-item" id={`noisy-${latest.checkId}`}>
      <a class="noisy-shot" href={ui.url(`/ui/checks/${latest.checkId}?filter=all`)} title="Open the latest check">
        <img
          src={ui.url(`/api/v1/images/${latest.imageSha}`)}
          alt={screen.name}
          loading="lazy"
          width={size?.width}
          height={size?.height}
        />
        {area && size && (
          <svg
            class="unstable-mark"
            viewBox={`0 0 ${size.width} ${size.height}`}
            preserveAspectRatio="none"
            aria-hidden="true"
          >
            <rect class="area area-ignore" x={area.x} y={area.y} width={area.width} height={area.height} />
          </svg>
        )}
      </a>
      <div class="noisy-body">
        <div class="noisy-title">
          <a class="check-name" href={ui.url(`/ui/checks/${latest.checkId}?filter=all`)}>
            {screen.name}
          </a>
          <Variant variant={screen.variant} />
          <span class="mono muted">{screen.branch}</span>
          <FlakyBadge flaky={flaky} />
        </div>
        {flaky && (
          <p class="muted">
            <span class="noisy-score" title="Flips per run">{`${Math.round(flaky.score * 100)}%`}</span>
            {` · ${flakyText(flaky)}`}
          </p>
        )}
        <HistoryStrip ui={ui} history={screen.history} current={latest.checkId} />
      </div>
      {props.canReview && area && (
        <form
          class="noisy-action"
          method="post"
          action={ui.url(`/ui/checks/${latest.checkId}/areas`)}
          data-inplace={`/checks/${latest.checkId}/areas`}
          data-inplace-body={JSON.stringify({ kind: 'ignore', ...area })}
          data-inplace-done={`Ignored the noisy area of ${screen.name}`}
        >
          <input type="hidden" name="back" value="noisy" />
          <input type="hidden" name="kind" value="ignore" />
          <input type="hidden" name="x" value={String(area.x)} />
          <input type="hidden" name="y" value={String(area.y)} />
          <input type="hidden" name="width" value={String(area.width)} />
          <input type="hidden" name="height" value={String(area.height)} />
          <button
            type="submit"
            class="small ignore-action ignore-unstable"
            disabled={props.blocked}
            title={
              props.blocked
                ? 'Delete the compare areas of this snapshot first to ignore an area'
                : 'Ignore the area that keeps changing, for every check of this snapshot'
            }
            data-confirm={`Ignore ${area.width}×${area.height} px at the ${where} of ${screen.name} (the box on its screenshot)? It applies to every check of this snapshot, on every branch.`}
            data-confirm-label="Ignore this area"
          >
            Ignore noisy area
          </button>
        </form>
      )}
    </article>
  );
}

function NoisyPage(props: {
  ui: Ui;
  project: Project;
  screens: ScreenHistory[];
  sizes: Map<string, Size>;
  blocked: Set<string>;
  canReview: boolean;
  canManage: boolean;
  notice?: string | undefined;
}) {
  const { ui, project, screens } = props;
  return (
    <Layout
      ui={ui}
      title={`${project.name} noisy screens`}
      notice={props.notice}
      crumbs={[{ label: project.name, href: ui.url(`/ui/p/${project.slug}`) }, { label: 'Noisy screens' }]}
      project={project.slug}
      islands={['live']}
    >
      <div class="page-head">
        <div>
          <h1>{project.name}</h1>
        </div>
      </div>
      <ProjectTabs ui={ui} slug={project.slug} current="noisy" canManage={props.canManage} />
      <p class="sub muted noisy-intro">
        Screens that keep changing back and forth on a branch (a clock, an ad, an animation): at least two flips in
        their last 20 runs. Their changes are likely noise; ignore the area that keeps changing to stop it.
      </p>
      {screens.length === 0 ? (
        <div class="empty">
          <h3>No noisy screens</h3>
          <p class="muted">Every screen changed only when something changed.</p>
        </div>
      ) : (
        <div class="noisy-list">
          {screens.map((screen) => {
            const latest = screen.history.at(-1) as HistoryEntry;
            return (
              <NoisyItem
                ui={ui}
                screen={screen}
                size={props.sizes.get(latest.imageSha)}
                canReview={props.canReview}
                blocked={props.blocked.has(screen.snapshotKey)}
              />
            );
          })}
        </div>
      )}
    </Layout>
  );
}

export function registerNoisyPages(app: OpenAPIHono<AppEnv>, s: Services): void {
  app.get('/ui/p/:slug/noisy', async (c) => {
    const ui = uiOf(c, s);
    const project = await getProjectBySlug(s.deps, c.req.param('slug'));
    const screens = await noisyScreens(s.deps, project.id);
    const keys = [...new Set(screens.map((x) => x.snapshotKey))];
    const [sizes, compare] = await Promise.all([
      imageSizes(
        s.deps,
        screens.map((x) => (x.history.at(-1) as HistoryEntry).imageSha),
      ),
      keys.length === 0
        ? Promise.resolve([])
        : s.deps.db
            .selectFrom('snapshotAreas')
            .select('snapshotKey')
            .distinct()
            .where('projectId', '=', project.id)
            .where('kind', '=', 'compare')
            .where('snapshotKey', 'in', keys)
            .execute(),
    ]);
    return c.html(
      <NoisyPage
        ui={ui}
        project={project}
        screens={screens}
        sizes={sizes}
        blocked={new Set(compare.map((r) => r.snapshotKey))}
        canReview={hasPermission(userOf(c), 'check.review')}
        canManage={hasPermission(userOf(c), 'project.admin')}
        notice={noticeOf(c)}
      />,
    );
  });
}
