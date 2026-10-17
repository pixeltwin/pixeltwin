import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createProject } from '../../src/domain/projects';
import { SecretBox } from '../../src/domain/secrets';
import { requestAccess, updateSignupSettings } from '../../src/domain/signup';
import type { Services } from '../../src/http/env';
import { notifyAdmins } from '../../src/http/routes/signup';
import { createLogger, silentLogger } from '../../src/log';
import { MailOutbox } from '../../src/mail/outbox';
import type { Mail, Mailer } from '../../src/mail/smtp';
import { createTestApp, PASSWORD } from '../helpers/app';
import { createTestDeps, type TestDeps } from '../helpers/deps';

const mail = (to: string, link = 'https://pt.example/ui/invite/secret-token'): Mail => ({
  to,
  subject: 'You are invited',
  text: `Open ${link}`,
  html: `<a href="${link}">open</a>`,
});

/** Keeps every mail; fails while `failWith` is set. */
function captureMailer(): Mailer & { sent: Mail[]; failWith: string | null } {
  const box = {
    sent: [] as Mail[],
    failWith: null as string | null,
    async send(m: Mail) {
      if (box.failWith) throw new Error(box.failWith);
      box.sent.push(m);
    },
  };
  return box;
}

describe('mail outbox', () => {
  let deps: TestDeps;
  let now: number;
  beforeEach(async () => {
    deps = await createTestDeps();
    deps.secrets = new SecretBox('a secret key that is long enough for tests 123');
    now = 1_000_000;
  });
  afterEach(async () => {
    await deps.handle.close();
  });
  const outbox = (smtp: Mailer, logger = silentLogger) =>
    new MailOutbox({ deps, smtp, logger, autoDeliver: false, now: () => now });

  test('a queued mail waits sealed, is sent once and then forgotten', async () => {
    const smtp = captureMailer();
    const box = outbox(smtp);
    await box.send(mail('a@example.com'), { kind: 'invite' });
    const [row] = await deps.db.selectFrom('mailOutbox').selectAll().execute();
    expect(row).toMatchObject({ kind: 'invite', state: 'pending', attempts: 0 });
    // Sealed with SECRET_KEY: neither the link nor the recipient is readable in the database.
    expect(row?.message).toStartWith('v1:');
    expect(row?.message).not.toContain('secret-token');
    expect(row?.message).not.toContain('a@example.com');

    await box.drain();
    expect(smtp.sent).toEqual([mail('a@example.com')]);
    const sent = await deps.db.selectFrom('mailOutbox').selectAll().executeTakeFirstOrThrow();
    expect(sent).toMatchObject({ state: 'sent', message: '', attempts: 1 });
    await box.drain();
    expect(smtp.sent).toHaveLength(1);
  });

  test('a failing server is retried with backoff; a 5xx answer is final; logs hold no link', async () => {
    const smtp = captureMailer();
    const lines: string[] = [];
    const box = outbox(
      smtp,
      createLogger('debug', (line) => lines.push(line)),
    );
    await box.send(mail('a@example.com'), { kind: 'invite' });
    smtp.failWith = 'connect ECONNREFUSED 127.0.0.1:25';
    await box.runOnce();
    let row = await deps.db.selectFrom('mailOutbox').selectAll().executeTakeFirstOrThrow();
    expect(row).toMatchObject({ state: 'pending', attempts: 1, lastError: 'connect ECONNREFUSED 127.0.0.1:25' });
    expect(Number(row.dueAt)).toBe(now + 30_000);
    // Not due yet.
    expect(await box.runOnce()).toBe(0);
    now += 30_000;
    smtp.failWith = null;
    await box.runOnce();
    expect(smtp.sent).toHaveLength(1);

    await box.send(mail('b@example.com'), { kind: 'password reset' });
    smtp.failWith = 'SMTP RCPT TO: 550 no such user';
    await box.runOnce();
    row = await deps.db
      .selectFrom('mailOutbox')
      .selectAll()
      .where('kind', '=', 'password reset')
      .executeTakeFirstOrThrow();
    expect(row).toMatchObject({ state: 'failed', message: '', attempts: 1 });
    expect(lines.some((l) => l.includes('mail not sent') && l.includes('550'))).toBe(true);
    expect(lines.join('\n')).not.toContain('secret-token');
    expect(lines.join('\n')).not.toContain('b@example.com');
  });

  test('with two replicas each mail is sent once', async () => {
    const [one, two] = [captureMailer(), captureMailer()];
    const [a, b] = [outbox(one), outbox(two)];
    for (let i = 0; i < 6; i++) await a.send(mail(`u${i}@example.com`));
    await Promise.all([a.runOnce(), b.runOnce(), a.runOnce(), b.runOnce()]);
    const sent = [...one.sent, ...two.sent].map((m) => m.to).sort();
    expect(sent).toEqual([
      'u0@example.com',
      'u1@example.com',
      'u2@example.com',
      'u3@example.com',
      'u4@example.com',
      'u5@example.com',
    ]);
  });

  test('a mail with a key goes out once, whoever queues it', async () => {
    const smtp = captureMailer();
    const [a, b] = [outbox(smtp), outbox(smtp)];
    await a.send(mail('admin@example.com'), { key: 'access-requests:usr_1:7' });
    await b.send(mail('admin@example.com'), { key: 'access-requests:usr_1:7' });
    await a.send(mail('admin@example.com'), { key: 'access-requests:usr_1:8' });
    await a.drain();
    expect(smtp.sent).toHaveLength(2);
  });

  test('finished mail is removed after a week', async () => {
    const box = outbox(captureMailer());
    await box.send(mail('a@example.com'));
    await box.drain();
    now += 8 * 24 * 3_600_000;
    await box.runOnce();
    expect(await deps.db.selectFrom('mailOutbox').selectAll().execute()).toEqual([]);
  });
});

describe('mail through the outbox', () => {
  test('an invite queues its mail in the request and it is sent in the background', async () => {
    const smtp = captureMailer();
    const t = await createTestApp({ mailer: smtp });
    try {
      await createProject(t.deps, { slug: 'web', name: 'Web' });
      const admin = await t.userAs('admin');
      smtp.failWith = 'connect ECONNREFUSED';
      const res = await t.request('POST', '/api/v1/projects/web/invites', {
        as: admin,
        json: { email: 'n@example.com' },
      });
      // A mail error never fails the invite; the mail waits for a retry.
      expect(res.status).toBe(201);
      const { link } = (await res.json()) as { link: string };
      const until = Date.now() + 3000;
      const row = async () => t.deps.db.selectFrom('mailOutbox').selectAll().executeTakeFirst();
      while (Number((await row())?.attempts ?? 0) < 1 && Date.now() < until) await Bun.sleep(10);
      expect(await row()).toMatchObject({ kind: 'invite', state: 'pending', attempts: 1 });
      // The retry is due later; make it due now.
      smtp.failWith = null;
      await t.deps.db.updateTable('mailOutbox').set({ dueAt: 0 }).execute();
      await t.mail?.drain();
      expect(smtp.sent.map((m) => m.to)).toEqual(['n@example.com']);
      expect(smtp.sent[0]?.text).toContain(link);
    } finally {
      await t.close();
    }
  });

  test('admins hear of waiting requests once per window, even from two replicas', async () => {
    const smtp = captureMailer();
    const t = await createTestApp({ mailer: smtp });
    try {
      await t.userAs('admin', 'root@example.com');
      await t.userAs('admin', 'second@example.com');
      await updateSignupSettings(t.deps, { mode: 'approval', domains: '' });
      const outcome = await requestAccess(t.deps, { email: 'p@example.com', password: PASSWORD }, { verify: false });
      expect(outcome.kind).toBe('requested');
      await t.deps.db.updateTable('accessRequests').set({ verifiedAt: 1 }).execute();
      const replica = (): Services =>
        ({
          deps: t.deps,
          mailer: t.mail,
          logger: silentLogger,
          config: { publicUrl: 'http://pt.test' },
        }) as unknown as Services;
      // Two replicas (two Services, each with its own in-process throttle) on one database.
      await Promise.all([notifyAdmins(replica()), notifyAdmins(replica())]);
      await Bun.sleep(50);
      await t.mail?.drain();
      expect(smtp.sent.map((m) => m.to).sort()).toEqual(['root@example.com', 'second@example.com']);
    } finally {
      await t.close();
    }
  });
});
