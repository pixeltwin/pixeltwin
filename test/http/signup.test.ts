import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createProject } from '../../src/domain/projects';
import { LoginLimiter } from '../../src/http/rate-limit';
import { smtpMailer } from '../../src/mail/smtp';
import { createTestApp, PASSWORD, problemOf, type TestApp } from '../helpers/app';
import { fakeSmtp, partOf, waitForMails } from '../helpers/smtp';

type Who = { cookie: string; id: string };

const loginAs = async (t: TestApp, email: string): Promise<Who> => {
  const res = await t.request('POST', '/api/v1/auth/login', { json: { email, password: PASSWORD } });
  return { cookie: /pt_session=([^;]+)/.exec(res.headers.get('set-cookie') ?? '')?.[1] ?? '', id: '' };
};

describe('sign-up (API)', () => {
  let t: TestApp;
  let admin: Who;

  beforeEach(async () => {
    t = await createTestApp();
    await createProject(t.deps, { slug: 'mobile', name: 'Mobile app' });
    admin = await t.userAs('admin', 'root@example.com');
  });

  afterEach(async () => {
    await t.close();
  });

  const signup = (json: Record<string, unknown>) =>
    t.request('POST', '/api/v1/signup', { json: { password: PASSWORD, ...json } });

  test('is off until an admin turns it on, with allowed domains', async () => {
    expect(await problemOf(await signup({ email: 'carol@example.com' }))).toMatchObject({
      status: 404,
      code: 'signup_closed',
    });
    const viewer = await t.userAs('viewer');
    expect(
      (await t.request('PUT', '/api/v1/settings/signup', { as: viewer, json: { mode: 'approval', domains: [] } }))
        .status,
    ).toBe(403);
    const put = await t.request('PUT', '/api/v1/settings/signup', {
      as: admin,
      json: { mode: 'approval', domains: ['example.com'] },
    });
    expect(await put.json()).toEqual({ mode: 'approval', domains: ['example.com'] });
    expect(await problemOf(await signup({ email: 'eve@elsewhere.org' }))).toMatchObject({
      status: 422,
      code: 'signup_refused',
      detail: 'Sign-ups are not accepted for this email address.',
    });
  });

  test('the answer is the same for a new and an existing email', async () => {
    await t.request('PUT', '/api/v1/settings/signup', { as: admin, json: { mode: 'approval', domains: [] } });
    const fresh = await signup({ email: 'carol@example.com', note: 'Need the mobile app' });
    const existing = await signup({ email: 'root@example.com' });
    expect([fresh.status, existing.status]).toEqual([202, 202]);
    expect(await fresh.json()).toEqual(await existing.json());
    const requests = (await (await t.request('GET', '/api/v1/access-requests', { as: admin })).json()) as {
      items: Array<{ email: string; verified: boolean; note: string }>;
    };
    expect(requests.items).toMatchObject([
      { email: 'carol@example.com', verified: false, note: 'Need the mobile app' },
    ]);
  });

  test('a pending user is blocked everywhere but me and logout, until approved', async () => {
    await t.request('PUT', '/api/v1/settings/signup', { as: admin, json: { mode: 'approval', domains: [] } });
    await signup({ email: 'carol@example.com' });
    const carol = await loginAs(t, 'carol@example.com');
    expect(await problemOf(await t.request('GET', '/api/v1/projects', { as: carol }))).toMatchObject({
      status: 403,
      code: 'account_pending',
    });
    expect(await (await t.request('GET', '/api/v1/me', { as: carol })).json()).toMatchObject({ status: 'pending' });
    const [request] = (
      (await (await t.request('GET', '/api/v1/access-requests', { as: admin })).json()) as {
        items: Array<{ id: string }>;
      }
    ).items;
    const approved = await t.request('POST', `/api/v1/access-requests/${request?.id}/approve`, {
      as: admin,
      json: { role: 'viewer', projects: [{ slug: 'mobile', role: 'reviewer' }] },
    });
    expect(await approved.json()).toMatchObject({ status: 'approved', decidedBy: 'root@example.com' });
    const projects = (await (await t.request('GET', '/api/v1/projects', { as: carol })).json()) as {
      items: Array<{ slug: string }>;
    };
    expect(projects.items.map((p) => p.slug)).toEqual(['mobile']);
  });

  test('a rejected user sees only that; maintainers cannot decide requests', async () => {
    await t.request('PUT', '/api/v1/settings/signup', { as: admin, json: { mode: 'approval', domains: [] } });
    await signup({ email: 'dan@example.com' });
    const [request] = (
      (await (await t.request('GET', '/api/v1/access-requests', { as: admin })).json()) as {
        items: Array<{ id: string }>;
      }
    ).items;
    const maintainer = await t.userAs('viewer', 'maint@example.com', { projects: [] });
    await t.request('POST', '/api/v1/projects/mobile/members', {
      as: admin,
      json: { email: 'maint@example.com', role: 'maintainer' },
    });
    expect((await t.request('POST', `/api/v1/access-requests/${request?.id}/approve`, { as: maintainer })).status).toBe(
      403,
    );
    const rejected = await t.request('POST', `/api/v1/access-requests/${request?.id}/reject`, {
      as: admin,
      json: { reason: 'Not on the team' },
    });
    expect(await rejected.json()).toMatchObject({ status: 'rejected', reason: 'Not on the team' });
    const dan = await loginAs(t, 'dan@example.com');
    expect(await problemOf(await t.request('GET', '/api/v1/projects', { as: dan }))).toMatchObject({
      code: 'account_rejected',
    });
    // A pending or rejected account cannot be made a member.
    expect(
      await problemOf(
        await t.request('POST', '/api/v1/projects/mobile/members', { as: admin, json: { email: 'dan@example.com' } }),
      ),
    ).toMatchObject({
      code: 'account_pending',
    });
  });
});

describe('sign-up limits and mail', () => {
  test('sign-ups are limited like logins', async () => {
    const t = await createTestApp({ loginLimiter: new LoginLimiter({ perIpEmail: 2 }) });
    try {
      const admin = await t.userAs('admin');
      await t.request('PUT', '/api/v1/settings/signup', { as: admin, json: { mode: 'approval', domains: [] } });
      const statuses = [];
      for (let i = 0; i < 3; i++) {
        statuses.push(
          (await t.request('POST', '/api/v1/signup', { json: { email: 'x@example.com', password: PASSWORD } })).status,
        );
      }
      expect(statuses).toEqual([202, 202, 429]);
    } finally {
      await t.close();
    }
  });

  test('with SMTP: confirm the email first, admins hear of it, the owner of an existing email is told', async () => {
    const smtp = await fakeSmtp();
    const t = await createTestApp({ mailer: smtpMailer({ url: smtp.url, from: 'pt@example.com' }) });
    try {
      const admin = await t.userAs('admin', 'root@example.com');
      await t.request('PUT', '/api/v1/settings/signup', { as: admin, json: { mode: 'approval', domains: [] } });
      const res = await t.request('POST', '/api/v1/signup', {
        json: { email: 'carol@example.com', password: PASSWORD },
      });
      expect(await res.json()).toEqual({ status: 'received', verifyEmail: true });
      await waitForMails(smtp.mails, 1);
      const link = /\/ui\/verify\/([A-Za-z0-9_-]+)/.exec(partOf(smtp.mails[0]?.data ?? '', 'text/plain'))?.[1] ?? '';
      expect(link).not.toBe('');
      const list = async () =>
        ((await (await t.request('GET', '/api/v1/access-requests', { as: admin })).json()) as { items: unknown[] })
          .items;
      expect(await list()).toEqual([]);

      expect((await t.request('POST', `/api/v1/signup/verify/${link}`)).status).toBe(200);
      expect(await list()).toHaveLength(1);
      await waitForMails(smtp.mails, 2);
      expect(smtp.mails[1]).toMatchObject({ to: ['root@example.com'] });
      expect(smtp.mails[1]?.data).toContain('Subject: Someone asks for access to pixeltwin');

      await t.request('POST', '/api/v1/signup', { json: { email: 'root@example.com', password: PASSWORD } });
      await waitForMails(smtp.mails, 3);
      expect(smtp.mails[2]).toMatchObject({ to: ['root@example.com'] });
      expect(smtp.mails[2]?.data).toContain('Subject: You already have a pixeltwin account');
    } finally {
      await t.close();
      await smtp.close();
    }
  });
});
