import { type OpenAPIHono, z } from '@hono/zod-openapi';
import type { Context } from 'hono';
import { CHECK_RESULTS, CHECK_REVIEWS } from '../../db/schema';
import { getBuildRow } from '../../domain/builds';
import { type CheckView, getCheck, listChecks, submitCheck } from '../../domain/checks';
import { approveCheck, rejectCheck, resetReview } from '../../domain/reviews';
import { checkMetaSchema, reviewInputSchema } from '../../domain/schemas';
import { AppError } from '../../errors';
import { allowProject, principalOf, requirePermission } from '../auth';
import { API, type AppEnv, type Services } from '../env';
import { defineRoute } from '../route';
import { CheckSchema, json, PageQuerySchema, pageOf, problems } from '../schemas';

const CheckPageSchema = pageOf(CheckSchema, 'CheckPage');
const idParam = z.object({ id: z.string() });

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
      ...problems(400, 401, 403, 404, 409, 413, 415, 422),
    },
  });
  // Documented with both content types, but served by a plain handler: zod-openapi would validate
  // every declared content type against every request. readUpload validates the one that arrived.
  const { middleware: _middleware, ...submitDoc } = submit;
  app.openAPIRegistry.registerPath(submitDoc);
  app.post(`${API}/builds/:id/checks`, requirePermission('check.write'), async (c) => {
    const id = c.req.param('id');
    allowProject(c, (await getBuildRow(s.deps, id)).projectId);
    const { check, created } = await submitCheck(s.deps, id, await readUpload(c));
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
    allowProject(c, (await getBuildRow(s.deps, id)).projectId);
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
    const check = await getCheck(s.deps, c.req.valid('param').id);
    allowProject(c, check.projectId);
    return c.json(withLinks(check), 200);
  });

  for (const action of ['approve', 'reject'] as const) {
    const route = defineRoute('check.review', {
      method: 'post',
      path: `${API}/checks/{id}/${action}`,
      tags: ['reviews'],
      summary: action === 'approve' ? 'Approve a check; its image becomes the baseline' : 'Reject a check',
      request: {
        params: idParam,
        body: { required: false, content: { 'application/json': { schema: reviewInputSchema } } },
      },
      responses: { 200: json(CheckSchema, 'The reviewed check'), ...problems(401, 403, 404, 409, 422) },
    });
    app.openapi(route, async (c) => {
      const { id } = c.req.valid('param');
      allowProject(c, (await getCheck(s.deps, id)).projectId);
      const input = c.req.header('content-type')?.startsWith('application/json') ? c.req.valid('json') : {};
      const review = action === 'approve' ? approveCheck : rejectCheck;
      return c.json(withLinks(await review(s.deps, id, principalOf(c).id, input)), 200);
    });
  }

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
    allowProject(c, (await getCheck(s.deps, id)).projectId);
    return c.json(withLinks(await resetReview(s.deps, id)), 200);
  });
}
