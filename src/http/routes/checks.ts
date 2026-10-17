import { type OpenAPIHono, z } from '@hono/zod-openapi';
import type { Context } from 'hono';
import { CHECK_RESULTS, CHECK_REVIEWS } from '../../db/schema';
import { createArea, deleteArea, ignoreChanges, listAreas, updateArea } from '../../domain/areas';
import { getBuildRow } from '../../domain/builds';
import { type CheckView, checkElements, getCheck, listChecks, submitCheck } from '../../domain/checks';
import { getProjectById } from '../../domain/projects';
import {
  acceptSuggestion,
  actorFromPrincipal,
  dismissSuggestion,
  listReviews,
  resetReview,
  reviewCheck,
} from '../../domain/reviews';
import { areaInputSchema, areaUpdateSchema, checkMetaSchema, reviewInputSchema } from '../../domain/schemas';
import { AppError } from '../../errors';
import { requireProject } from '../access';
import { principalOf, requirePermission } from '../auth';
import { API, type AppEnv, type Services } from '../env';
import { defineRoute } from '../route';
import {
  AreaSchema,
  CheckSchema,
  json,
  PageQuerySchema,
  pageOf,
  problems,
  ReviewEventSchema,
  SnapshotElementSchema,
} from '../schemas';

const CheckPageSchema = pageOf(CheckSchema, 'CheckPage');
const ReviewedCheckSchema = CheckSchema.extend({
  outcome: z.enum(['applied', 'suggested']).openapi({
    description:
      "applied: the check is approved or rejected. suggested: the project's agent review policy recorded a token's " +
      'review as a suggestion; the check stays pending until a person accepts or dismisses it',
  }),
}).openapi('ReviewedCheck');
const idParam = z.object({ id: z.string() });

/**
 * Under an agent review policy a token may not change areas: an ignore area over a change would
 * pass the check without the review the policy asks for.
 */
async function allowAreaChange(c: Context<AppEnv>, s: Services, projectId: string): Promise<void> {
  if (principalOf(c).kind !== 'token') return;
  const project = await getProjectById(s.deps, projectId);
  if (project.agentReview === 'off') return;
  throw new AppError(
    'agent_review_policy',
    403,
    `Project "${project.slug}" reviews agents' decisions (agent review policy "${project.agentReview}"), so a token cannot change areas. Suggest approving with a reason instead, or ask a person to add the area.`,
  );
}

const jsonUploadSchema = checkMetaSchema.extend({
  imageBase64: z.string().min(1).openapi({ description: 'PNG bytes, base64' }),
});
const multipartUploadSchema = z.object({
  image: z.any().openapi({ type: 'string', format: 'binary', description: 'PNG file' }),
  meta: z.string().openapi({ description: 'Check metadata as JSON (name, variant, ignoreRegions, thresholds)' }),
});

/** Adds the spec §4.3 links. */
export function withLinks(check: CheckView) {
  const image = (sha: string | null | undefined) => (sha ? `${API}/images/${sha}` : null);
  return {
    ...check,
    links: {
      image: `${API}/images/${check.imageSha}`,
      baseline: image(check.baseline?.imageSha),
      diff: image(check.diffImageSha),
      review: `/ui/checks/${check.id}`,
    },
  };
}

function decodeBase64(value: string): Uint8Array {
  const clean = value.replace(/^data:image\/png;base64,/, '');
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(clean)) {
    throw new AppError('validation_failed', 422, 'The request is invalid.', [
      { path: 'imageBase64', message: 'Not valid base64' },
    ]);
  }
  return new Uint8Array(Buffer.from(clean, 'base64'));
}

/** Reads `{ meta, image }` from either content type (spec §4.3). */
/** A diff takes well under 0.1 s on one worker; the hint errs on the long side. */
const SECONDS_PER_QUEUED_DIFF = 0.1;

/**
 * Backpressure: while more diffs wait for a worker than `DIFF_QUEUE_MAX`, uploads get
 * 503 server_busy with a Retry-After hint instead of joining an ever longer queue (and
 * outliving the client's HTTP timeout).
 */
function refuseWhenBusy(s: Services): void {
  const max = s.config.diffQueueMax;
  const backlog = s.deps.diffBacklog?.() ?? 0;
  if (max === 0 || backlog < max) return;
  const err = new AppError(
    'server_busy',
    503,
    `${backlog} screenshots are waiting to be compared; retry this upload after the Retry-After delay.`,
  );
  err.retryAfter = Math.min(30, Math.max(1, Math.ceil((backlog * SECONDS_PER_QUEUED_DIFF) / s.config.diffWorkers)));
  throw err;
}

async function readUpload(c: Context<AppEnv>): Promise<{ meta: unknown; image: Uint8Array }> {
  const type = c.req.header('content-type') ?? '';
  if (type.startsWith('multipart/form-data')) {
    const form = await c.req.formData().catch(() => {
      throw new AppError('bad_request', 400, 'The multipart body is malformed.');
    });
    const image = form.get('image');
    const meta = form.get('meta');
    if (!(image instanceof File) || typeof meta !== 'string') {
      throw new AppError('validation_failed', 422, 'The request is invalid.', [
        ...(image instanceof File ? [] : [{ path: 'image', message: 'Expected a PNG file part' }]),
        ...(typeof meta === 'string' ? [] : [{ path: 'meta', message: 'Expected a JSON text part' }]),
      ]);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(meta);
    } catch {
      throw new AppError('validation_failed', 422, 'The request is invalid.', [
        { path: 'meta', message: 'Not valid JSON' },
      ]);
    }
    return { meta: parsed, image: new Uint8Array(await image.arrayBuffer()) };
  }
  if (type.startsWith('application/json')) {
    const body = (await c.req.json().catch(() => {
      throw new AppError('bad_request', 400, 'The JSON body is malformed.');
    })) as Record<string, unknown> | null;
    if (!body || typeof body !== 'object' || typeof body.imageBase64 !== 'string') {
      throw new AppError('validation_failed', 422, 'The request is invalid.', [
        { path: 'imageBase64', message: 'Expected a base64 PNG' },
      ]);
    }
    const { imageBase64, ...meta } = body;
    return { meta, image: decodeBase64(imageBase64) };
  }
  throw new AppError('unsupported_media_type', 415, 'Send multipart/form-data or application/json.');
}

export function registerCheckRoutes(app: OpenAPIHono<AppEnv>, s: Services): void {
  const submit = defineRoute('check.write', {
    method: 'post',
    path: `${API}/builds/{id}/checks`,
    tags: ['checks'],
    summary: 'Post a screenshot; it is compared with its baseline before the response',
    request: {
      params: idParam,
      body: {
        required: true,
        content: {
          'multipart/form-data': { schema: multipartUploadSchema },
          'application/json': { schema: jsonUploadSchema },
        },
      },
    },
    responses: {
      200: json(CheckSchema, 'The check replaced an earlier one for the same snapshot'),
      201: json(CheckSchema, 'The new check'),
      ...problems(400, 401, 403, 404, 409, 413, 415, 422, 503),
    },
  });
  // Documented with both content types, but served by a plain handler: zod-openapi would validate
  // every declared content type against every request. readUpload validates the one that arrived.
  const { middleware: _middleware, ...submitDoc } = submit;
  app.openAPIRegistry.registerPath(submitDoc);
  app.post(`${API}/builds/:id/checks`, requirePermission('check.write'), requireProject('build'), async (c) => {
    // Refuse before reading the body: under overload, every parsed upload costs the main thread.
    refuseWhenBusy(s);
    const id = c.req.param('id');
    const build = await getBuildRow(s.deps, id);
    const { check, created } = await submitCheck(s.deps, id, await readUpload(c), build);
    return created ? c.json(withLinks(check), 201) : c.json(withLinks(check), 200);
  });

  const list = defineRoute('project.read', {
    method: 'get',
    path: `${API}/builds/{id}/checks`,
    tags: ['checks'],
    summary: "List a build's checks, oldest first",
    request: {
      params: idParam,
      query: PageQuerySchema.extend({
        result: z.enum(CHECK_RESULTS).optional(),
        review: z.enum(CHECK_REVIEWS).optional(),
      }),
    },
    responses: { 200: json(CheckPageSchema, 'Checks'), ...problems(401, 403, 404, 422) },
  });
  app.openapi(list, async (c) => {
    const { id } = c.req.valid('param');
    const page = await listChecks(s.deps, id, c.req.valid('query'));
    return c.json({ items: page.items.map(withLinks), nextCursor: page.nextCursor }, 200);
  });

  const get = defineRoute('project.read', {
    method: 'get',
    path: `${API}/checks/{id}`,
    tags: ['checks'],
    summary: 'Get a check with its diff',
    request: { params: idParam },
    responses: { 200: json(CheckSchema, 'The check'), ...problems(401, 403, 404) },
  });
  app.openapi(get, async (c) => {
    return c.json(withLinks(await getCheck(s.deps, c.req.valid('param').id)), 200);
  });

  for (const action of ['approve', 'reject'] as const) {
    const route = defineRoute('check.review', {
      method: 'post',
      path: `${API}/checks/{id}/${action}`,
      tags: ['reviews'],
      summary:
        action === 'approve'
          ? "Approve a check; its image becomes the baseline. A token's approval may be recorded as a suggestion (see outcome)"
          : "Reject a check. A token's rejection may be recorded as a suggestion (see outcome)",
      request: {
        params: idParam,
        body: { required: false, content: { 'application/json': { schema: reviewInputSchema } } },
      },
      responses: {
        200: json(ReviewedCheckSchema, 'The check, and whether the review applied or became a suggestion'),
        ...problems(401, 403, 404, 409, 422),
      },
    });
    app.openapi(route, async (c) => {
      const { id } = c.req.valid('param');
      const input = c.req.header('content-type')?.startsWith('application/json') ? c.req.valid('json') : {};
      const { check, outcome } = await reviewCheck(s.deps, id, action, actorFromPrincipal(principalOf(c)), input);
      return c.json({ ...withLinks(check), outcome }, 200);
    });
  }

  const accept = defineRoute('check.review', {
    method: 'post',
    path: `${API}/checks/{id}/suggestion/accept`,
    tags: ['reviews'],
    summary: "Accept an agent's suggestion: approve or reject as it suggested, with its reason (people only)",
    request: { params: idParam },
    responses: { 200: json(CheckSchema, 'The reviewed check'), ...problems(401, 403, 404, 409) },
  });
  app.openapi(accept, async (c) => {
    const { id } = c.req.valid('param');
    return c.json(withLinks(await acceptSuggestion(s.deps, id, actorFromPrincipal(principalOf(c)))), 200);
  });

  const dismiss = defineRoute('check.review', {
    method: 'post',
    path: `${API}/checks/{id}/suggestion/dismiss`,
    tags: ['reviews'],
    summary: "Dismiss an agent's suggestion; the check keeps waiting for a review",
    request: {
      params: idParam,
      body: { required: false, content: { 'application/json': { schema: reviewInputSchema } } },
    },
    responses: { 200: json(CheckSchema, 'The check, without the suggestion'), ...problems(401, 403, 404, 409, 422) },
  });
  app.openapi(dismiss, async (c) => {
    const { id } = c.req.valid('param');
    const input = c.req.header('content-type')?.startsWith('application/json') ? c.req.valid('json') : {};
    return c.json(withLinks(await dismissSuggestion(s.deps, id, actorFromPrincipal(principalOf(c)), input)), 200);
  });

  const elements = defineRoute('project.read', {
    method: 'get',
    path: `${API}/checks/{id}/elements`,
    tags: ['checks'],
    summary: 'The page elements sent with the check and with the baseline it was compared with',
    request: { params: idParam },
    responses: {
      200: json(
        z.object({
          current: z.array(SnapshotElementSchema).nullable(),
          baseline: z.array(SnapshotElementSchema).nullable(),
        }),
        'Elements (boxes in screenshot pixels); null where the SDK sent none',
      ),
      ...problems(401, 403, 404),
    },
  });
  app.openapi(elements, async (c) => {
    const { id } = c.req.valid('param');
    return c.json(await checkElements(s.deps, id), 200);
  });

  const reset = defineRoute('check.review', {
    method: 'post',
    path: `${API}/checks/{id}/reset`,
    tags: ['reviews'],
    summary:
      'Undo a review: back to pending. Undoing an approval removes the baseline it created, unless a newer one replaced it (409 review_not_resettable)',
    request: { params: idParam },
    responses: { 200: json(CheckSchema, 'The check, pending again'), ...problems(401, 403, 404, 409) },
  });
  app.openapi(reset, async (c) => {
    const { id } = c.req.valid('param');
    return c.json(withLinks(await resetReview(s.deps, id, actorFromPrincipal(principalOf(c)))), 200);
  });

  const areasList = defineRoute('project.read', {
    method: 'get',
    path: `${API}/checks/{id}/areas`,
    tags: ['areas'],
    summary: "Ignore and compare areas drawn on the check's snapshot (they apply to every check of it)",
    request: { params: idParam },
    responses: { 200: json(z.object({ items: z.array(AreaSchema) }), 'The areas'), ...problems(401, 403, 404) },
  });
  app.openapi(areasList, async (c) => {
    const { id } = c.req.valid('param');
    return c.json({ items: await listAreas(s.deps, id) }, 200);
  });

  const areaCreate = defineRoute('check.review', {
    method: 'post',
    path: `${API}/checks/{id}/areas`,
    tags: ['areas'],
    summary: "Draw an area on the check's snapshot; the check is compared again at once",
    request: {
      params: idParam,
      body: { required: true, content: { 'application/json': { schema: areaInputSchema } } },
    },
    responses: {
      201: json(z.object({ area: AreaSchema, check: CheckSchema }), 'The area and the check compared again'),
      ...problems(401, 403, 404, 409, 422),
    },
  });
  app.openapi(areaCreate, async (c) => {
    const { id } = c.req.valid('param');
    const { projectId } = await getCheck(s.deps, id);
    await allowAreaChange(c, s, projectId);
    const { area, check } = await createArea(s.deps, id, principalOf(c).id, c.req.valid('json'));
    return c.json({ area, check: withLinks(check) }, 201);
  });

  const areaIgnoreChanges = defineRoute('check.review', {
    method: 'post',
    path: `${API}/checks/{id}/areas/ignore-changes`,
    tags: ['areas'],
    summary: 'Ignore all changes: an ignore area around each change of the check; compared again at once',
    request: { params: idParam },
    responses: {
      201: json(z.object({ areas: z.array(AreaSchema), check: CheckSchema }), 'The new areas and the check'),
      ...problems(401, 403, 404, 409, 422),
    },
  });
  app.openapi(areaIgnoreChanges, async (c) => {
    const { id } = c.req.valid('param');
    const { projectId } = await getCheck(s.deps, id);
    await allowAreaChange(c, s, projectId);
    const { areas, check } = await ignoreChanges(s.deps, id, principalOf(c).id);
    return c.json({ areas, check: withLinks(check) }, 201);
  });

  const areaUpdate = defineRoute('check.review', {
    method: 'patch',
    path: `${API}/checks/{id}/areas/{areaId}`,
    tags: ['areas'],
    summary: 'Move or resize an area (its kind stays); the check is compared again at once',
    request: {
      params: z.object({ id: z.string(), areaId: z.string() }),
      body: { required: true, content: { 'application/json': { schema: areaUpdateSchema } } },
    },
    responses: {
      200: json(z.object({ area: AreaSchema, check: CheckSchema }), 'The area and the check compared again'),
      ...problems(401, 403, 404, 422),
    },
  });
  app.openapi(areaUpdate, async (c) => {
    const { id, areaId } = c.req.valid('param');
    const { projectId } = await getCheck(s.deps, id);
    await allowAreaChange(c, s, projectId);
    const { area, check } = await updateArea(s.deps, id, areaId, c.req.valid('json'));
    return c.json({ area, check: withLinks(check) }, 200);
  });

  const areaDelete = defineRoute('check.review', {
    method: 'delete',
    path: `${API}/checks/{id}/areas/{areaId}`,
    tags: ['areas'],
    summary: 'Delete an area; the check is compared again at once',
    request: { params: z.object({ id: z.string(), areaId: z.string() }) },
    responses: { 200: json(CheckSchema, 'The check compared again'), ...problems(401, 403, 404) },
  });
  app.openapi(areaDelete, async (c) => {
    const { id, areaId } = c.req.valid('param');
    return c.json(withLinks(await deleteArea(s.deps, id, areaId)), 200);
  });

  const history = defineRoute('project.read', {
    method: 'get',
    path: `${API}/checks/{id}/reviews`,
    tags: ['reviews'],
    summary: 'Review history of a check: every approval, rejection and undo, newest first',
    request: { params: idParam },
    responses: {
      200: json(z.object({ items: z.array(ReviewEventSchema) }), 'The review history'),
      ...problems(401, 403, 404),
    },
  });
  app.openapi(history, async (c) => {
    const { id } = c.req.valid('param');
    return c.json({ items: await listReviews(s.deps, id) }, 200);
  });
}
