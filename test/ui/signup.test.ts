import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createProject } from '../../src/domain/projects';
import { listAccessRequests, requestAccess, updateSignupSettings } from '../../src/domain/signup';
import { smtpMailer } from '../../src/mail/smtp';
import { createTestApp, PASSWORD, type TestApp } from '../helpers/app';
import { fakeSmtp, partOf, waitForMails } from '../helpers/smtp';
import { html, location, postForm } from '../helpers/ui';

type Who = { cookie: string; id: string };

async function loginForm(t: TestApp, email: string): Promise<Who> {
  const res = await postForm(t, '/ui/login', { email, password: PASSWORD, next: '/ui' });
  return { cookie: /pt_session=([^;]+)/.exec(res.headers.get('set-cookie') ?? '')?.[1] ?? '', id: '' };
}

describe('UI sign-up', () => {
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

  test('the login page offers Request access only when sign-up is on', async () => {
    expect(await html(await t.request('GET', '/ui/login'))).not.toContain('Request access');
    expect((await t.request('GET', '/ui/signup')).status).toBe(404);
    const saved = await postForm(t, '/ui/admin/signup', { mode: 'approval', domains: 'example.com' }, admin);
    expect(location(saved)).toBe('/ui/admin/users?done=signup-saved#signup-title');
    expect(await html(await t.request('GET', '/ui/login'))).toContain('href="/ui/signup">Request access</a>');
    const form = await html(await t.request('GET', '/ui/signup'));
    expect(form).toContain('name="note"');
    expect(form).toContain('autocomplete="new-password"');
  });

  test('request, wait, get approved into a project', async () => {
    await updateSignupSettings(t.deps, { mode: 'approval', domains: 'example.com' });
    const refused = await postForm(t, '/ui/signup', { email: 'eve@else.org', password: PASSWORD });
    expect(refused.status).toBe(422);
    expect(await html(refused)).toContain('Sign-ups are not accepted for this email address.');
    const sent = await postForm(t, '/ui/signup', {
      email: 'carol@example.com',
      password: PASSWORD,
      name: 'Carol',
      note: 'Need the mobile app',
    });
    expect(sent.status).toBe(202);
    expect(await html(sent)).toContain('Request received');
    // An existing email gets the very same page.
    const existing = await postForm(t, '/ui/signup', { email: 'root@example.com', password: PASSWORD });
    expect(existing.status).toBe(202);

    const carol = await loginForm(t, 'carol@example.com');
    for (const path of ['/ui', '/ui/p/mobile', '/ui/admin/users']) {
      const page = await t.request('GET', path, { as: carol });
      expect(page.status).toBe(403);
      const body = await html(page);
      expect(body).toContain('Waiting for an admin to approve your access');
      expect(body).not.toContain('Mobile app');
    }

    const users = await html(await t.request('GET', '/ui/admin/users', { as: admin }));
    expect(users).toContain('<h2 id="requests-title">Access requests');
    expect(users).toContain('Need the mobile app');
    expect(users).toContain('email not verified');
    expect(users).toContain('<span class="count-badge">1');
    const [request] = await listAccessRequests(t.deps, { verifiedOnly: false });
    const approved = await postForm(
      t,
      `/ui/admin/requests/${request?.id}/approve`,
      { role: 'viewer', project: 'mobile', 'role-mobile': 'reviewer' },
      admin,
    );
    expect(location(approved)).toBe('/ui/admin/users?done=request-approved');
    expect(await html(await t.request('GET', '/ui', { as: carol }))).toContain('/ui/p/mobile');
  });

  test('a turned-down request shows its reason', async () => {
    await updateSignupSettings(t.deps, { mode: 'approval', domains: '' });
    await requestAccess(t.deps, { email: 'dan@example.com', password: PASSWORD }, { verify: false });
    const [request] = await listAccessRequests(t.deps, { verifiedOnly: false });
    await postForm(t, `/ui/admin/requests/${request?.id}/reject`, { reason: 'Not on the team' }, admin);
    const dan = await loginForm(t, 'dan@example.com');
    const page = await html(await t.request('GET', '/ui', { as: dan }));
    expect(page).toContain('Your request was turned down');
    expect(page).toContain('Reason: Not on the team');
  });

  test('with SMTP the email is confirmed by a button, not by opening the link', async () => {
    const smtp = await fakeSmtp();
    const u = await createTestApp({ mailer: smtpMailer({ url: smtp.url, from: 'pt@example.com' }) });
    try {
      await updateSignupSettings(u.deps, { mode: 'approval', domains: '' });
      await postForm(u, '/ui/signup', { email: 'carol@example.com', password: PASSWORD });
      await waitForMails(smtp.mails, 1);
      const path = /\/ui\/verify\/[A-Za-z0-9_-]+/.exec(partOf(smtp.mails[0]?.data ?? '', 'text/plain'))?.[0] ?? '';
      const opened = await u.request('GET', path);
      expect(await html(opened)).toContain('Confirm my email');
      expect(await listAccessRequests(u.deps, { verifiedOnly: true })).toEqual([]);
      expect(await html(await postForm(u, path, {}))).toContain('Email confirmed');
      expect((await listAccessRequests(u.deps, { verifiedOnly: true })).map((r) => r.email)).toEqual([
        'carol@example.com',
      ]);
    } finally {
      await u.close();
      await smtp.close();
    }
  });
});
