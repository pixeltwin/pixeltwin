import { type OpenAPIHono, z } from '@hono/zod-openapi';
import { baselineHistory, promoteBranch, promotionCandidates } from '../../domain/baselines';
import { branchSchema, parseInput } from '../../domain/schemas';
import { principalOf } from '../auth';
import { API, type AppEnv, type Services } from '../env';
import { defineRoute } from '../route';
import { BaselineSchema, json, PageQuerySchema, pageOf, problems } from '../schemas';

const BaselinePageSchema = pageOf(BaselineSchema, 'BaselinePage');

export function registerBaselineRoutes(app: OpenAPIHono<AppEnv>, s: Services): void {
  const history = defineRoute('project.read', {
    method: 'get',
    path: `${API}/projects/{slug}/snapshots/{snapshotKey}/baselines`,
    tags: ['baselines'],
    summary: "A snapshot's baseline history, newest first",
    request: {
      params: z.object({ slug: z.string(), snapshotKey: z.string() }),
      query: PageQuerySchema.extend({ branch: z.string().optional() }),
    },
    responses: { 200: json(BaselinePageSchema, 'Baselines'), ...problems(401, 403, 404, 422) },
  });
  app.openapi(history, async (c) => {
    const { slug, snapshotKey } = c.req.valid('param');
    return c.json(await baselineHistory(s.deps, slug, snapshotKey, c.req.valid('query')), 200);
  });

  const branchParams = z.object({ slug: z.string(), branch: z.string() });
  const PromotionCandidateSchema = z
    .object({
      snapshotKey: z.string(),
      name: z.string(),
      variant: z.record(z.string(), z.string()),
      branchImageSha: z.string(),
      mainImageSha: z.string().nullable(),
      approvedAt: z.number().int(),
    })
    .openapi('PromotionCandidate');

  const candidates = defineRoute('project.read', {
    method: 'get',
    path: `${API}/projects/{slug}/branches/{branch}/promote`,
    tags: ['baselines'],
    summary: "What promoting the branch would change: its screens whose baseline differs from main's",
    description: 'URL-encode the branch name: `feature%2Flogin`.',
    request: { params: branchParams },
    responses: {
      200: json(z.object({ items: z.array(PromotionCandidateSchema) }), 'Screens that would change on main'),
      ...problems(400, 401, 403, 404, 422),
    },
  });
  app.openapi(candidates, async (c) => {
    const { slug, branch } = c.req.valid('param');
    const parsed = parseInput(z.object({ branch: branchSchema }), { branch });
    return c.json({ items: await promotionCandidates(s.deps, slug, parsed.branch) }, 200);
  });

  const promote = defineRoute('check.write', {
    method: 'post',
    path: `${API}/projects/{slug}/branches/{branch}/promote`,
    tags: ['baselines'],
    summary: "Copy a branch's current baselines to the main branch (after merging), all or some",
    description:
      'URL-encode the branch name: `feature%2Flogin`. Without a body every differing screen is promoted; `snapshotKeys` picks some.',
    request: {
      params: branchParams,
      body: {
        required: false,
        content: {
          'application/json': {
            schema: z.strictObject({ snapshotKeys: z.array(z.string().min(1)).max(1000).optional() }),
          },
        },
      },
    },
    responses: {
      200: json(z.object({ promoted: z.number().int() }), 'Number of baselines promoted'),
      ...problems(400, 401, 403, 404, 422),
    },
  });
  app.openapi(promote, async (c) => {
    const { slug, branch } = c.req.valid('param');
    const parsed = parseInput(z.object({ branch: branchSchema }), { branch });
    const body = (c.req.valid('json') ?? {}) as { snapshotKeys?: string[] };
    const options = body.snapshotKeys ? { snapshotKeys: body.snapshotKeys } : {};
    return c.json(await promoteBranch(s.deps, slug, parsed.branch, principalOf(c).id, options), 200);
  });
}
