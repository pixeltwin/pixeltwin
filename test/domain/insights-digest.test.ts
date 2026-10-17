import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { Project } from '../../src/db/schema';
import { createUser } from '../../src/domain/auth/users';
import {
  runDueDigests,
  sendDigestNow,
  setDigestMail,
  slotOf,
  updateDigestSettings,
} from '../../src/domain/insights-digest';
import { addMember, removeMember } from '../../src/domain/members';
import { createWebhook } from '../../src/domain/webhooks';
import type { Mail, Mailer, SendOptions } from '../../src/mail/smtp';
import { slackMessage, type WebhookPayload } from '../../src/notify/messages';
import { createTestApp, type TestApp } from '../helpers/app';
import { seedInsights } from '../helpers/insights';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** A time this week at `hour` local time on the local weekday of `at`. */
function localAt(at: number, hour: number): number {
  const d = new Date(at);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), hour, 0, 0, 0).getTime();
}

describe('digest slots', () => {
  test('the slot is the latest weekday and hour at or before now, in server time', () => {
    const monday9 = new Date(2026, 9, 19, 9, 0, 0).getTime(); // Monday, Oct 19 2026, 09:00 local
    expect(slotOf({ weekday: 1, hour: 9 }, monday9)).toEqual({ key: '2026-10-19T09', at: monday9 });
    expect(slotOf({ weekday: 1, hour: 9 }, monday9 + 30 * 60_000).key).toBe('2026-10-19T09');
    // A minute before it: last week's.
    expect(slotOf({ weekday: 1, hour: 9 }, monday9 - 60_000).key).toBe('2026-10-12T09');
    expect(slotOf({ weekday: 5, hour: 17 }, monday9).key).toBe('2026-10-16T17');
  });
});

describe('weekly digest', () => {
  let t: TestApp;
  let project: Project;
  const mails: Array<{ mail: Mail; options?: SendOptions }> = [];
  const mailer: Mailer = {
    async send(mail, options) {
      // The outbox dedupes by key, as two replicas would see it.
      if (options?.key && mails.some((m) => m.options?.key === options.key)) return;
      mails.push({ mail, ...(options ? { options } : {}) });
    },
  };

  beforeEach(async () => {
    mails.length = 0;
    t = await createTestApp();
    project = await seedInsights(t);
    await createWebhook(t.deps, 'web', {
      url: 'https://hooks.slack.example/services/x',
      events: ['insights.weekly'],
      format: 'slack',
    });
    await createWebhook(t.deps, 'web', { url: 'https://example.com/hook', events: ['build.finalized'] });
  });

  afterEach(async () => {
    await t.close();
  });

  const deliveries = () =>
    t.deps.db.selectFrom('webhookDeliveries').selectAll().where('event', '=', 'insights.weekly').execute();

  test('off by default: nothing is sent', async () => {
    expect(await runDueDigests(t.deps, { publicUrl: 'http://pixeltwin.test', now: Date.now() })).toEqual([]);
    expect(await deliveries()).toEqual([]);
  });

  test('two replicas ticking at the hour send it once, and not again that week', async () => {
    const now = Date.now();
    const slot = localAt(now, new Date(now).getHours());
    await updateDigestSettings(t.deps, project.id, {
      enabled: true,
      weekday: new Date(now).getDay(),
      hour: new Date(now).getHours(),
    });
    const options = { publicUrl: 'http://pixeltwin.test', mailer, now: slot + 60_000 };
    const [a, b] = await Promise.all([runDueDigests(t.deps, options), runDueDigests(t.deps, options)]);
    expect([...a, ...b]).toHaveLength(1);
    expect(await deliveries()).toHaveLength(1);
    // Later ticks of the same hour, and a changed weekday later that week, send nothing.
    expect(await runDueDigests(t.deps, { ...options, now: slot + 20 * 60_000 })).toEqual([]);
    await updateDigestSettings(t.deps, project.id, { weekday: new Date(slot + 2 * DAY).getDay() });
    expect(await runDueDigests(t.deps, { ...options, now: slot + 2 * DAY + 60_000 })).toEqual([]);
    // A week on, the next one goes.
    await updateDigestSettings(t.deps, project.id, { weekday: new Date(now).getDay() });
    expect(await runDueDigests(t.deps, { ...options, now: slot + 7 * DAY + 60_000 })).toHaveLength(1);
    expect(await deliveries()).toHaveLength(2);
  });

  test('a slot more than six hours old is skipped (the server was down)', async () => {
    const now = Date.now();
    await updateDigestSettings(t.deps, project.id, {
      enabled: true,
      weekday: new Date(now).getDay(),
      hour: new Date(now).getHours(),
    });
    const late = localAt(now, new Date(now).getHours()) + 7 * HOUR;
    // Seven hours on the weekday may have changed; whichever slot is current is too old.
    const sent = await runDueDigests(t.deps, { publicUrl: 'http://pixeltwin.test', now: late });
    expect(sent).toEqual([]);
  });

  test('the Slack message: the auto-pass rate and its change, the median time and the screens to fix', async () => {
    await sendDigestNow(t.deps, project, { publicUrl: 'http://pixeltwin.test' });
    const [delivery] = await deliveries();
    const payload = JSON.parse(delivery?.payload as string) as WebhookPayload;
    expect(payload.event).toBe('insights.weekly');
    expect(payload.insights).toMatchObject({
      branch: 'main',
      builds: 4,
      rejections: { total: 3, noise: 2, realBug: 1 },
      url: 'http://pixeltwin.test/ui/p/web/insights?range=7',
    });
    expect(payload.insights?.screens[0]).toMatchObject({
      name: 'about',
      mainReason: 'not_loaded',
      action: 'wait for the page to load before the screenshot',
    });
    const message = slackMessage(payload);
    expect(message.text).toBe('pixeltwin · Web: weekly insights on main: auto-pass 33%, median time to decision 23m');
    const blocks = JSON.stringify(message.blocks);
    expect(blocks).toContain('Rejections: 2 noise from the tests, 1 real bug');
    expect(blocks).toContain('1. <http://pixeltwin.test/ui/checks/');
    expect(blocks).toContain('|about> · 2× not loaded → wait for the page to load before the screenshot');
    expect(blocks).toContain('<http://pixeltwin.test/ui/p/web/insights?range=7|Open Insights>');
  });

  test('mail goes to members who asked for it and may still see the project', async () => {
    const ann = await createUser(t.deps, {
      email: 'ann@example.com',
      password: 'correct horse battery',
      role: 'viewer',
    });
    const gone = await createUser(t.deps, {
      email: 'gone@example.com',
      password: 'correct horse battery',
      role: 'viewer',
    });
    for (const user of [ann, gone]) {
      await addMember(t.deps, 'web', { email: user.email, role: 'viewer' });
      await setDigestMail(t.deps, project.id, user.id, true);
    }
    await removeMember(t.deps, 'web', gone.id, 'usr_admin');
    const sent = await sendDigestNow(t.deps, project, { publicUrl: 'http://pixeltwin.test', mailer });
    expect(sent).toMatchObject({ webhooks: 1, mails: 1 });
    expect(mails.map((m) => m.mail.to)).toEqual(['ann@example.com']);
    expect(mails[0]?.mail.subject).toBe('Web: weekly visual test insights');
    expect(mails[0]?.mail.text).toContain('Screens to fix in the tests:');
    expect(mails[0]?.mail.text).toContain('1. about: wait for the page to load before the screenshot');
  });
});
