import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createProject } from '../../src/domain/projects';
import { requestAccess, updateSignupSettings } from '../../src/domain/signup';
import { createWebhook } from '../../src/domain/webhooks';
import type { WebhookPayload } from '../../src/notify/messages';
import { slackMessage } from '../../src/notify/messages';
import { createTestApp, PASSWORD, type TestApp } from '../helpers/app';
import { startReceiver } from '../helpers/fake-hosts';

describe('member.added webhook', () => {
  let t: TestApp;
  let receiver: ReturnType<typeof startReceiver>;
  let admin: { cookie: string; id: string };

  beforeEach(async () => {
    t = await createTestApp();
    receiver = startReceiver();
    await createProject(t.deps, { slug: 'web', name: 'Web' });
    await createProject(t.deps, { slug: 'other', name: 'Other' });
    admin = await t.userAs('admin', 'root@example.com');
    await createWebhook(t.deps, 'web', { url: receiver.url, events: ['member.added'] });
    // Another project's webhook hears nothing of web's members.
    await createWebhook(t.deps, 'other', { url: receiver.url, events: ['member.added', 'build.finalized'] });
  });

  afterEach(async () => {
    receiver.stop();
    await t.close();
  });

  const payloads = async () => {
    await t.notifier.drain();
    // Sent several at a time: in the order they happened by delivery id (a ULID).
    return receiver.received.map((r) => JSON.parse(r.body) as WebhookPayload).sort((a, b) => a.id.localeCompare(b.id));
  };

  test('adding a member, an accepted invite and an approved sign-up each announce the new member', async () => {
    await t.userAs('viewer', 'bob@example.com', { projects: [] });
    const added = await t.request('POST', '/api/v1/projects/web/members', {
      as: admin,
      json: { email: 'bob@example.com', role: 'reviewer' },
    });
    expect(added.status).toBe(201);

    const invited = await t.request('POST', '/api/v1/projects/web/invites', {
      as: admin,
      json: { email: 'new@example.com', role: 'maintainer' },
    });
    const { link } = (await invited.json()) as { link: string };
    const token = link.split('/').at(-1) ?? '';
    expect((await t.request('POST', `/api/v1/links/${token}`, { json: { password: PASSWORD } })).status).toBe(201);

    await updateSignupSettings(t.deps, { mode: 'approval', domains: '' });
    await requestAccess(t.deps, { email: 'asker@example.com', password: PASSWORD }, { verify: false });
    const [request] = (await (await t.request('GET', '/api/v1/access-requests', { as: admin })).json()).items as Array<{
      id: string;
    }>;
    const approved = await t.request('POST', `/api/v1/access-requests/${request?.id}/approve`, {
      as: admin,
      json: { role: 'viewer', projects: [{ slug: 'web', role: 'viewer' }] },
    });
    expect(approved.status).toBe(200);

    const got = await payloads();
    expect(got.map((p) => [p.event, p.project.slug, p.member?.email, p.member?.role, p.member?.via])).toEqual([
      ['member.added', 'web', 'bob@example.com', 'reviewer', 'member'],
      ['member.added', 'web', 'new@example.com', 'maintainer', 'invite'],
      ['member.added', 'web', 'asker@example.com', 'viewer', 'access_request'],
    ]);
    for (const p of got) expect(p.member?.addedBy).toEqual({ id: admin.id, email: 'root@example.com' });
    expect(slackMessage(got[1] as WebhookPayload).text).toBe(
      'pixeltwin · Web: new@example.com joined by invite as maintainer (invited by root@example.com)',
    );
  });

  test('a webhook without the event hears nothing', async () => {
    await t.deps.db
      .updateTable('webhooks')
      .set({ events: JSON.stringify(['build.finalized']) })
      .execute();
    await t.userAs('viewer', 'bob@example.com', { projects: [] });
    await t.request('POST', '/api/v1/projects/web/members', { as: admin, json: { email: 'bob@example.com' } });
    expect(await payloads()).toEqual([]);
  });
});
