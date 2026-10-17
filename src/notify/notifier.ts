import { sql } from 'kysely';
import type { Project, WebhookEvent } from '../db/schema';
import { actorName } from '../domain/actors';
import { type BuildView, getBuild } from '../domain/builds';
import { getCheck } from '../domain/checks';
import type { Deps, DomainEvents } from '../domain/deps';
import { loadIntegration, reportsToCodeHost, secretsOf } from '../domain/integrations';
import { getProjectById } from '../domain/projects';
import { AUTO_APPROVER } from '../domain/reviews';
import { hmacSha256Hex } from '../domain/secrets';
import type { Verdict } from '../domain/verdict';
import { DELIVERIES_KEPT, type DeliveryView } from '../domain/webhooks';
import { AppError } from '../errors';
import { newId } from '../ids';
import type { Logger } from '../log';
import { githubHost } from './github';
import { gitlabHost } from './gitlab';
import { type ApiOptions, type CodeHost, CodeHostError } from './http';
import {
  buildPayload,
  type CommentCheck,
  checkUrl,
  commentMarker,
  commitStatusFor,
  prComment,
  slackMessage,
  type WebhookPayload,
} from './messages';
import { OutboundError, outboundFetch } from './outbound';

// The outbox. Domain events queue rows (webhook_deliveries, integration_syncs) in the request that caused
// them, which only takes a few inserts; the sending happens here, in the background, so a slow or
// failing receiver never slows or fails that request. Rows survive a restart. Each row is claimed
// with a conditional update (a lease in `locked_until`), so with several replicas on one Postgres
// only one sends it; a replica that dies mid-send leaves a lease that expires and the row is sent
// again (at least once: receivers dedupe by X-Pixeltwin-Delivery). A build's code host sync posts
// whatever the build looks like when it runs, so ten quick approvals make one or two updates; the
// code host is GitHub or GitLab behind one adapter interface (notify/http.ts).

/** How long a claimed row is ours; well above a delivery's timeouts. */
const LEASE_MS = 2 * 60_000;
/** Waits before attempt 2, 3, …; the last is repeated. */
const BACKOFF_MS = [10_000, 30_000, 120_000, 600_000, 1_800_000, 3_600_000, 7_200_000];
const WEBHOOK_ATTEMPTS = 8;
const SYNC_ATTEMPTS = 6;
const WEBHOOK_TIMEOUT_MS = 10_000;
/** Rows claimed per pass, and sent at the same time. */
const BATCH = 20;
const CONCURRENCY = 4;
/** Screens listed in a pull request comment. */
const COMMENT_SCREENS = 6;

function backoff(attempts: number): number {
  return BACKOFF_MS[Math.min(attempts - 1, BACKOFF_MS.length - 1)] as number;
}

async function eachLimited<T>(items: T[], limit: number, run: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) await run(items[next++] as T);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

function errorText(err: unknown): string {
  if (err instanceof AppError) return err.detail;
  return err instanceof Error ? err.message : String(err);
}

export interface NotifierOptions {
  deps: Pick<Deps, 'db' | 'secrets'>;
  publicUrl: string;
  logger: Logger;
  /** OUTBOUND_BLOCK_PRIVATE. */
  blockPrivate: boolean;
  /** Send as soon as something is queued, and poll for due retries. Off in tests: they call `drain()`. */
  autoDeliver?: boolean;
  pollMs?: number;
  webhookTimeoutMs?: number;
  /** Options of code host calls (tests make retries instant). */
  codeHost?: Pick<ApiOptions, 'sleep' | 'timeoutMs' | 'fetch'>;
  now?: () => number;
}

export class Notifier implements DomainEvents {
  readonly #o: NotifierOptions;
  readonly #db: NotifierOptions['deps']['db'];
  #running: Promise<number> | null = null;
  #again = false;
  #timer: ReturnType<typeof setInterval> | null = null;
  #stopped = false;

  constructor(options: NotifierOptions) {
    this.#o = options;
    this.#db = options.deps.db;
  }

  #now(): number {
    return this.#o.now?.() ?? Date.now();
  }

  /** Polls for due rows (retries, rows another replica queued) until `stop()`. */
  start(): void {
    if (this.#timer || this.#o.autoDeliver === false) return;
    this.#timer = setInterval(() => void this.#tick(), this.#o.pollMs ?? 2000);
    this.#timer.unref();
    void this.#tick();
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
    await this.#running;
  }

  /** Something was queued: send it now rather than at the next poll. */
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
          this.#o.logger.error('notifications failed', { error: errorText(err) });
        }
      } while (this.#again && !this.#stopped);
      return total;
    })().finally(() => {
      this.#running = null;
    });
    return this.#running;
  }

  /** Sends what is due now, once; returns how many rows it handled. */
  async runOnce(): Promise<number> {
    const now = this.#now();
    const [webhooks, github] = await Promise.all([this.#deliverDue(now), this.#syncDue(now)]);
    return webhooks + github;
  }

  /** Runs passes until nothing is due (tests). */
  async drain(): Promise<void> {
    for (let i = 0; i < 20; i++) if ((await this.runOnce()) === 0) return;
  }

  // ---- Domain events: queue, never throw. ----

  async #safely(what: string, run: () => Promise<void>): Promise<void> {
    try {
      await run();
      this.#kick();
    } catch (err) {
      this.#o.logger.error('queueing a notification failed', { event: what, error: errorText(err) });
    }
  }

  async buildFinalized(buildId: string): Promise<void> {
    await this.#safely('build.finalized', async () => {
      const build = await getBuild({ db: this.#db }, buildId);
      await this.#db.updateTable('builds').set({ notifiedVerdict: build.verdict }).where('id', '=', buildId).execute();
      const project = await getProjectById({ db: this.#db }, build.projectId);
      await this.#queueWebhooks(project, 'build.finalized', () => ({ build: buildPayload(build, this.#o.publicUrl) }));
      await this.#queueSync(build);
    });
  }

  async buildsChanged(buildIds: string[]): Promise<void> {
    await this.#safely('build.verdict_changed', async () => {
      for (const id of new Set(buildIds)) {
        const stored = await this.#db
          .selectFrom('builds')
          .select(['state', 'notifiedVerdict'])
          .where('id', '=', id)
          .executeTakeFirst();
        // An open build is still being posted to; it is announced when finalized.
        if (stored?.state !== 'finalized') continue;
        // Read what was announced before computing the verdict, and announce a change only if no
        // one else announced something in between: concurrent reviews announce each change once.
        const previous = (stored.notifiedVerdict ?? null) as Verdict | null;
        const build = await getBuild({ db: this.#db }, id);
        if (build.verdict !== previous) {
          const updated = await this.#db
            .updateTable('builds')
            .set({ notifiedVerdict: build.verdict })
            .where('id', '=', id)
            .where('notifiedVerdict', previous === null ? 'is' : '=', previous)
            .executeTakeFirst();
          if (Number(updated.numUpdatedRows) === 1) {
            const project = await getProjectById({ db: this.#db }, build.projectId);
            await this.#queueWebhooks(project, 'build.verdict_changed', () => ({
              build: { ...buildPayload(build, this.#o.publicUrl), previousVerdict: previous },
            }));
          }
        }
        await this.#queueSync(build);
      }
    });
  }

  async checkReviewed(event: { checkId: string; action: 'approved' | 'rejected' | 'reset'; actor: string }) {
    if (event.actor === AUTO_APPROVER) return;
    await this.#safely('check.reviewed', async () => {
      const check = await getCheck({ db: this.#db }, event.checkId);
      if (!(await this.#subscribers(check.projectId, 'check.reviewed')).length) return;
      const [build, project, name] = await Promise.all([
        getBuild({ db: this.#db }, check.buildId),
        getProjectById({ db: this.#db }, check.projectId),
        actorName({ db: this.#db }, event.actor),
      ]);
      await this.#queueWebhooks(project, 'check.reviewed', () => ({
        build: buildPayload(build, this.#o.publicUrl),
        check: {
          id: check.id,
          name: check.name,
          variant: check.variant,
          result: check.result,
          review: check.review,
          url: checkUrl(this.#o.publicUrl, check.id),
        },
        review: { action: event.action, actor: { id: event.actor, name } },
      }));
    });
  }

  async #subscribers(projectId: string, event: WebhookEvent) {
    const hooks = await this.#db
      .selectFrom('webhooks')
      .select(['id', 'events'])
      .where('projectId', '=', projectId)
      .where('enabled', '=', 1)
      .execute();
    return hooks.filter((h) => (JSON.parse(h.events) as string[]).includes(event));
  }

  async #queueWebhooks(
    project: Project,
    event: WebhookEvent,
    body: () => Omit<WebhookPayload, 'id' | 'event' | 'createdAt' | 'project'>,
  ): Promise<void> {
    const hooks = await this.#subscribers(project.id, event);
    if (hooks.length === 0) return;
    const now = this.#now();
    const content = body();
    await this.#db
      .insertInto('webhookDeliveries')
      .values(
        hooks.map((hook) => {
          const id = newId('dlv');
          const payload: WebhookPayload = {
            id,
            event,
            createdAt: now,
            project: { id: project.id, slug: project.slug, name: project.name },
            ...content,
          };
          return {
            id,
            webhookId: hook.id,
            projectId: project.id,
            event,
            payload: JSON.stringify(payload),
            state: 'pending' as const,
            attempts: 0,
            dueAt: now,
            lockedUntil: null,
            statusCode: null,
            error: null,
            durationMs: null,
            createdAt: now,
            finishedAt: null,
          };
        }),
      )
      .execute();
  }

  /** Asks for the build's state to be posted to the code host; repeated asks before it runs make one post. */
  async #queueSync(build: BuildView): Promise<void> {
    if (build.state !== 'finalized' || (!build.commitSha && !build.pullRequest)) return;
    if (!(await reportsToCodeHost({ db: this.#db }, build.projectId))) return;
    const now = this.#now();
    await this.#db
      .insertInto('integrationSyncs')
      .values({
        buildId: build.id,
        projectId: build.projectId,
        requested: 1,
        done: 0,
        dueAt: now,
        lockedUntil: null,
        attempts: 0,
        commentId: null,
        lastError: null,
        syncedAt: null,
        updatedAt: now,
      })
      .onConflict((oc) =>
        oc.column('buildId').doUpdateSet((eb) => ({
          requested: eb(eb.ref('integrationSyncs.requested'), '+', 1),
          dueAt: now,
          attempts: 0,
          updatedAt: now,
        })),
      )
      .execute();
  }

  // ---- Webhook deliveries. ----

  async #deliverDue(now: number): Promise<number> {
    const due = await this.#db
      .selectFrom('webhookDeliveries')
      .select('id')
      .where('state', '=', 'pending')
      .where('dueAt', '<=', now)
      .where((eb) => eb.or([eb('lockedUntil', 'is', null), eb('lockedUntil', '<', now)]))
      .orderBy('id')
      .limit(BATCH)
      .execute();
    let handled = 0;
    await eachLimited(due, CONCURRENCY, async ({ id }) => {
      if (!(await this.#claimDelivery(id, now))) return;
      await this.#deliver(id, WEBHOOK_ATTEMPTS);
      handled += 1;
    });
    return handled;
  }

  /** True when this replica got the delivery: no one else holds a live lease on it. */
  async #claimDelivery(id: string, now: number): Promise<boolean> {
    const claimed = await this.#db
      .updateTable('webhookDeliveries')
      .set((eb) => ({ lockedUntil: now + LEASE_MS, attempts: eb('attempts', '+', 1) }))
      .where('id', '=', id)
      .where('state', '=', 'pending')
      .where('dueAt', '<=', now)
      .where((eb) => eb.or([eb('lockedUntil', 'is', null), eb('lockedUntil', '<', now)]))
      .executeTakeFirst();
    return Number(claimed.numUpdatedRows) === 1;
  }

  async #deliver(id: string, maxAttempts: number): Promise<void> {
    const row = await this.#db
      .selectFrom('webhookDeliveries')
      .innerJoin('webhooks', 'webhooks.id', 'webhookDeliveries.webhookId')
      .select([
        'webhookDeliveries.id',
        'webhookDeliveries.webhookId',
        'webhookDeliveries.event',
        'webhookDeliveries.payload',
        'webhookDeliveries.attempts',
        'webhooks.url',
        'webhooks.secret',
        'webhooks.format',
        'webhooks.enabled',
      ])
      .where('webhookDeliveries.id', '=', id)
      .executeTakeFirst();
    if (!row) return;
    const attempts = Number(row.attempts);
    let statusCode: number | null = null;
    let error: string | null = null;
    let retryable = false;
    const started = performance.now();
    if (Number(row.enabled) !== 1 && row.event !== 'ping') {
      error = 'The webhook was turned off before this was sent.';
    } else {
      try {
        const body =
          row.format === 'slack'
            ? JSON.stringify(slackMessage(JSON.parse(row.payload) as WebhookPayload))
            : row.payload;
        const secret = secretsOf(this.#o.deps).open(row.secret);
        const res = await outboundFetch(
          row.url,
          {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'x-pixeltwin-event': row.event,
              'x-pixeltwin-delivery': row.id,
              'x-pixeltwin-signature': `sha256=${hmacSha256Hex(secret, body)}`,
            },
            body,
          },
          { blockPrivate: this.#o.blockPrivate, timeoutMs: this.#o.webhookTimeoutMs ?? WEBHOOK_TIMEOUT_MS },
        );
        statusCode = res.status;
        await res.body?.cancel();
        if (res.status >= 300 && res.status < 400) {
          error = `Redirected (${res.status}); webhooks do not follow redirects. Use the final URL.`;
        } else if (!res.ok) {
          error = `The receiver answered ${res.status}.`;
          retryable = res.status >= 500 || res.status === 429 || res.status === 408;
        }
      } catch (err) {
        error = errorText(err);
        retryable = err instanceof OutboundError ? err.retryable : false;
      }
    }
    const durationMs = Math.round(performance.now() - started);
    const now = this.#now();
    const again = error !== null && retryable && attempts < maxAttempts;
    await this.#db
      .updateTable('webhookDeliveries')
      .set({
        state: error === null ? 'delivered' : again ? 'pending' : 'failed',
        statusCode,
        error,
        durationMs,
        lockedUntil: null,
        ...(again ? { dueAt: now + backoff(attempts) } : { finishedAt: now }),
      })
      .where('id', '=', id)
      .execute();
    if (error !== null) {
      this.#o.logger.warn('webhook delivery failed', {
        delivery: id,
        webhook: row.webhookId,
        statusCode,
        error,
        again,
      });
    }
    if (!again) await this.#prune(row.webhookId);
  }

  /** Keeps the newest DELIVERIES_KEPT finished deliveries of the webhook. */
  async #prune(webhookId: string): Promise<void> {
    await this.#db
      .deleteFrom('webhookDeliveries')
      .where('webhookId', '=', webhookId)
      .where('state', '!=', 'pending')
      .where('id', 'not in', (eb) =>
        eb
          .selectFrom('webhookDeliveries')
          .select('id')
          .where('webhookId', '=', webhookId)
          .where('state', '!=', 'pending')
          .orderBy('id', 'desc')
          .limit(DELIVERIES_KEPT),
      )
      .execute();
  }

  /** Send test: a `ping` delivery sent right away (once, no retries); the answer is its outcome. */
  async sendTest(projectId: string, webhookId: string): Promise<DeliveryView> {
    const project = await getProjectById({ db: this.#db }, projectId);
    const hook = await this.#db
      .selectFrom('webhooks')
      .select(['id', 'url'])
      .where('id', '=', webhookId)
      .where('projectId', '=', projectId)
      .executeTakeFirst();
    if (!hook) throw new AppError('webhook_not_found', 404, `Webhook ${webhookId} not found in this project.`);
    const now = this.#now();
    const id = newId('dlv');
    const payload: WebhookPayload = {
      id,
      event: 'ping',
      createdAt: now,
      project: { id: project.id, slug: project.slug, name: project.name },
    };
    await this.#db
      .insertInto('webhookDeliveries')
      .values({
        id,
        webhookId,
        projectId,
        event: 'ping',
        payload: JSON.stringify(payload),
        state: 'pending',
        attempts: 1,
        dueAt: now,
        lockedUntil: now + LEASE_MS,
        statusCode: null,
        error: null,
        durationMs: null,
        createdAt: now,
        finishedAt: null,
      })
      .execute();
    await this.#deliver(id, 1);
    const row = await this.#db
      .selectFrom('webhookDeliveries')
      .select(['id', 'event', 'state', 'attempts', 'statusCode', 'error', 'durationMs', 'createdAt', 'finishedAt'])
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
    return {
      ...row,
      attempts: Number(row.attempts),
      statusCode: row.statusCode === null ? null : Number(row.statusCode),
      durationMs: row.durationMs === null ? null : Number(row.durationMs),
      createdAt: Number(row.createdAt),
      finishedAt: row.finishedAt === null ? null : Number(row.finishedAt),
    };
  }

  // ---- Code host (GitHub, GitLab): commit status and pull/merge request comment. ----

  async #syncDue(now: number): Promise<number> {
    const due = await this.#db
      .selectFrom('integrationSyncs')
      .select('buildId')
      .whereRef('requested', '>', 'done')
      .where('dueAt', '<=', now)
      .where((eb) => eb.or([eb('lockedUntil', 'is', null), eb('lockedUntil', '<', now)]))
      .orderBy('dueAt')
      .limit(BATCH)
      .execute();
    let handled = 0;
    await eachLimited(due, CONCURRENCY, async ({ buildId }) => {
      const claimed = await this.#db
        .updateTable('integrationSyncs')
        .set({ lockedUntil: now + LEASE_MS })
        .where('buildId', '=', buildId)
        .whereRef('requested', '>', 'done')
        .where('dueAt', '<=', now)
        .where((eb) => eb.or([eb('lockedUntil', 'is', null), eb('lockedUntil', '<', now)]))
        .returning(['requested', 'attempts', 'commentId'])
        .executeTakeFirst();
      if (!claimed) return;
      await this.#sync(buildId, {
        requested: Number(claimed.requested),
        attempts: Number(claimed.attempts),
        commentId: claimed.commentId,
      });
      handled += 1;
    });
    return handled;
  }

  async #sync(buildId: string, claimed: { requested: number; attempts: number; commentId: string | null }) {
    const finish = (fields: { lastError: string | null; commentId?: string | null; synced?: boolean }) =>
      this.#db
        .updateTable('integrationSyncs')
        .set({
          // What was asked for up to the claim is done; asks made since keep the row due.
          done: claimed.requested,
          lockedUntil: null,
          attempts: 0,
          lastError: fields.lastError,
          ...(fields.commentId !== undefined ? { commentId: fields.commentId } : {}),
          ...(fields.synced ? { syncedAt: this.#now() } : {}),
          updatedAt: this.#now(),
        })
        .where('buildId', '=', buildId)
        .execute();
    let build: BuildView;
    try {
      build = await getBuild({ db: this.#db }, buildId);
    } catch {
      return; // Deleted meanwhile; its row went with it.
    }
    try {
      const config = await loadIntegration(this.#o.deps, build.projectId);
      if (!config?.token || (!config.commitStatus && !config.prComment)) {
        await finish({ lastError: null });
        return;
      }
      const repository = build.repository ?? config.repository;
      if (!repository) {
        await finish({
          lastError: 'No repository: set one in the integration settings, or let CI send it with the build.',
        });
        return;
      }
      if (build.state !== 'finalized') {
        await finish({ lastError: null });
        return;
      }
      const project = await getProjectById({ db: this.#db }, build.projectId);
      const host = this.#hostFor(config.provider, config.baseUrl, config.token);
      if (config.commitStatus && build.commitSha) {
        await host.postStatus(repository, build.commitSha, commitStatusFor(build, project, this.#o.publicUrl));
      }
      let commentId = claimed.commentId;
      if (config.prComment && build.pullRequest) {
        const body = prComment(build, project, this.#o.publicUrl, await this.#commentChecks(build.id));
        commentId = await host.upsertComment(repository, build.pullRequest, commentMarker(build.id), body, commentId);
      }
      await finish({ lastError: null, commentId, synced: true });
    } catch (err) {
      const message = errorText(err);
      // A refusal (bad token, unknown repository) waits for the next change; the host being down,
      // slow or rate limiting is tried again later.
      const retryable = err instanceof CodeHostError ? err.retryable : !(err instanceof AppError);
      const attempts = claimed.attempts + 1;
      this.#o.logger.warn('code host update failed', { build: buildId, error: message, attempts });
      if (retryable && attempts < SYNC_ATTEMPTS) {
        await this.#db
          .updateTable('integrationSyncs')
          .set({
            lockedUntil: null,
            attempts,
            dueAt: this.#now() + backoff(attempts),
            lastError: message,
            updatedAt: this.#now(),
          })
          .where('buildId', '=', buildId)
          .execute();
      } else {
        await finish({ lastError: message });
      }
    }
  }

  #hostFor(provider: 'github' | 'gitlab', baseUrl: string, token: string): CodeHost {
    const options: ApiOptions = { ...this.#o.codeHost, blockPrivate: this.#o.blockPrivate };
    return provider === 'gitlab'
      ? gitlabHost({ baseUrl, token }, options)
      : githubHost({ apiUrl: baseUrl, token }, options);
  }

  /**
   * The build's screens that needed a person (changed, new or failed, not auto-approved): those
   * waiting first, then rejected, failed, approved; by name.
   */
  async #commentChecks(buildId: string): Promise<{ items: CommentCheck[]; total: number }> {
    const attention = this.#db
      .selectFrom('checks')
      .where('buildId', '=', buildId)
      .where('result', 'in', ['changed', 'new', 'error'])
      .where((eb) => eb.not(eb.and([eb('review', '=', 'approved'), eb('reviewedBy', '=', AUTO_APPROVER)])));
    const [rows, count] = await Promise.all([
      attention
        .select(['id', 'name', 'variant', 'result', 'review'])
        .orderBy(
          sql`case review when 'pending' then 0 when 'rejected' then 1 when 'none' then 2 when 'approved' then 3 else 4 end`,
        )
        .orderBy('name')
        .orderBy('id')
        .limit(COMMENT_SCREENS)
        .execute(),
      attention.select((eb) => eb.fn.countAll<number>().as('n')).executeTakeFirstOrThrow(),
    ]);
    return {
      items: rows.map((r) => ({ ...r, variant: JSON.parse(r.variant) as Record<string, string> })),
      total: Number(count.n),
    };
  }
}
