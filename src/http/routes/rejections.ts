import { type OpenAPIHono, z } from '@hono/zod-openapi';
import { getProjectBySlug } from '../../domain/projects';
import { buildRejectionPatterns, MAX_REJECTIONS, rejectionPatterns } from '../../domain/rejections';
import { branchSchema } from '../../domain/schemas';
import { API, type AppEnv, type Services } from '../env';
import { defineRoute } from '../route';
import { json, problems, RejectionPatternsSchema } from '../schemas';

const DESCRIPTION =
  'Why screens were rejected, read from the review history: per category (most given first) and per ' +
  'screen (the most recently rejected first) with counts, the last rejections (category, comment, who, ' +
  'when) and a one-sentence `hint` on what to do in the test code. Undone rejections are left out. ' +
  'Read it before judging a change: a screen rejected as not_loaded or late_asset was captured too early ' +
  '(add a wait), as dynamic_data needs an ignore area, as animation needs animations disabled or retakes, ' +
  'as real_bug means a real regression.';

export function registerRejectionRoutes(app: OpenAPIHono<AppEnv>, s: Services): void {
  const project = defineRoute('project.read', {
    method: 'get',
    path: `${API}/projects/{slug}/rejections`,
    tags: ['reviews'],
    summary: "Rejection patterns of the project's screens: why they were rejected, by category and by screen",
    description: `${DESCRIPTION} Without filters, the project's last ${MAX_REJECTIONS} rejections on every branch.`,
    request: {
      params: z.object({ slug: z.string() }),
      query: z.object({
        branch: branchSchema.optional().openapi({ description: 'Only rejections on builds of this branch' }),
        snapshotKey: z.string().min(1).max(200).optional().openapi({ description: 'Only this screen' }),
        limit: z.coerce
          .number()
          .int()
          .min(1)
          .max(MAX_REJECTIONS)
          .optional()
          .openapi({ description: `Rejections to look at, newest first; default ${MAX_REJECTIONS}` }),
      }),
    },
    responses: { 200: json(RejectionPatternsSchema, 'The patterns'), ...problems(401, 403, 404, 422) },
  });
  app.openapi(project, async (c) => {
    const { id } = await getProjectBySlug(s.deps, c.req.valid('param').slug);
    const { branch, snapshotKey, limit } = c.req.valid('query');
    const patterns = await rejectionPatterns(s.deps, id, {
      branch,
      limit,
      ...(snapshotKey ? { snapshotKeys: [snapshotKey] } : {}),
    });
    return c.json(patterns, 200);
  });

  const build = defineRoute('project.read', {
    method: 'get',
    path: `${API}/builds/{id}/rejections`,
    tags: ['reviews'],
    summary: "Rejection patterns of the build's screens, on every branch, each with its check in this build",
    description: `${DESCRIPTION} One call for a whole build: what an agent reviewing it, or an SDK ending its run, needs.`,
    request: { params: z.object({ id: z.string() }) },
    responses: { 200: json(RejectionPatternsSchema, 'The patterns'), ...problems(401, 403, 404) },
  });
  app.openapi(build, async (c) => {
    return c.json(await buildRejectionPatterns(s.deps, c.req.valid('param').id), 200);
  });
}
