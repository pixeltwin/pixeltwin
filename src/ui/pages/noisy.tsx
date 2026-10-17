import type { OpenAPIHono } from '@hono/zod-openapi';
import type { Project } from '../../db/schema';
import type { Rect, Size } from '../../diff/types';
import { aroundChange } from '../../domain/areas';
import { type HistoryEntry, noisyScreens, type ScreenHistory } from '../../domain/flaky';
import { imageSizes } from '../../domain/images';
import { visibleProject } from '../../http/access';
import type { AppEnv, Services } from '../../http/env';
import { FlakyBadge, flakyText, HistoryStrip, ProjectTabs, Variant } from '../components';
import { noticeOf, type Ui, uiOf } from '../context';
import { Layout } from '../layout';

/**
 * One noisy screen: its latest screenshot with the area that keeps changing. Ignoring it happens on
 * the check, where the area is previewed on the screenshot first.
 */
function NoisyItem(props: { ui: Ui; screen: ScreenHistory; size: Size | undefined }) {
  const { ui, screen, size } = props;
  const latest = screen.history.at(-1) as HistoryEntry;
  const flaky = screen.flaky;
  const area: Rect | null = flaky?.unstableArea ? aroundChange(flaky.unstableArea, size) : null;
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
    </article>
  );
}

function NoisyPage(props: {
  ui: Ui;
  project: Project;
  screens: ScreenHistory[];
  sizes: Map<string, Size>;
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
        their last 20 runs. Their changes are likely noise: open one to ignore the area that keeps changing.
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
            return <NoisyItem ui={ui} screen={screen} size={props.sizes.get(latest.imageSha)} />;
          })}
        </div>
      )}
    </Layout>
  );
}

export function registerNoisyPages(app: OpenAPIHono<AppEnv>, s: Services): void {
  app.get('/ui/p/:slug/noisy', async (c) => {
    const ui = uiOf(c, s);
    const { project, access } = await visibleProject(c, s.deps, c.req.param('slug'), 'project.read');
    const screens = await noisyScreens(s.deps, project.id);
    const sizes = await imageSizes(
      s.deps,
      screens.map((x) => (x.history.at(-1) as HistoryEntry).imageSha),
    );
    return c.html(
      <NoisyPage
        ui={ui}
        project={project}
        screens={screens}
        sizes={sizes}
        canManage={access.can('project.admin')}
        notice={noticeOf(c)}
      />,
    );
  });
}
