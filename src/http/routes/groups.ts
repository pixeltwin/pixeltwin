import { type OpenAPIHono, z } from '@hono/zod-openapi';
import { getBuildRow } from '../../domain/builds';
import { listGroups, resetGroup, reviewGroup } from '../../domain/groups';
import { groupResetSchema, reviewInputSchema } from '../../domain/schemas';
import { allowProject, principalOf } from '../auth';
import { API, type AppEnv, type Services } from '../env';
import { defineRoute } from '../route';
import { ChangeGroupSchema, GroupReviewSchema, json, problems } from '../schemas';

const idParam = z.object({ id: z.string() });
const groupParam = z.object({ id: z.string(), groupId: z.string() });

export function registerGroupRoutes(app: OpenAPIHono<AppEnv>, s: Services): void {
  const list = defineRoute('project.read', {
    method: 'get',
    path: `${API}/builds/{id}/groups`,
    tags: ['reviews'],
    summary: 'Change groups of a build: checks with exactly the same changes, to review at once',
    description:
      'A group is two or more checks of the build with the same change key: the same change (a new header) on ' +
      'several screens or variants, wherever it is on each. A check with that change and one more is not in the ' +
      "group. Each check's `groupId` names its group. Biggest first.",
    request: { params: idParam },
    responses: {
      200: json(z.object({ items: z.array(ChangeGroupSchema) }), 'The change groups'),
      ...problems(401, 403, 404),
    },
  });
  app.openapi(list, async (c) => {
    const { id } = c.req.valid('param');
    allowProject(c, (await getBuildRow(s.deps, id)).projectId);
    return c.json({ items: await listGroups(s.deps, id) }, 200);
  });

  for (const action of ['approve', 'reject'] as const) {
    const route = defineRoute('check.review', {
      method: 'post',
      path: `${API}/builds/{id}/groups/{groupId}/${action}`,
      tags: ['reviews'],
      summary:
        action === 'approve'
          ? 'Approve every check of a change group that waits for review'
          : 'Reject every check of a change group that waits for review',
      description:
        'One transaction; each check gets its own review event, as with a single review. Checks already reviewed ' +
        'and outdated ones (a newer build approved their screen) are left as they are and listed in `skipped`. ' +
        'The response has the build’s new verdict.',
      request: {
        params: groupParam,
        body: { required: false, content: { 'application/json': { schema: reviewInputSchema } } },
      },
      responses: { 200: json(GroupReviewSchema, 'What changed'), ...problems(401, 403, 404, 422) },
    });
    app.openapi(route, async (c) => {
      const { id, groupId } = c.req.valid('param');
      allowProject(c, (await getBuildRow(s.deps, id)).projectId);
      const input = c.req.header('content-type')?.startsWith('application/json') ? c.req.valid('json') : {};
      return c.json(await reviewGroup(s.deps, id, groupId, action, principalOf(c).id, input), 200);
    });
  }

  const reset = defineRoute('check.review', {
    method: 'post',
    path: `${API}/builds/{id}/groups/{groupId}/reset`,
    tags: ['reviews'],
    summary: "Undo the reviews of a change group's checks: those in checkIds, else all of them",
    description:
      'Send the `changed` list of a group approve or reject as `checkIds` to undo exactly that. All or nothing: ' +
      'when one approval cannot be undone (409 review_not_resettable), none is.',
    request: {
      params: groupParam,
      body: { required: false, content: { 'application/json': { schema: groupResetSchema } } },
    },
    responses: { 200: json(GroupReviewSchema, 'What changed'), ...problems(401, 403, 404, 409, 422) },
  });
  app.openapi(reset, async (c) => {
    const { id, groupId } = c.req.valid('param');
    allowProject(c, (await getBuildRow(s.deps, id)).projectId);
    const input = c.req.header('content-type')?.startsWith('application/json') ? c.req.valid('json') : {};
    return c.json(await resetGroup(s.deps, id, groupId, principalOf(c).id, input), 200);
  });
}
