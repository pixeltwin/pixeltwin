import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { z } from '@hono/zod-openapi';
import { createArea } from '../../src/domain/areas';
import type { RoutePermission } from '../../src/domain/auth/policy';
import { createProjectToken } from '../../src/domain/auth/tokens';
import { inviteToProject } from '../../src/domain/invites';
import { addMember } from '../../src/domain/members';
import { createProject } from '../../src/domain/projects';
import { requestAccess, updateSignupSettings } from '../../src/domain/signup';
import { openApiDocument } from '../../src/http/docs';
import { API } from '../../src/http/env';
import { defineRoute } from '../../src/http/route';
import { createTestApp, PASSWORD, problemOf, type TestApp } from '../helpers/app';
import { makePng } from '../helpers/png';
import { openBuild, submit } from '../helpers/scenario';
import { postForm } from '../helpers/ui';

/**
 * Routes that name no single project. Every other route is project-scoped and must answer a user
 * outside the project exactly as if the project (build, check, image) did not exist. A new route
 * lands here only after a thought about who may see what it answers.
 */
const NOT_PROJECT_SCOPED = new Set([
  'GET /healthz',
  'POST /api/v1/setup',
  'POST /api/v1/auth/login',
  'POST /api/v1/auth/token',
  'POST /api/v1/auth/logout',
  'GET /api/v1/me',
  'PUT /api/v1/me/password',
  'GET /api/v1/users',
  'POST /api/v1/users',
  'PATCH /api/v1/users/:id',
  'DELETE /api/v1/users/:id',
  'GET /api/v1/users/:id/projects',
  'POST /api/v1/users/:id/reset-link',
  // Server invites are for admins (user.admin); invites by id are project-scoped below.
  'POST /api/v1/invites',
  'GET /api/v1/invites',
  // One-time links: public, the token is the credential.
  'GET /api/v1/links/:token',
  // Sign-up: public, and admin (user.admin) for requests and settings.
  'POST /api/v1/signup',
  'POST /api/v1/signup/verify/:token',
  'GET /api/v1/access-requests',
  'POST /api/v1/access-requests/:id/approve',
  'POST /api/v1/access-requests/:id/reject',
  'GET /api/v1/settings/signup',
  'PUT /api/v1/settings/signup',
  'POST /api/v1/links/:token',
  // Inbound code host webhooks: public, authenticated by the project's webhook secret (signature or
  // token), and they answer the same whether or not a project matches the repository.
  'POST /api/v1/integrations/github/webhook',
  'POST /api/v1/integrations/gitlab/webhook',
  // Lists only what the caller can see (asserted below).
  'GET /api/v1/projects',
  'POST /api/v1/projects',
  'GET /openapi.json',
  'GET /docs',
  'GET /docs/scalar.js',
  'GET /llms.txt',
  'GET /',
  'GET /favicon.ico',
  'GET /ui/assets/app.css',
  'GET /ui/assets/favicon.svg',
  'GET /ui/assets/:file{[a-z0-9-]+\\.js}',
  'GET /ui/login',
  'POST /ui/login',
  'POST /ui/logout',
  'GET /ui/setup',
  'POST /ui/setup',
  'POST /ui/theme',
  // Lists only what the caller can see (asserted below).
  'GET /ui',
  'GET /ui/projects/new',
  'POST /ui/projects',
  'GET /ui/admin/users',
  'GET /ui/admin/users/new',
  'POST /ui/admin/users',
  'POST /ui/admin/users/:id',
  'POST /ui/admin/users/:id/delete',
  'POST /ui/admin/users/:id/reset-link',
  'GET /ui/admin/invites/new',
  'POST /ui/admin/invites',
  'POST /ui/admin/invites/:id/resend',
  'POST /ui/admin/invites/:id/delete',
  // One-time link pages: public, the token is the credential.
  'GET /ui/invite/:token',
  'POST /ui/invite/:token',
  'GET /ui/reset/:token',
  'POST /ui/reset/:token',
  'GET /ui/verify/:token',
  'POST /ui/verify/:token',
  'GET /ui/signup',
  'POST /ui/signup',
  'POST /ui/admin/signup',
  'POST /ui/admin/requests/:id/approve',
  'POST /ui/admin/requests/:id/reject',
]);

const PROJECT_SCOPED = /:slug\b|^\/api\/v1\/(builds|checks|images|invites)\/|^\/ui\/(builds|checks)\//;

function routesOf(t: TestApp): Array<{ method: string; path: string }> {
  const seen = new Set<string>();
  return t.app.routes
    .filter((r) => r.method !== 'ALL')
    .map((r) => ({ method: r.method, path: r.path }))
    .filter((r) => !seen.has(`${r.method} ${r.path}`) && seen.add(`${r.method} ${r.path}`));
}

function fill(path: string, values: Record<string, string>): string {
  return path.replace(/:(\w+)/g, (_, name: string) => encodeURIComponent(values[name] ?? 'missing'));
}

describe('project access for users', () => {
  let t: TestApp;
  let outsider: { cookie: string; id: string };
  let hidden: Record<string, string>;
  let missing: Record<string, string>;
  let permissions: Map<string, RoutePermission>;
  let hiddenProjectId: string;
  const usersByEmail = (email: string) =>
    t.deps.db.selectFrom('users').select('id').where('email', '=', email).executeTakeFirstOrThrow();

  beforeAll(async () => {
    t = await createTestApp();
    // The secret project, with everything a route can name: a build, a check, an area, a token, a member.
    hiddenProjectId = (await createProject(t.deps, { slug: 'secret', name: 'Secret launch' })).id;
    const buildId = await openBuild(t.deps, 'secret');
    const { check } = await submit(t.deps, buildId, makePng(12, 12));
    const { area } = await createArea(t.deps, check.id, 'usr_seed', {
      kind: 'ignore',
      x: 0,
      y: 0,
      width: 2,
      height: 2,
    });
    const { view: token } = await createProjectToken(t.deps, 'secret', { name: 'ci', scopes: ['read'] });
    const member = await t.userAs('reviewer', 'member@example.com', { projects: ['secret'] });
    const invite = await inviteToProject(t.deps, 'secret', { email: 'later@example.com' }, member.id);
    if (invite.kind !== 'invite') throw new Error('expected an invite');
    // The outsider maintains another project: a role elsewhere must not open this one.
    await createProject(t.deps, { slug: 'other', name: 'Other' });
    outsider = await t.userAs('reviewer', 'outsider@example.com', { projects: [] });
    await addMember(t.deps, 'other', { email: 'outsider@example.com', role: 'maintainer' });

    const base = { snapshotKey: check.snapshotKey, branch: 'feature/x', areaId: area.id, userId: member.id };
    hidden = { ...base, slug: 'secret', sha: check.imageSha, build: buildId, check: check.id, token: token.id };
    missing = {
      ...base,
      slug: 'nope',
      sha: 'f'.repeat(64),
      build: 'bld_missing',
      check: 'chk_missing',
      token: 'tok_x',
    };
    permissions = new Map();
    for (const [path, item] of Object.entries(openApiDocument(t.app).paths ?? {})) {
      for (const [method, op] of Object.entries(item as Record<string, { 'x-permission': RoutePermission }>)) {
        permissions.set(`${method.toUpperCase()} ${path.replace(/\{(\w+)\}/g, ':$1')}`, op['x-permission']);
      }
    }
  });

  afterAll(async () => {
    await t.close();
  });

  const idsFor = (path: string, values: Record<string, string>) => ({
    ...values,
    id: /\/(builds)\//.test(path)
      ? values.build
      : /\/checks\//.test(path)
        ? values.check
        : /\/invites\//.test(path)
          ? values.invite
          : values.token,
  });

  async function send(method: string, path: string, values: Record<string, string>, as = outsider) {
    const url = fill(path, idsFor(path, values));
    if (path.startsWith('/ui/')) {
      return method === 'GET' ? t.request('GET', url, { as }) : postForm(t, url, {}, as);
    }
    return t.request(method, url, { as, json: method === 'GET' ? undefined : {} });
  }

  test('every route is either project-scoped or listed as not', () => {
    const unclassified = routesOf(t)
      .map((r) => `${r.method} ${r.path}`)
      .filter((key) => !PROJECT_SCOPED.test(key.split(' ')[1] ?? '') && !NOT_PROJECT_SCOPED.has(key));
    expect(unclassified).toEqual([]);
  });

  test('a user outside the project gets what a missing project gives, on every project-scoped route', async () => {
    const scoped = routesOf(t).filter((r) => PROJECT_SCOPED.test(r.path));
    expect(scoped.length).toBeGreaterThanOrEqual(50);
    for (const { method, path } of scoped) {
      const op = `${method} ${path}`;
      const [seen, absent] = [await send(method, path, hidden), await send(method, path, missing)];
      // Deleting a project needs a server admin: refused before the project is looked at.
      const expected = permissions.get(op) === 'server.admin' ? 403 : 404;
      expect({ op, status: seen.status }).toEqual({ op, status: expected });
      expect({ op, status: absent.status }).toEqual({ op, status: expected });
      if (path.startsWith('/ui/')) {
        const title = (res: string) => /<title>([^<]*)<\/title>/.exec(res)?.[1];
        expect({ op, title: title(await seen.text()) }).toEqual({ op, title: title(await absent.text()) });
        continue;
      }
      const [a, b] = [await problemOf(seen), await problemOf(absent)];
      const ids = (values: Record<string, string>) => [
        values.slug,
        values.build,
        values.check,
        values.sha,
        values.token,
        values.invite,
      ];
      let detail = a.detail;
      for (const [i, value] of ids(hidden).entries()) detail = detail.replaceAll(value ?? '', ids(missing)[i] ?? '');
      expect({ op, code: a.code, detail }).toEqual({ op, code: b.code, detail: b.detail });
    }
  });

  test('a sign-up waiting for approval learns nothing on any route, even as a member', async () => {
    await updateSignupSettings(t.deps, { mode: 'approval', domains: '' });
    await requestAccess(t.deps, { email: 'pending@example.com', password: PASSWORD }, { verify: false });
    // Even a membership (added behind the admin's back) must not open anything before approval.
    await t.deps.db
      .insertInto('projectMembers')
      .values({
        projectId: hiddenProjectId,
        userId: (await usersByEmail('pending@example.com')).id,
        role: 'maintainer',
        createdAt: 1,
      })
      .execute();
    const login = await t.request('POST', '/api/v1/auth/login', {
      json: { email: 'pending@example.com', password: PASSWORD },
    });
    expect(login.status).toBe(200);
    const pending = { cookie: /pt_session=([^;]+)/.exec(login.headers.get('set-cookie') ?? '')?.[1] ?? '', id: '' };
    for (const { method, path } of routesOf(t)) {
      const op = `${method} ${path}`;
      if (NOT_PROJECT_SCOPED.has(op) && !['GET /api/v1/projects', 'GET /ui'].includes(op)) continue;
      const [seen, absent] = [await send(method, path, hidden, pending), await send(method, path, missing, pending)];
      expect({ op, status: seen.status }).toEqual({ op, status: 403 });
      expect({ op, status: absent.status }).toEqual({ op, status: 403 });
      if (path === '/ui' || path.startsWith('/ui/')) {
        const text = await seen.text();
        expect({ op, waiting: text.includes('Waiting for an admin to approve your access') }).toEqual({
          op,
          waiting: true,
        });
        // The page echoes only the address asked for (in the theme form), never the project.
        expect({ op, leaks: text.includes('Secret launch') }).toEqual({ op, leaks: false });
      } else {
        expect({ op, code: (await problemOf(seen)).code }).toEqual({ op, code: 'account_pending' });
      }
    }
    expect((await t.request('GET', '/api/v1/me', { as: pending })).status).toBe(200);
  });

  test('project lists show only what the user can see', async () => {
    const api = (await (await t.request('GET', '/api/v1/projects', { as: outsider })).json()) as {
      items: Array<{ slug: string }>;
    };
    expect(api.items.map((p) => p.slug)).toEqual(['other']);
    const page = await (await t.request('GET', '/ui', { as: outsider })).text();
    expect(page).toContain('/ui/p/other');
    expect(page).not.toContain('secret');
    expect(page).not.toContain('Secret launch');
  });
});

describe('fail closed', () => {
  test('a project route that forgets to check the project answers 500, not the data', async () => {
    const t = await createTestApp();
    try {
      await createProject(t.deps, { slug: 'web', name: 'Web' });
      // No project in the path, so no automatic check, and the handler forgets its own.
      const forgetful = defineRoute('project.read', {
        method: 'get',
        path: `${API}/forgetful`,
        responses: { 200: { description: 'oops', content: { 'application/json': { schema: z.object({}) } } } },
      });
      t.app.openapi(forgetful, (c) => c.json({}, 200));
      t.app.get('/ui/p/:slug/forgetful', (c) => c.text('oops'));
      const viewer = await t.userAs('viewer');
      const admin = await t.userAs('admin');
      for (const as of [viewer, admin]) {
        expect((await t.request('GET', `${API}/forgetful`, { as })).status).toBe(500);
        expect((await t.request('GET', '/ui/p/web/forgetful', { as })).status).toBe(500);
      }
    } finally {
      await t.close();
    }
  });
});
