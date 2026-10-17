import type { Deps } from '../domain/deps';
import { secretsOf } from '../domain/integrations';
import { AppError } from '../errors';
import { newId } from '../ids';
import type { Logger } from '../log';
import type { Mail, Mailer, SendOptions } from './smtp';

// The mail outbox, on the pattern of the webhook outbox (notify/notifier.ts). `send` only inserts
// a row (in the request that wants the mail), so a slow or broken SMTP server never slows or fails
// it; the sending happens here, in the background. Rows survive a restart, and each is claimed with
// a conditional update (a lease in `locked_until`), so with several replicas on one Postgres only
// one sends it. A replica that dies mid-send leaves a lease that expires, and the mail is sent
// again: at least once. The message is sealed (SECRET_KEY) while it waits and cleared afterwards.

/** How long a claimed mail is ours; well above the SMTP client's 15 s timeout. */
const LEASE_MS = 2 * 60_000;
/** Waits before attempt 2, 3, …: about an hour and a half in all. */
const BACKOFF_MS = [30_000, 120_000, 600_000, 1_800_000, 3_600_000];
const ATTEMPTS = BACKOFF_MS.length + 1;
const BATCH = 20;
/** Sent and given-up rows (no message any more) are kept this long, with their dedupe keys. */
const KEEP_MS = 7 * 24 * 3_600_000;

export interface MailOutboxOptions {
  deps: Pick<Deps, 'db' | 'secrets'>;
  /** What actually sends (the SMTP client). */
  smtp: Mailer;
  logger: Logger;
  /** Send as soon as something is queued, and poll for retries. Tests may turn it off and `drain()`. */
  autoDeliver?: boolean;
  pollMs?: number;
  now?: () => number;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** An SMTP 5xx answer will not change on retry (a refused address, a refused message). */
function permanent(error: string): boolean {
  return /^SMTP [^:]+: 5\d\d\b/.test(error);
}

export class MailOutbox implements Mailer {
  readonly #o: MailOutboxOptions;
  #running: Promise<number> | null = null;
  #again = false;
  #timer: ReturnType<typeof setInterval> | null = null;
  #stopped = false;

  constructor(options: MailOutboxOptions) {
    this.#o = options;
  }

  #now(): number {
    return this.#o.now?.() ?? Date.now();
  }

  /** Queues the mail. With a `key` already used, nothing is queued (another replica, an earlier call). */
  async send(mail: Mail, options: SendOptions = {}): Promise<void> {
    const now = this.#now();
    await this.#o.deps.db
      .insertInto('mailOutbox')
      .values({
        id: newId('mal'),
        kind: options.kind ?? 'mail',
        message: secretsOf(this.#o.deps).seal(JSON.stringify(mail)),
        dedupeKey: options.key ?? null,
        state: 'pending',
        attempts: 0,
        dueAt: now,
        lockedUntil: null,
        lastError: null,
        createdAt: now,
        finishedAt: null,
      })
      .onConflict((oc) => oc.column('dedupeKey').doNothing())
      .execute();
    this.#kick();
  }

  /** Polls for due mail (retries, mail another replica queued) until `stop()`. */
  start(): void {
    if (this.#timer || this.#o.autoDeliver === false) return;
    this.#timer = setInterval(() => void this.#tick(), this.#o.pollMs ?? 5000);
    this.#timer.unref();
    void this.#tick();
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
    await this.#running;
  }

  #kick(): void {
    if (this.#o.autoDeliver === false || this.#stopped) return;
    setTimeout(() => void this.#tick(), 0);
  }

  #tick(): Promise<number> {
    if (this.#running) {
      this.#again = true;
      return this.#running;
    }
    this.#running = (async () => {
      let total = 0;
      do {
        this.#again = false;
        try {
          total += await this.runOnce();
        } catch (err) {
          this.#o.logger.error('mail outbox failed', { error: errorText(err) });
        }
      } while (this.#again && !this.#stopped);
      return total;
    })().finally(() => {
      this.#running = null;
    });
    return this.#running;
  }

  /** Sends what is due now, once (one at a time: mail is rare); returns how many it handled. */
  async runOnce(): Promise<number> {
    const now = this.#now();
    const { db } = this.#o.deps;
    await db
      .deleteFrom('mailOutbox')
      .where('state', '<>', 'pending')
      .where('finishedAt', '<', now - KEEP_MS)
      .execute();
    const due = await db
      .selectFrom('mailOutbox')
      .select('id')
      .where('state', '=', 'pending')
      .where('dueAt', '<=', now)
      .where((eb) => eb.or([eb('lockedUntil', 'is', null), eb('lockedUntil', '<', now)]))
      .orderBy('id')
      .limit(BATCH)
      .execute();
    let handled = 0;
    for (const { id } of due) {
      if (!(await this.#claim(id, now))) continue;
      await this.#sendOne(id);
      handled += 1;
    }
    return handled;
  }

  /** Runs passes until nothing is due (tests). */
  async drain(): Promise<void> {
    for (let i = 0; i < 20; i++) if ((await this.runOnce()) === 0) return;
  }

  /** True when this replica got the mail: no one else holds a live lease on it. */
  async #claim(id: string, now: number): Promise<boolean> {
    const claimed = await this.#o.deps.db
      .updateTable('mailOutbox')
      .set((eb) => ({ lockedUntil: now + LEASE_MS, attempts: eb('attempts', '+', 1) }))
      .where('id', '=', id)
      .where('state', '=', 'pending')
      .where('dueAt', '<=', now)
      .where((eb) => eb.or([eb('lockedUntil', 'is', null), eb('lockedUntil', '<', now)]))
      .executeTakeFirst();
    return Number(claimed.numUpdatedRows) === 1;
  }

  async #sendOne(id: string): Promise<void> {
    const { db } = this.#o.deps;
    const row = await db
      .selectFrom('mailOutbox')
      .select(['kind', 'message', 'attempts'])
      .where('id', '=', id)
      .executeTakeFirst();
    if (!row) return;
    const attempts = Number(row.attempts);
    let error: string;
    let unreadable = false;
    try {
      const mail = JSON.parse(secretsOf(this.#o.deps).open(row.message)) as Mail;
      await this.#o.smtp.send(mail);
      await db
        .updateTable('mailOutbox')
        .set({ state: 'sent', message: '', lockedUntil: null, lastError: null, finishedAt: this.#now() })
        .where('id', '=', id)
        .execute();
      return;
    } catch (err) {
      error = err instanceof AppError ? err.detail : errorText(err);
      // SECRET_KEY changed since it was queued: it will not get better.
      unreadable = err instanceof AppError && err.code === 'secret_unreadable';
    }
    // Logged without the mail or its recipient: it may hold a one-time link.
    const retry = attempts < ATTEMPTS && !permanent(error) && !unreadable;
    this.#o.logger.warn('mail not sent', { what: row.kind, error, attempt: attempts, retry });
    const now = this.#now();
    await db
      .updateTable('mailOutbox')
      .set(
        retry
          ? { dueAt: now + (BACKOFF_MS[attempts - 1] as number), lockedUntil: null, lastError: error }
          : { state: 'failed', message: '', lockedUntil: null, lastError: error, finishedAt: now },
      )
      .where('id', '=', id)
      .execute();
  }
}
