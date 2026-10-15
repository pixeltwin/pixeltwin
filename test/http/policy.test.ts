import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { USER_ROLES } from '../../src/db/schema';
import { PERMISSIONS, POLICY, type RoutePermission } from '../../src/domain/auth/policy';
import { TOKEN_SCOPES } from '../../src/domain/auth/tokens';
import { createProject } from '../../src/domain/projects';
import { openApiDocument } from '../../src/http/docs';
import { createTestApp, problemOf, type TestApp } from '../helpers/app';
import { makePng } from '../helpers/png';

/** Public routes served outside openapi.json. Anything else under the app must be documented. */
const UNDOCUMENTED_PUBLIC = ['/healthz', '/openapi.json', '/docs', '/docs/scalar.js', '/llms.txt'];

interface Operation {
  method: string;
  path: string;
  permission: RoutePermission;
}

function operations(t: TestApp): Operation[] {
  const doc = openApiDocument(t.app);
  return Object.entries(doc.paths ?? {}).flatMap(([path, item]) =>
    Object.entries(item as Record<string, { 'x-permission'?: RoutePermission }>).map(([method, op]) => ({
      method: method.toUpperCase(),
      path,
      permission: op['x-permission'] as RoutePermission,
    })),
  );
}

/** Fills `{param}` placeholders. */
function fill(path: string, values: Record<string, string> = {}): string {
  return path.replace(/\{(\w+)\}/g, (_, name: string) => encodeURIComponent(values[name] ?? 'missing'));
}

describe('authorization policy', () => {
  let t: TestApp;
  let ops: Operation[];

  beforeAll(async () => {
    t = await createTestApp();
    ops = operations(t);
  });

  afterAll(async () => {
    await t.close();
  });

  test('every documented operation declares a permission', () => {
    expect(ops.length).toBeGreaterThanOrEqual(30);
    const valid = new Set<string>([...PERMISSIONS, 'session', 'public']);
    expect(ops.filter((op) => !valid.has(op.permission))).toEqual([]);
  });

  test('every API route is documented', () => {
    const documented = new Set(ops.map((op) => `${op.method} ${op.path}`));
    const served = t.app.routes
      .filter((r) => r.method !== 'ALL')
      .map((r) => `${r.method} ${r.path.replace(/:(\w+)/g, '{$1}')}`)
      .filter((key) => !UNDOCUMENTED_PUBLIC.some((p) => key.endsWith(` ${p}`)));
    expect(served.filter((key) => !documented.has(key))).toEqual([]);
  });

  test('protected operations answer 401 without credentials', async () => {
    for (const op of ops.filter((o) => o.permission !== 'public')) {
      const res = await t.request(op.method, fill(op.path), { json: op.method === 'GET' ? undefined : {} });
      expect({ op: `${op.method} ${op.path}`, status: res.status }).toEqual({
        op: `${op.method} ${op.path}`,
        status: 401,
      });
    }
  });

  test('roles get exactly the permissions of spec §7.3', async () => {
    for (const role of USER_ROLES) {
      const user = await t.userAs(role);
      for (const op of ops.filter((o) => (PERMISSIONS as readonly string[]).includes(o.permission))) {
        const res = await t.request(op.method, fill(op.path), { as: user, json: op.method === 'GET' ? undefined : {} });
        const forbidden = res.status === 403 && (await problemOf(res)).code === 'forbidden';
        const allowed = POLICY[op.permission as (typeof PERMISSIONS)[number]].roles.includes(role);
        expect({ role, op: `${op.method} ${op.path}`, forbidden }).toEqual({
          role,
          op: `${op.method} ${op.path}`,
          forbidden: !allowed,
        });
      }
    }
  });

  test('token scopes get exactly the permissions of spec §7.3', async () => {
    await createProject(t.deps, { slug: 'scopes', name: 'Scopes' });
    for (const scope of TOKEN_SCOPES) {
      const token = await t.tokenAs('scopes', [scope]);
      for (const op of ops.filter((o) => o.permission !== 'public')) {
        const res = await t.request(op.method, fill(op.path, { slug: 'scopes' }), {
          as: token,
          json: op.method === 'GET' ? undefined : {},
        });
        const forbidden = res.status === 403 && (await problemOf(res)).code === 'forbidden';
        const allowed =
          op.permission !== 'session' && POLICY[op.permission as (typeof PERMISSIONS)[number]].scopes.includes(scope);
        expect({ scope, op: `${op.method} ${op.path}`, forbidden }).toEqual({
          scope,
          op: `${op.method} ${op.path}`,
          forbidden: !allowed,
        });
      }
    }
  });
});

describe('project isolation for tokens', () => {
  test("a token with every scope cannot touch another project's resources", async () => {
    const t = await createTestApp();
    try {
      await createProject(t.deps, { slug: 'web', name: 'Web' });
      await createProject(t.deps, { slug: 'app', name: 'App' });
      const web = await t.tokenAs('web', ['read', 'write', 'review']);
      const app = await t.tokenAs('app', ['read', 'write', 'review']);
      const build = (await (await t.request('POST', '/api/v1/projects/web/builds', { as: web, json: {} })).json()) as {
        id: string;
      };
      const check = (await (
        await t.request('POST', `/api/v1/builds/${build.id}/checks`, {
          as: web,
          json: { name: 'home', imageBase64: Buffer.from(makePng(10, 10)).toString('base64') },
        })
      ).json()) as { id: string; snapshotKey: string };

      const values = { slug: 'web', id: build.id, snapshotKey: check.snapshotKey, branch: 'feature/x' };
      const checkIds = { ...values, id: check.id };
      const attempts: Array<[string, string, Record<string, string>]> = [
        ['GET', '/api/v1/projects/{slug}', values],
        ['POST', '/api/v1/projects/{slug}/builds', values],
        ['GET', '/api/v1/projects/{slug}/builds', values],
        ['GET', '/api/v1/builds/{id}', values],
        ['POST', '/api/v1/builds/{id}/finalize', values],
        ['POST', '/api/v1/builds/{id}/approve', values],
        ['POST', '/api/v1/builds/{id}/checks', values],
        ['GET', '/api/v1/builds/{id}/checks', values],
        ['GET', '/api/v1/checks/{id}', checkIds],
        ['POST', '/api/v1/checks/{id}/approve', checkIds],
        ['POST', '/api/v1/checks/{id}/reject', checkIds],
        ['GET', '/api/v1/projects/{slug}/snapshots/{snapshotKey}/baselines', values],
        ['POST', '/api/v1/projects/{slug}/branches/{branch}/promote', values],
      ];
      for (const [method, path, params] of attempts) {
        const res = await t.request(method, fill(path, params), {
          as: app,
          // A body that passes validation, so the project check is what answers.
          json: method === 'GET' ? undefined : path.endsWith('/checks') ? { name: 'x', imageBase64: 'AAAA' } : {},
        });
        const code = res.status === 403 ? (await problemOf(res)).code : String(res.status);
        expect({ op: `${method} ${path}`, code }).toEqual({ op: `${method} ${path}`, code: 'token_project_mismatch' });
      }
    } finally {
      await t.close();
    }
  });
});
