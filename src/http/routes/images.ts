import { type OpenAPIHono, z } from '@hono/zod-openapi';
import { THUMB_EDGES, thumbEdge } from '../../diff/thumb';
import { loadImage } from '../../domain/images';
import { loadThumb } from '../../domain/thumbs';
import { AppError } from '../../errors';
import { principalOf } from '../auth';
import { API, type AppEnv, type Services } from '../env';
import { defineRoute } from '../route';
import { problems } from '../schemas';

/** Can this caller see the image? Users see every project; a token only images its project references. */
async function visible(s: Services, sha: string, projectId: string | null): Promise<boolean> {
  if (projectId === null) {
    return !!(await s.deps.db.selectFrom('images').select('sha').where('sha', '=', sha).executeTakeFirst());
  }
  const viaCheck = await s.deps.db
    .selectFrom('checks')
    .select('id')
    .where('projectId', '=', projectId)
    .where((eb) => eb.or([eb('imageSha', '=', sha), eb('diffImageSha', '=', sha)]))
    .limit(1)
    .executeTakeFirst();
  if (viaCheck) return true;
  const viaBaseline = await s.deps.db
    .selectFrom('baselines')
    .select('id')
    .where('projectId', '=', projectId)
    .where('imageSha', '=', sha)
    .limit(1)
    .executeTakeFirst();
  return !!viaBaseline;
}

export function registerImageRoutes(app: OpenAPIHono<AppEnv>, s: Services): void {
  const get = defineRoute('project.read', {
    method: 'get',
    path: `${API}/images/{sha}`,
    tags: ['images'],
    summary: 'Download a screenshot, baseline or diff image (PNG)',
    request: { params: z.object({ sha: z.string() }) },
    responses: {
      200: {
        description: 'PNG image',
        content: { 'image/png': { schema: z.any().openapi({ type: 'string', format: 'binary' }) } },
      },
      ...problems(401, 403, 404),
    },
  });
  app.openapi(get, async (c) => {
    const { sha } = c.req.valid('param');
    const principal = principalOf(c);
    const notFound = new AppError('image_not_found', 404, `Image ${sha} not found.`);
    if (!/^[0-9a-f]{64}$/.test(sha)) throw notFound;
    if (!(await visible(s, sha, principal.kind === 'token' ? principal.projectId : null))) throw notFound;
    const bytes = await loadImage(s.deps, sha);
    if (!bytes) throw notFound;
    return c.body(new Uint8Array(bytes).buffer, 200, {
      'content-type': 'image/png',
      'cache-control': 'private, max-age=31536000, immutable',
      etag: `"${sha}"`,
    });
  });

  // The build page's cards: a scaled-down copy, made once and stored. Same access as the image.
  const thumb = defineRoute('project.read', {
    method: 'get',
    path: `${API}/images/{sha}/thumb`,
    tags: ['images'],
    summary: 'Download a thumbnail of an image (PNG)',
    description: `The image scaled down so its longer side is at most \`w\` pixels (rounded up to one of ${THUMB_EDGES.join(', ')}; the largest by default). An image that fits already comes back as it is. \`mode=diff\` keeps a diff image's changed (red) pixels visible. Made on the first request and stored; the same caller access as the image.`,
    request: {
      params: z.object({ sha: z.string() }),
      query: z.object({
        w: z.coerce.number().int().min(1).max(10_000).optional(),
        mode: z.enum(['plain', 'diff']).optional(),
      }),
    },
    responses: {
      200: {
        description: 'PNG image',
        content: { 'image/png': { schema: z.any().openapi({ type: 'string', format: 'binary' }) } },
      },
      ...problems(401, 403, 404, 422),
    },
  });
  app.openapi(thumb, async (c) => {
    const { sha } = c.req.valid('param');
    const { w, mode = 'plain' } = c.req.valid('query');
    const principal = principalOf(c);
    const notFound = new AppError('image_not_found', 404, `Image ${sha} not found.`);
    if (!/^[0-9a-f]{64}$/.test(sha)) throw notFound;
    if (!(await visible(s, sha, principal.kind === 'token' ? principal.projectId : null))) throw notFound;
    const edge = thumbEdge(w);
    const bytes = await loadThumb(s.deps, sha, edge, mode);
    if (!bytes) throw notFound;
    return c.body(new Uint8Array(bytes).buffer, 200, {
      'content-type': 'image/png',
      'cache-control': 'private, max-age=31536000, immutable',
      etag: `"${sha}-${edge}-${mode}"`,
    });
  });
}
