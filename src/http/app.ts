import { OpenAPIHono } from '@hono/zod-openapi';
import type { MiddlewareHandler } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { HTTPException } from 'hono/http-exception';
import { AppError, validationError } from '../errors';
import { newId } from '../ids';
import { renderUiError } from '../ui/errors';
import { registerUi } from '../ui/register';
import { authenticate } from './auth';
import { registerDocRoutes } from './docs';
import { API, type AppEnv, type Services } from './env';
import { problemResponse, titleFor } from './problem';
import { registerAuthRoutes } from './routes/auth';
import { registerBaselineRoutes } from './routes/baselines';
import { registerBuildRoutes } from './routes/builds';
import { registerCheckRoutes } from './routes/checks';
import { registerFlakyRoutes } from './routes/flaky';
import { registerGroupRoutes } from './routes/groups';
import { registerImageRoutes } from './routes/images';
import { INBOUND_WEBHOOK_PATH, registerIntegrationRoutes } from './routes/integrations';
import { registerProjectRoutes } from './routes/projects';
import { registerSystemRoutes } from './routes/system';
import { registerUserRoutes } from './routes/users';

const DEFAULT_BODY_LIMIT = 1024 * 1024;
const UI_PATH = /^\/ui(\/|$)/;
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
    // Health probes hit every few seconds; at info they would bury real traffic.
    const log = c.req.path === '/healthz' ? services.logger.debug : services.logger.info;
    log('request', {
      requestId,
      method: c.req.method,
      path: c.req.path,
      status: c.res.status,
      ms: Math.round(performance.now() - started),
      principal: c.get('principal')?.id ?? null,
    });
  };
}

/**
 * Spec §7.4: size limits before parsing. Check uploads may carry a base64 image plus metadata,
 * which with its page elements (the SDKs cap them at 200 KB of JSON) needs up to about 300 KB.
 */
function bodyLimits(maxImageBytes: number): MiddlewareHandler<AppEnv> {
  const uploadLimit = Math.ceil(maxImageBytes / 3) * 4 + 320 * 1024;
  const onError = () => {
    throw new AppError('payload_too_large', 413, 'The request body is too large.');
  };
  const upload = bodyLimit({ maxSize: uploadLimit, onError });
  const standard = bodyLimit({ maxSize: DEFAULT_BODY_LIMIT, onError });
  return (c, next) => (CHECK_UPLOAD_PATH.test(c.req.path) ? upload(c, next) : standard(c, next));
}

const CORS_HEADERS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, PUT, PATCH, DELETE',
  'access-control-allow-headers': 'authorization, content-type',
  'access-control-max-age': '600',
};

/**
 * The API answers any origin (a test report opened from a file or a CI artifact), for Bearer
 * tokens only: `*` is never sent with credentials, so a cross-origin page cannot ride on a
 * session cookie (and cookie writes need PUBLIC_URL's Origin anyway).
 */
function cors(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (c.req.method === 'OPTIONS' && c.req.header('access-control-request-method')) {
      return c.body(null, 204, CORS_HEADERS);
    }
    await next();
    c.res.headers.set('access-control-allow-origin', '*');
  };
}

export function createApp(services: Services): OpenAPIHono<AppEnv> {
  const app = new OpenAPIHono<AppEnv>({
    defaultHook: (result) => {
      if (!result.success) throw validationError(result.error);
    },
  });

  app.use('*', requestContext(services));
  app.use(`${API}/*`, cors());
  app.use(`${API}/*`, bodyLimits(services.config.maxImageBytes));
  // UI forms are small; refuse big bodies before parsing (spec §7.4), including the public login form.
  app.use(
    '/ui/*',
    bodyLimit({
      maxSize: DEFAULT_BODY_LIMIT,
      onError: () => {
        throw new AppError('payload_too_large', 413, 'The form is too large.');
      },
    }),
  );
  // Code host webhooks bring their own secret: no session, so no cookie and no CSRF check applies.
  const auth = authenticate(services);
  app.use(`${API}/*`, (c, next) => (INBOUND_WEBHOOK_PATH.test(c.req.path) ? next() : auth(c, next)));

  app.onError((err, c) => {
    const requestId = c.get('requestId') ?? newId('req');
    if (UI_PATH.test(c.req.path)) {
      if (!(err instanceof AppError)) {
        services.logger.error('unhandled error', { requestId, error: err instanceof Error ? err.stack : String(err) });
      }
      return renderUiError(c, services, err, requestId);
    }
    if (err instanceof AppError) {
      const res = problemResponse(err.status, err.code, err.detail, requestId, err.errors);
      if (err.retryAfter !== undefined) res.headers.set('retry-after', String(err.retryAfter));
      return res;
    }
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
  app.notFound((c) => {
    const err = new AppError('not_found', 404, `No route for ${c.req.method} ${c.req.path}.`);
    if (UI_PATH.test(c.req.path)) return renderUiError(c, services, err, c.get('requestId'));
    return problemResponse(err.status, err.code, err.detail, c.get('requestId'));
  });

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
  registerBuildRoutes(app, services);
  registerCheckRoutes(app, services);
  registerGroupRoutes(app, services);
  registerFlakyRoutes(app, services);
  registerBaselineRoutes(app, services);
  registerIntegrationRoutes(app, services);
  registerImageRoutes(app, services);
  registerDocRoutes(app, services);
  registerUi(app, services);
  return app;
}
