import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createProject } from '../../src/domain/projects';
import { LoginLimiter } from '../../src/http/rate-limit';
import { createLogger } from '../../src/log';
import { formatMessage, smtpMailer } from '../../src/mail/smtp';
import { createTestApp, problemOf, type TestApp } from '../helpers/app';
import { fakeSmtp, partOf, waitForMails } from '../helpers/smtp';

type Who = { cookie: string; id: string };
const NEW_PASSWORD = 'a brand new password';

const tokenOf = (link: string) => link.split('/').at(-1) ?? '';

describe('invites (API)', () => {
  let t: TestApp;
  let admin: Who;
  let maintainer: Who;
  let reviewer: Who;
  let lines: string[];

  beforeEach(async () => {
    lines = [];
    t = await createTestApp({ logger: createLogger('debug', (line) => lines.push(line)) });
    await createProject(t.deps, { slug: 'web', name: 'Web shop' });
    await createProject(t.deps, { slug: 'app', name: 'App' });
    admin = await t.userAs('admin');
    maintainer = await t.userAs('viewer', 'maint@example.com', { projects: [] });
    reviewer = await t.userAs('reviewer', 'rev@example.com', { projects: ['web'] });
    await t.request('POST', '/api/v1/projects/web/members', {
      as: admin,
      json: { email: 'maint@example.com', role: 'maintainer' },
    });
  });

  afterEach(async () => {
    await t.close();
  });

  const inviteWeb = async (as: Who, json: unknown) => t.request('POST', '/api/v1/projects/web/invites', { as, json });

  test('a maintainer invites into their project; the link creates the account and logs in', async () => {
    const res = await inviteWeb(maintainer, { email: 'new@example.com', role: 'reviewer' });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { kind: string; link: string; mailed: boolean; invite: { id: string } };
    expect(body).toMatchObject({
      kind: 'invite',
      mailed: false,
      invite: { email: 'new@example.com', projectRole: 'reviewer' },
    });
    expect(body.link).toStartWith('http://pixeltwin.test/ui/invite/');
    const listed = await t.request('GET', '/api/v1/projects/web/invites', { as: maintainer });
    expect(JSON.stringify(await listed.json())).not.toContain(tokenOf(body.link));

    // Public: no session, no Origin.
    const described = await t.request('GET', `/api/v1/links/${tokenOf(body.link)}`);
    expect(await described.json()).toMatchObject({
      purpose: 'invite',
      email: 'new@example.com',
      projects: ['Web shop'],
    });
    const accepted = await t.request('POST', `/api/v1/links/${tokenOf(body.link)}`, {
      json: { password: NEW_PASSWORD },
    });
    expect(accepted.status).toBe(201);
    const cookie = /pt_session=([^;]+)/.exec(accepted.headers.get('set-cookie') ?? '')?.[1] ?? '';
    const projects = await t.request('GET', '/api/v1/projects', { as: { cookie } });
    expect(((await projects.json()) as { items: Array<{ slug: string }> }).items.map((p) => p.slug)).toEqual(['web']);
    expect(
      await problemOf(
        await t.request('POST', `/api/v1/links/${tokenOf(body.link)}`, { json: { password: NEW_PASSWORD } }),
      ),
    ).toMatchObject({
      status: 410,
      code: 'link_used',
    });
    // Neither the token nor the link reached the log.
    expect(lines.join('\n')).not.toContain(tokenOf(body.link));
    expect(lines.some((l) => l.includes('/api/v1/links/…'))).toBe(true);
  });

  test('an email with an account is just added, with no link', async () => {
    const res = await inviteWeb(maintainer, { email: 'rev@example.com', role: 'reviewer' });
    const extra = await t.userAs('viewer', 'extra@example.com', { projects: [] });
    const added = await inviteWeb(maintainer, { email: 'extra@example.com' });
    expect(res.status).toBe(409);
    expect(added.status).toBe(200);
    expect(await added.json()).toMatchObject({ kind: 'member', member: { userId: extra.id, role: 'viewer' } });
  });

  test('who may invite, revoke and resend', async () => {
    expect((await inviteWeb(reviewer, { email: 'x@example.com' })).status).toBe(403);
    expect(
      (await t.request('POST', '/api/v1/projects/app/invites', { as: maintainer, json: { email: 'x@example.com' } }))
        .status,
    ).toBe(404);
    expect((await inviteWeb(maintainer, { email: 'x@example.com', role: 'admin' })).status).toBe(422);
    expect(
      (await t.request('POST', '/api/v1/invites', { as: maintainer, json: { email: 'x@example.com' } })).status,
    ).toBe(403);
    expect((await t.request('GET', '/api/v1/invites', { as: maintainer })).status).toBe(403);
    const token = await t.tokenAs('web', ['read', 'write', 'review']);
    expect((await inviteWeb(token as unknown as Who, { email: 'x@example.com' })).status).toBe(403);

    const server = await t.request('POST', '/api/v1/invites', {
      as: admin,
      json: { email: 'boss@example.com', role: 'admin' },
    });
    const serverInvite = ((await server.json()) as { invite: { id: string } }).invite.id;
    const web = (await (await inviteWeb(maintainer, { email: 'x@example.com' })).json()) as {
      invite: { id: string };
      link: string;
    };
    const app = (await (
      await t.request('POST', '/api/v1/projects/app/invites', { as: admin, json: { email: 'y@example.com' } })
    ).json()) as {
      invite: { id: string };
    };
    // A maintainer of web: their invites only; others are as if they did not exist.
    expect((await t.request('DELETE', `/api/v1/invites/${app.invite.id}`, { as: maintainer })).status).toBe(404);
    expect((await t.request('DELETE', `/api/v1/invites/${serverInvite}`, { as: maintainer })).status).toBe(404);
    expect((await t.request('DELETE', '/api/v1/invites/lnk_missing', { as: maintainer })).status).toBe(404);
    const resent = await t.request('POST', `/api/v1/invites/${web.invite.id}/resend`, { as: maintainer });
    expect(resent.status).toBe(201);
    const fresh = (await resent.json()) as { invite: { id: string }; link: string };
    expect(fresh.link).not.toBe(web.link);
    expect((await t.request('GET', `/api/v1/links/${tokenOf(web.link)}`)).status).toBe(404);
    expect((await t.request('DELETE', `/api/v1/invites/${fresh.invite.id}`, { as: maintainer })).status).toBe(204);
    expect((await t.request('GET', `/api/v1/links/${tokenOf(fresh.link)}`)).status).toBe(404);
    expect((await t.request('DELETE', `/api/v1/invites/${serverInvite}`, { as: admin })).status).toBe(204);
    const all = (await (await t.request('GET', '/api/v1/invites', { as: admin })).json()) as {
      items: Array<{ email: string }>;
    };
    expect(all.items.map((i) => i.email)).toEqual(['y@example.com']);
  });

  test('admins get a one-time reset link for a user', async () => {
    const res = await t.request('POST', `/api/v1/users/${reviewer.id}/reset-link`, { as: admin });
    const { link } = (await res.json()) as { link: string };
    expect(link).toStartWith('http://pixeltwin.test/ui/reset/');
    expect((await t.request('POST', `/api/v1/users/${reviewer.id}/reset-link`, { as: maintainer })).status).toBe(403);
    const fresh = await t.request('POST', `/api/v1/users/${reviewer.id}/reset-link`, { as: admin });
    const newer = ((await fresh.json()) as { link: string }).link;
    expect(
      (await t.request('POST', `/api/v1/links/${tokenOf(link)}`, { json: { password: NEW_PASSWORD } })).status,
    ).toBe(404);
    expect(
      (await t.request('POST', `/api/v1/links/${tokenOf(newer)}`, { json: { password: NEW_PASSWORD } })).status,
    ).toBe(201);
    // The old session ended with the reset.
    expect((await t.request('GET', '/api/v1/me', { as: reviewer })).status).toBe(401);
  });
});

describe('one-time links are rate-limited like logins', () => {
  test('per IP', async () => {
    const t = await createTestApp({ loginLimiter: new LoginLimiter({ perIpEmail: 3 }) });
    try {
      const statuses = [];
      for (let i = 0; i < 4; i++) statuses.push((await t.request('GET', `/api/v1/links/nope${i}`)).status);
      expect(statuses).toEqual([404, 404, 404, 429]);
    } finally {
      await t.close();
    }
  });
});

describe('mail', () => {
  test('invites and reset links are mailed when SMTP is set; a failing server never fails the invite', async () => {
    const smtp = await fakeSmtp();
    const t = await createTestApp({ mailer: smtpMailer({ url: smtp.url, from: 'pixeltwin <pt@example.com>' }) });
    try {
      await createProject(t.deps, { slug: 'web', name: 'Web shop' });
      const admin = await t.userAs('admin', 'root@example.com');
      const res = await t.request('POST', '/api/v1/projects/web/invites', {
        as: admin,
        json: { email: 'new@example.com' },
      });
      const { link, mailed } = (await res.json()) as { link: string; mailed: boolean };
      expect(mailed).toBe(true);
      await waitForMails(smtp.mails, 1);
      const [mail] = smtp.mails;
      expect(mail).toMatchObject({ from: 'pt@example.com', to: ['new@example.com'], auth: '\0pixel\0secret' });
      expect(mail?.data).toContain('Subject: You are invited to pixeltwin');
      expect(partOf(mail?.data ?? '', 'text/plain')).toContain(link);
      expect(partOf(mail?.data ?? '', 'text/plain')).toContain('root@example.com invited you to Web shop');
      expect(partOf(mail?.data ?? '', 'text/html')).toContain(`href="${link}"`);
    } finally {
      await t.close();
      await smtp.close();
    }

    const broken = await fakeSmtp({ failWith: '554 no' });
    const lines: string[] = [];
    const u = await createTestApp({
      mailer: smtpMailer({ url: broken.url, from: 'pt@example.com', timeoutMs: 2000 }),
      logger: createLogger('debug', (line) => lines.push(line)),
    });
    try {
      await createProject(u.deps, { slug: 'web', name: 'Web' });
      const admin = await u.userAs('admin');
      const res = await u.request('POST', '/api/v1/projects/web/invites', {
        as: admin,
        json: { email: 'new@example.com' },
      });
      expect(res.status).toBe(201);
      const { link } = (await res.json()) as { link: string };
      const until = Date.now() + 3000;
      while (!lines.some((l) => l.includes('mail not sent')) && Date.now() < until) await Bun.sleep(10);
      expect(lines.some((l) => l.includes('mail not sent') && l.includes('554'))).toBe(true);
      expect(lines.join('\n')).not.toContain(tokenOf(link));
    } finally {
      await u.close();
      await broken.close();
    }
  });

  test('messages are multipart, headers cannot be injected, credentials need TLS off localhost', async () => {
    const message = formatMessage('pt@example.com', {
      to: 'a@example.com',
      subject: 'Grüße',
      text: '.dot',
      html: '<p>x</p>',
    });
    expect(message).toContain('Subject: =?UTF-8?B?');
    expect(message).toContain('multipart/alternative');
    expect(() =>
      formatMessage('pt@example.com', { to: 'a@example.com\r\nBcc: b@x', subject: 's', text: '', html: '' }),
    ).toThrow('line break');
    const remote = smtpMailer({ url: 'smtp://u:p@127.0.0.2:1', from: 'pt@example.com', timeoutMs: 500 });
    await expect(remote.send({ to: 'a@example.com', subject: 's', text: '', html: '' })).rejects.toThrow();
  });
});
