import type { OpenAPIHono } from '@hono/zod-openapi';
import type { UserRole } from '../../src/db/schema';
import { SetupState } from '../../src/domain/auth/setup';
import { createProjectToken, type TokenScope } from '../../src/domain/auth/tokens';
import { createUser } from '../../src/domain/auth/users';
import { addMember } from '../../src/domain/members';
import { createApp } from '../../src/http/app';
import type { AppEnv } from '../../src/http/env';
import { LoginLimiter } from '../../src/http/rate-limit';
import { type Logger, silentLogger } from '../../src/log';
import { createTestDeps, type TestDeps } from './deps';

export const PUBLIC_URL = 'http://pixeltwin.test';
export const PASSWORD = 'correct horse battery';

/** Auth for a request: a logged-in user's cookie, or a project token. */
export type As = { cookie: string } | { token: string } | null;

export interface TestApp {
  app: OpenAPIHono<AppEnv>;
  deps: TestDeps;
  setup: SetupState;
  close(): Promise<void>;
  /** Sends a request; JSON bodies are serialized, cookie requests get the right Origin header. */
  request(
    method: string,
    path: string,
    options?: {
      as?: As;
      json?: unknown;
      body?: string | FormData | Uint8Array<ArrayBuffer>;
      headers?: Record<string, string>;
    },
  ): Promise<Response>;
  /**
   * Creates a user with `role` and logs them in. A non-admin becomes a member, with that role, of
   * `projects` (slugs; by default every project that exists now, as after migration 0014).
   */
  userAs(role: UserRole, email?: string, options?: { projects?: string[] }): Promise<{ cookie: string; id: string }>;
  tokenAs(projectSlug: string, scopes: TokenScope[]): Promise<{ token: string; id: string }>;
}

export async function createTestApp(
  options: {
    setupToken?: string | null;
    maxImageBytes?: number;
    diffQueueMax?: number;
    logger?: Logger;
    loginLimiter?: LoginLimiter;
  } = {},
): Promise<TestApp> {
  const deps = await createTestDeps();
  const setup = new SetupState(options.setupToken ?? null);
  const app = createApp({
    deps,
    config: {
      publicUrl: PUBLIC_URL,
      maxImageBytes: options.maxImageBytes ?? deps.limits.maxImageBytes,
      diffQueueMax: options.diffQueueMax ?? 0,
      diffWorkers: 1,
    },
    logger: options.logger ?? silentLogger,
    setup,
    loginLimiter: options.loginLimiter ?? new LoginLimiter(),
  });

  const request: TestApp['request'] = async (method, path, opts = {}) => {
    const headers: Record<string, string> = { ...opts.headers };
    if (opts.as && 'cookie' in opts.as) {
      headers.cookie = `pt_session=${opts.as.cookie}`;
      headers.origin ??= PUBLIC_URL;
    }
    if (opts.as && 'token' in opts.as) headers.authorization = `Bearer ${opts.as.token}`;
    let body = opts.body;
    if (opts.json !== undefined) {
      headers['content-type'] ??= 'application/json';
      body = JSON.stringify(opts.json);
    }
    return app.request(path, { method, headers, body });
  };

  let users = 0;
  return {
    app,
    deps,
    setup,
    close: () => deps.handle.close(),
    request,
    async userAs(role, email = `${role}${++users}@example.com`, options = {}) {
      const user = await createUser(deps, { email, password: PASSWORD, role });
      if (role !== 'admin') {
        const slugs =
          options.projects ?? (await deps.db.selectFrom('projects').select('slug').execute()).map((p) => p.slug);
        for (const slug of slugs) await addMember(deps, slug, { email, role });
      }
      const res = await request('POST', '/api/v1/auth/login', { json: { email, password: PASSWORD } });
      const cookie = /pt_session=([^;]+)/.exec(res.headers.get('set-cookie') ?? '')?.[1];
      if (!cookie) throw new Error(`login failed: ${res.status} ${await res.text()}`);
      return { cookie, id: user.id };
    },
    async tokenAs(projectSlug, scopes) {
      const { token, view } = await createProjectToken(deps, projectSlug, { name: 'test', scopes });
      return { token, id: view.id };
    },
  };
}

/** Parses a problem+json response and checks its shape. */
export async function problemOf(
  res: Response,
): Promise<{ status: number; code: string; detail: string; errors?: Array<{ path: string }> }> {
  if (res.headers.get('content-type') !== 'application/problem+json') {
    throw new Error(`expected problem+json, got ${res.status} ${res.headers.get('content-type')}: ${await res.text()}`);
  }
  return res.json() as Promise<{ status: number; code: string; detail: string }>;
}
