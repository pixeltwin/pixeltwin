import { type OpenAPIHono, z } from '@hono/zod-openapi';
import { getInsights, MAX_RANGE_DAYS, rangeOf } from '../../domain/insights-report';
import { getProjectBySlug } from '../../domain/projects';
import { branchSchema } from '../../domain/schemas';
import { API, type AppEnv, type Services } from '../env';
import { defineRoute } from '../route';
import { InsightsSchema, json, problems } from '../schemas';

const date = (description: string) =>
  z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional()
    .openapi({ description, example: '2026-10-17' });

export function registerInsightRoutes(app: OpenAPIHono<AppEnv>, s: Services): void {
  const insights = defineRoute('project.read', {
    method: 'get',
    path: `${API}/projects/{slug}/insights`,
    tags: ['insights'],
    summary: "How healthy the project's visual tests are on a branch: auto-pass rate, review load and noise",
    description:
      'Daily numbers of the finalized builds of a branch over a range of UTC days (they outlive retention): ' +
      'how many checks passed by themselves, how many a person or agent had to decide and how fast, why ' +
      'rejections were made (not_loaded, late_asset, animation and dynamic_data are noise from the test, ' +
      'real_bug a regression), what agent suggestions became, and run time. Plus the screens to fix in the ' +
      'tests (`noisyScreens`, with the main reason and what to do), the slowest screens to compare and the ' +
      'reviewers. A build counts on the day it was created, its reviews with it. Default: the last 30 days ' +
      `of the main branch; at most ${MAX_RANGE_DAYS} days.`,
    request: {
      params: z.object({ slug: z.string() }),
      query: z.object({
        from: date('First day (UTC), inclusive; default 29 days before `to`'),
        to: date('Last day (UTC), inclusive; default today'),
        branch: branchSchema.optional().openapi({ description: "Default the project's main branch" }),
      }),
    },
    responses: { 200: json(InsightsSchema, 'The insights'), ...problems(401, 403, 404, 422) },
  });
  app.openapi(insights, async (c) => {
    const project = await getProjectBySlug(s.deps, c.req.valid('param').slug);
    const report = await getInsights(s.deps, project, rangeOf(project, c.req.valid('query')));
    return c.json(report, 200);
  });
}
