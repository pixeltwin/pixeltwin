import { OpenAPIHono } from '@hono/zod-openapi';
import type { MiddlewareHandler } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { HTTPException } from 'hono/http-exception';
import { AppError, validationError } from '../errors';
import { newId } from '../ids';
import { authenticate } from './auth';
import { API, type AppEnv, type Services } from './env';
import { problemResponse, titleFor } from './problem';
import { registerAuthRoutes } from './routes/auth';
import { registerProjectRoutes } from './routes/projects';
import { registerSystemRoutes } from './routes/system';
import { registerUserRoutes } from './routes/users';

const DEFAULT_BODY_LIMIT = 1024 * 1024;
const HTTP_CODES: Record<number, string> = {
  400: 'bad_request',
  404: 'not_found',
  405: 'method_not_allowed',
  413: 'payload_too_large',
  415: 'unsupported_media_type',
};
const CHECK_UPLOAD_PATH = new RegExp(`^${API}/builds/[^/]+/checks$`);

function requestContext(services: Services): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const requestId = newId('req');
    c.set('requestId', requestId);
    const started = performance.now();
    await next();
    c.res.headers.set('x-request-id', requestId);
    c.res.headers.set('x-content-type-options', 'nosniff');
    services.logger.info('request', {
      requestId,
      method: c.req.method,
      path: c.req.path,
      status: c.res.status,
      ms: Math.round(performance.now() - started),
      principal: c.get('principal')?.id ?? null,
    });
  };
}

/** Spec §7.4: size limits before parsing. Check uploads may carry a base64 image plus metadata. */
function bodyLimits(maxImageBytes: number): MiddlewareHandler<AppEnv> {
  const uploadLimit = Math.ceil(maxImageBytes / 3) * 4 + 64 * 1024;
  const onError = () => {
    throw new AppError('payload_too_large', 413, 'The request body is too large.');
  };
  const upload = bodyLimit({ maxSize: uploadLimit, onError });
  const standard = bodyLimit({ maxSize: DEFAULT_BODY_LIMIT, onError });
  return (c, next) => (CHECK_UPLOAD_PATH.test(c.req.path) ? upload(c, next) : standard(c, next));
}

export function createApp(services: Services): OpenAPIHono<AppEnv> {
  const app = new OpenAPIHono<AppEnv>({
    defaultHook: (result) => {
      if (!result.success) throw validationError(result.error);
    },
  });

  app.use('*', requestContext(services));
  app.use(`${API}/*`, bodyLimits(services.config.maxImageBytes));
  app.use(`${API}/*`, authenticate(services));

  app.onError((err, c) => {
    const requestId = c.get('requestId') ?? newId('req');
    if (err instanceof AppError) return problemResponse(err.status, err.code, err.detail, requestId, err.errors);
    if (err instanceof HTTPException && err.status < 500) {
      const code = HTTP_CODES[err.status] ?? `http_${err.status}`;
      return problemResponse(err.status, code, err.message || titleFor(code), requestId);
    }
    services.logger.error('unhandled error', { requestId, error: err instanceof Error ? err.stack : String(err) });
    return problemResponse(
      500,
      'internal_error',
      'Something went wrong. Quote the request id when reporting it.',
      requestId,
    );
  });
  app.notFound((c) =>
    problemResponse(404, 'not_found', `No route for ${c.req.method} ${c.req.path}.`, c.get('requestId')),
  );

  app.openAPIRegistry.registerComponent('securitySchemes', 'projectToken', {
    type: 'http',
    scheme: 'bearer',
    description: 'Project token `pt_…` from POST /api/v1/projects/{slug}/tokens',
  });
  app.openAPIRegistry.registerComponent('securitySchemes', 'session', {
    type: 'apiKey',
    in: 'cookie',
    name: 'pt_session',
    description: 'Session cookie set by POST /api/v1/auth/login',
  });

  registerSystemRoutes(app, services);
  registerAuthRoutes(app, services);
  registerUserRoutes(app, services);
  registerProjectRoutes(app, services);
  return app;
}
