import { type OpenAPIHono, z } from '@hono/zod-openapi';
import { getBuildRow } from '../../domain/builds';
import { getCheck } from '../../domain/checks';
import { noisyScreens, type ScreenHistory, screenHistory } from '../../domain/flaky';
import { getProjectBySlug } from '../../domain/projects';
import { allowProject } from '../auth';
import { API, type AppEnv, type Services } from '../env';
import { defineRoute } from '../route';
import { json, problems, ScreenHistorySchema } from '../schemas';

/** A screen's history for the API: newest first, without the changes of each check. */
export function historyJson(screen: ScreenHistory) {
  const { history, ...rest } = screen;
  return {
    ...rest,
    items: history.map(({ regions: _regions, reviewedBy: _reviewedBy, ...entry }) => entry).reverse(),
  };
}

export function registerFlakyRoutes(app: OpenAPIHono<AppEnv>, s: Services): void {
  const history = defineRoute('project.read', {
    method: 'get',
    path: `${API}/checks/{id}/history`,
    tags: ['checks'],
    summary: "The check's screen over its last 20 checks on the branch, and whether it is flaky",
    description:
      'A flaky screen keeps flipping (a clock, an ad, an animation): `flaky` says how often and where ' +
      '(`unstableArea`). Changes on a flaky screen are usually noise, not regressions.',
    request: { params: z.object({ id: z.string() }) },
    responses: { 200: json(ScreenHistorySchema, 'The history'), ...problems(401, 403, 404) },
  });
  app.openapi(history, async (c) => {
    const check = await getCheck(s.deps, c.req.valid('param').id);
    allowProject(c, check.projectId);
    const { branch } = await getBuildRow(s.deps, check.buildId);
    const screen = await screenHistory(s.deps, { projectId: check.projectId, snapshotKey: check.snapshotKey, branch });
    if (!screen) throw new Error(`check ${check.id} is missing from its own history`);
    return c.json(historyJson(screen), 200);
  });

  const noisy = defineRoute('project.read', {
    method: 'get',
    path: `${API}/projects/{slug}/noisy-screens`,
    tags: ['checks'],
    summary: "The project's flaky screens, per branch, most flaky first",
    request: { params: z.object({ slug: z.string() }) },
    responses: {
      200: json(z.object({ items: z.array(ScreenHistorySchema) }), 'Flaky screens'),
      ...problems(401, 403, 404),
    },
  });
  app.openapi(noisy, async (c) => {
    const project = await getProjectBySlug(s.deps, c.req.valid('param').slug);
    allowProject(c, project.id);
    return c.json({ items: (await noisyScreens(s.deps, project.id)).map(historyJson) }, 200);
  });
}
