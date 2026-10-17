import { type OpenAPIHono, z } from '@hono/zod-openapi';
import { TALL_ASPECT, THUMB_EDGES, thumbEdge } from '../../diff/thumb';
import { projectRoleFor } from '../../domain/auth/access';
import { hasPermission, type Principal } from '../../domain/auth/policy';
import { loadImage } from '../../domain/images';
import { loadThumb } from '../../domain/thumbs';
import { AppError } from '../../errors';
import { accessFiltered } from '../access';
import { principalOf } from '../auth';
import { API, type AppEnv, type Services } from '../env';
import { defineRoute } from '../route';
import { problems } from '../schemas';

/** The projects whose checks or baselines reference the image (usually one). */
async function referencingProjects(s: Services, sha: string): Promise<string[]> {
  const rows = await s.deps.db
    .selectFrom('checks')
    .select('projectId')
    .where((eb) => eb.or([eb('imageSha', '=', sha), eb('diffImageSha', '=', sha)]))
    .union(s.deps.db.selectFrom('baselines').select('projectId').where('imageSha', '=', sha))
    .execute();
  return rows.map((r) => r.projectId);
}

/**
 * Can this caller see the image? Admins see every image; a token or another user only images that
 * a project they may open references.
 */
async function visible(s: Services, sha: string, principal: Principal): Promise<boolean> {
  if (principal.kind === 'user' && hasPermission(principal, 'project.read')) {
    return !!(await s.deps.db.selectFrom('images').select('sha').where('sha', '=', sha).executeTakeFirst());
  }
  for (const projectId of await referencingProjects(s, sha)) {
    if (principal.kind === 'token' ? principal.projectId === projectId : await opens(s, principal, projectId)) {
      return true;
    }
  }
  return false;
}

async function opens(s: Services, user: Extract<Principal, { kind: 'user' }>, projectId: string): Promise<boolean> {
  return hasPermission(user, 'project.read', await projectRoleFor(s.deps, user, projectId));
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
    if (!(await visible(s, sha, principal))) throw notFound;
    accessFiltered(c);
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
    description: `The image scaled down so its longer side is at most \`w\` pixels (rounded up to one of ${THUMB_EDGES.join(', ')}; the largest by default). An image that fits already comes back as it is. \`mode=diff\` keeps a diff image's changed (red) pixels visible; \`fit=top\` scales only the top of the image, ${TALL_ASPECT} times as wide as high (the build page's card of a full-page screenshot); \`crop\` scales only a part of the image (not stored, an image's crops are made again when asked for). Made on the first request and stored; the same caller access as the image.`,
    request: {
      params: z.object({ sha: z.string() }),
      query: z.object({
        w: z.coerce.number().int().min(1).max(10_000).optional(),
        mode: z.enum(['plain', 'diff']).optional(),
        fit: z.enum(['top']).optional().openapi({ description: 'Only the top of the image; not with `crop`.' }),
        crop: z
          .string()
          .regex(/^\d{1,5},\d{1,5},\d{1,5},\d{1,5}$/)
          .optional()
          .openapi({ description: 'Only this part of the image: `x,y,width,height` in image pixels.' }),
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
    const { w, mode = 'plain', crop: area, fit } = c.req.valid('query');
    if (fit && area) throw new AppError('invalid_thumb', 422, 'Ask for a crop or for fit=top, not both.');
    const [x = 0, y = 0, width = 0, height = 0] = area ? area.split(',').map(Number) : [];
    const crop = area ? { x, y, width, height } : undefined;
    const principal = principalOf(c);
    const notFound = new AppError('image_not_found', 404, `Image ${sha} not found.`);
    if (!/^[0-9a-f]{64}$/.test(sha)) throw notFound;
    if (!(await visible(s, sha, principal))) throw notFound;
    accessFiltered(c);
    const edge = thumbEdge(w);
    const bytes = await loadThumb(s.deps, sha, edge, mode, { crop, top: fit === 'top' });
    if (!bytes) throw notFound;
    return c.body(new Uint8Array(bytes).buffer, 200, {
      'content-type': 'image/png',
      'cache-control': 'private, max-age=31536000, immutable',
      etag: `"${sha}-${edge}-${mode}${fit ? `-${fit}` : ''}${area ? `-${area}` : ''}"`,
    });
  });
}
