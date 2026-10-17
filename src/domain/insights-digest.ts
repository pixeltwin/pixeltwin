import { z } from 'zod';
import type { Project } from '../db/schema';
import { newId } from '../ids';
import type { Logger } from '../log';
import { digestMail } from '../mail/messages';
import type { Mailer } from '../mail/smtp';
import type { Deps } from './deps';
import { getInsights, type NoiseReason, rangeOf } from './insights-report';
import { getProjectById } from './projects';
import { parseInput } from './schemas';

// The weekly digest of Insights: a project setting (off by default) sends, on a weekday and hour of
// the server's time zone (TZ), last week's numbers to the project's webhooks that subscribe to
// `insights.weekly` and by mail to the members who asked for it. Both go through the existing
// outboxes. Once per week across replicas: the slot (`2026-10-19T09`) is the primary key of the row
// that claims it, inserted in the transaction that queues the webhook deliveries; a slot is only
// sent while it is fresh, and never within six days of the last scheduled digest (a changed weekday
// does not send twice in a week). Send now sends at once, outside the schedule.

type DbDeps = Pick<Deps, 'db'>;

/** How late a slot may still go out (a replica that was down at the hour). */
export const SLOT_GRACE_MS = 6 * 3_600_000;
/** No second scheduled digest within this long of the last one. */
export const MIN_GAP_MS = 6 * 24 * 3_600_000;
export const DIGEST_INTERVAL_MS = 5 * 60_000;
/** Screens listed in a digest. */
export const DIGEST_SCREENS = 5;

/** What to do, in a few words (Slack, mail). */
export const SHORT_ACTIONS: Record<NoiseReason, string> = {
  not_loaded: 'wait for the page to load before the screenshot',
  late_asset: 'wait for images and fonts before the screenshot',
  animation: 'disable animations for the screenshot',
  dynamic_data: 'add an ignore area over the changing data',
  flaky: 'ignore the area that keeps changing',
};

export interface DigestSettings {
  enabled: boolean;
  /** 0 Sunday … 6 Saturday, server time. */
  weekday: number;
  hour: number;
}

export const DEFAULT_DIGEST: DigestSettings = { enabled: false, weekday: 1, hour: 9 };

export const digestSettingsSchema = z.strictObject({
  enabled: z.boolean().optional(),
  weekday: z.number().int().min(0).max(6).optional(),
  hour: z.number().int().min(0).max(23).optional(),
});

/** The server's time zone, as the digest's weekday and hour read: `Europe/Kyiv (UTC+03:00)`. */
export function serverTimeZone(now = Date.now()): string {
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  const offset = -new Date(now).getTimezoneOffset();
  const sign = offset < 0 ? '-' : '+';
  const hh = String(Math.floor(Math.abs(offset) / 60)).padStart(2, '0');
  const mm = String(Math.abs(offset) % 60).padStart(2, '0');
  return `${zone} (UTC${sign}${hh}:${mm})`;
}

export async function getDigestSettings(deps: DbDeps, projectId: string): Promise<DigestSettings> {
  const row = await deps.db
    .selectFrom('insightDigestSettings')
    .select(['enabled', 'weekday', 'hour'])
    .where('projectId', '=', projectId)
    .executeTakeFirst();
  if (!row) return { ...DEFAULT_DIGEST };
  return { enabled: Number(row.enabled) === 1, weekday: Number(row.weekday), hour: Number(row.hour) };
}

export async function updateDigestSettings(deps: DbDeps, projectId: string, input: unknown): Promise<DigestSettings> {
  const changes = parseInput(digestSettingsSchema, input);
  const next = { ...(await getDigestSettings(deps, projectId)), ...changes };
  const values = { enabled: next.enabled ? 1 : 0, weekday: next.weekday, hour: next.hour, updatedAt: Date.now() };
  await deps.db
    .insertInto('insightDigestSettings')
    .values({ projectId, ...values })
    .onConflict((oc) => oc.column('projectId').doUpdateSet(values))
    .execute();
  return next;
}

/** Whether `userId` gets the project's digest by mail. */
export async function digestMailWanted(deps: DbDeps, projectId: string, userId: string): Promise<boolean> {
  const row = await deps.db
    .selectFrom('insightDigestSubscribers')
    .select('userId')
    .where('projectId', '=', projectId)
    .where('userId', '=', userId)
    .executeTakeFirst();
  return !!row;
}

export async function setDigestMail(deps: DbDeps, projectId: string, userId: string, on: boolean): Promise<void> {
  if (on) {
    await deps.db
      .insertInto('insightDigestSubscribers')
      .values({ projectId, userId, createdAt: Date.now() })
      .onConflict((oc) => oc.columns(['projectId', 'userId']).doNothing())
      .execute();
  } else {
    await deps.db
      .deleteFrom('insightDigestSubscribers')
      .where('projectId', '=', projectId)
      .where('userId', '=', userId)
      .execute();
  }
}

/** The scheduled slot at or before `now` (server time), and its key. */
export function slotOf(settings: Pick<DigestSettings, 'weekday' | 'hour'>, now: number): { key: string; at: number } {
  const local = new Date(now);
  const at = new Date(local.getFullYear(), local.getMonth(), local.getDate(), settings.hour, 0, 0, 0);
  at.setDate(at.getDate() - ((local.getDay() - settings.weekday + 7) % 7));
  if (at.getTime() > now) at.setDate(at.getDate() - 7);
  const pad = (n: number) => String(n).padStart(2, '0');
  return {
    key: `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}T${pad(settings.hour)}`,
    at: at.getTime(),
  };
}

export interface DigestScreen {
  name: string;
  variant: Record<string, string>;
  checkId: string;
  url: string;
  mainReason: NoiseReason;
  /** What to change in the test, in a few words. */
  action: string;
  noiseRejections: number;
  flakyScore: number | null;
}

/** The `insights` of an `insights.weekly` delivery. Fields are only ever added. */
export interface InsightsDigest {
  branch: string;
  from: string;
  to: string;
  url: string;
  builds: number;
  checks: number;
  autoPassRate: number | null;
  previousAutoPassRate: number | null;
  medianTimeToDecisionMs: number | null;
  rejections: { total: number; noise: number; realBug: number };
  flakyScreensNow: number;
  /** The screens to fix in the tests, the noisiest first (at most DIGEST_SCREENS). */
  screens: DigestScreen[];
}

/** Last week's numbers on the main branch, as the digest says them. */
export async function digestOf(deps: DbDeps, project: Project, publicUrl: string, now = Date.now()) {
  const report = await getInsights(deps, project, rangeOf(project, { days: 7 }, now));
  const digest: InsightsDigest = {
    branch: report.branch,
    from: report.from,
    to: report.to,
    url: `${publicUrl}/ui/p/${project.slug}/insights?range=7`,
    builds: report.totals.builds,
    checks: report.totals.checks,
    autoPassRate: report.totals.autoPassRate,
    previousAutoPassRate: report.previous.autoPassRate,
    medianTimeToDecisionMs: report.totals.timeToDecision.medianMs,
    rejections: {
      total: report.totals.rejections.total,
      noise: report.totals.rejections.noise,
      realBug: report.totals.rejections.realBug,
    },
    flakyScreensNow: report.flakyScreensNow,
    screens: report.noisyScreens.slice(0, DIGEST_SCREENS).map((s) => ({
      name: s.name,
      variant: s.variant,
      checkId: s.checkId,
      url: `${publicUrl}/ui/checks/${s.checkId}`,
      mainReason: s.mainReason,
      action: SHORT_ACTIONS[s.mainReason],
      noiseRejections: s.noiseRejections,
      flakyScore: s.flakyScore,
    })),
  };
  return digest;
}

/** Members (and admins) who asked for the digest by mail and may still open the project. */
async function mailRecipients(deps: DbDeps, project: Project): Promise<Array<{ id: string; email: string }>> {
  const rows = await deps.db
    .selectFrom('insightDigestSubscribers')
    .innerJoin('users', 'users.id', 'insightDigestSubscribers.userId')
    .leftJoin('projectMembers', (join) =>
      join.onRef('projectMembers.userId', '=', 'users.id').on('projectMembers.projectId', '=', project.id),
    )
    .select(['users.id', 'users.email', 'users.role', 'projectMembers.role as member'])
    .where('insightDigestSubscribers.projectId', '=', project.id)
    .where('users.status', '=', 'active')
    .execute();
  return rows
    .filter((r) => r.role === 'admin' || r.member !== null || project.visibleToAll)
    .map((r) => ({ id: r.id, email: r.email }));
}

export interface DigestSent {
  slot: string;
  webhooks: number;
  mails: number;
}

/**
 * Sends the project's digest for `slot`, once: the claim row and the webhook deliveries commit
 * together; mail is queued afterwards with a key per slot and person. Null when the slot was
 * sent already (another replica, an earlier tick).
 */
export async function sendDigest(
  deps: DbDeps,
  project: Project,
  options: { kind: 'scheduled' | 'manual'; slot: string; publicUrl: string; mailer?: Mailer | null; now?: number },
): Promise<DigestSent | null> {
  const now = options.now ?? Date.now();
  const digest = await digestOf(deps, project, options.publicUrl, now);
  const webhooks = await deps.db
    .selectFrom('webhooks')
    .select(['id', 'events'])
    .where('projectId', '=', project.id)
    .where('enabled', '=', 1)
    .execute();
  const hooks = webhooks.filter((h) => (JSON.parse(h.events) as string[]).includes('insights.weekly'));
  const recipients = options.mailer ? await mailRecipients(deps, project) : [];
  const claimed = await deps.db.transaction().execute(async (tx) => {
    const claim = await tx
      .insertInto('insightDigests')
      .values({
        projectId: project.id,
        slot: options.slot,
        kind: options.kind,
        webhooks: hooks.length,
        mails: recipients.length,
        sentAt: now,
      })
      .onConflict((oc) => oc.columns(['projectId', 'slot']).doNothing())
      .returning('slot')
      .execute();
    if (claim.length === 0) return false;
    if (hooks.length > 0) {
      await tx
        .insertInto('webhookDeliveries')
        .values(
          hooks.map((hook) => {
            const id = newId('dlv');
            return {
              id,
              webhookId: hook.id,
              projectId: project.id,
              event: 'insights.weekly',
              payload: JSON.stringify({
                id,
                event: 'insights.weekly',
                createdAt: now,
                project: { id: project.id, slug: project.slug, name: project.name },
                insights: digest,
              }),
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
    return true;
  });
  if (!claimed) return null;
  for (const r of recipients) {
    await options.mailer?.send(digestMail(r.email, project.name, digest), {
      kind: 'insights digest',
      key: `insights:${project.id}:${options.slot}:${r.id}`,
    });
  }
  return { slot: options.slot, webhooks: hooks.length, mails: recipients.length };
}

/** Send now (admins): at once, whatever the schedule. */
export function sendDigestNow(
  deps: DbDeps,
  project: Project,
  options: { publicUrl: string; mailer?: Mailer | null },
): Promise<DigestSent | null> {
  return sendDigest(deps, project, { ...options, kind: 'manual', slot: `manual:${newId('imk').slice(4)}` });
}

/** Sends the digests whose slot came (one tick of the schedule); returns those it sent. */
export async function runDueDigests(
  deps: DbDeps,
  options: { publicUrl: string; mailer?: Mailer | null; now?: number },
): Promise<DigestSent[]> {
  const now = options.now ?? Date.now();
  const enabled = await deps.db
    .selectFrom('insightDigestSettings')
    .select(['projectId', 'weekday', 'hour'])
    .where('enabled', '=', 1)
    .execute();
  const sent: DigestSent[] = [];
  for (const row of enabled) {
    const slot = slotOf({ weekday: Number(row.weekday), hour: Number(row.hour) }, now);
    if (now - slot.at > SLOT_GRACE_MS) continue;
    // Sent already: skip before computing the digest (every tick of every replica asks).
    const sentAlready = await deps.db
      .selectFrom('insightDigests')
      .select('slot')
      .where('projectId', '=', row.projectId)
      .where('slot', '=', slot.key)
      .executeTakeFirst();
    if (sentAlready) continue;
    const last = await deps.db
      .selectFrom('insightDigests')
      .select((eb) => eb.fn.max('sentAt').as('at'))
      .where('projectId', '=', row.projectId)
      .where('kind', '=', 'scheduled')
      .where('slot', '!=', slot.key)
      .executeTakeFirst();
    if (last?.at && now - Number(last.at) < MIN_GAP_MS) continue;
    const project = await getProjectById(deps, row.projectId);
    const done = await sendDigest(deps, project, { ...options, kind: 'scheduled', slot: slot.key, now });
    if (done) sent.push(done);
  }
  return sent;
}

export interface DigestJob {
  runNow(): Promise<DigestSent[]>;
  stop(): Promise<void>;
}

/** Checks every few minutes for digests due; a failure is logged and the next tick tries again. */
export function startDigestJob(options: {
  deps: DbDeps;
  publicUrl: string;
  mailer?: Mailer | null;
  logger: Logger;
  intervalMs?: number;
}): DigestJob {
  let running: Promise<DigestSent[]> | null = null;
  const runNow = () => {
    running ??= runDueDigests(options.deps, options)
      .then((sent) => {
        for (const s of sent) options.logger.info('insights digest sent', { ...s });
        return sent;
      })
      .catch((err: unknown) => {
        options.logger.error('insights digest failed', { error: err instanceof Error ? err.message : String(err) });
        return [];
      })
      .finally(() => {
        running = null;
      });
    return running;
  };
  const timer = setInterval(() => void runNow(), options.intervalMs ?? DIGEST_INTERVAL_MS);
  timer.unref();
  return {
    runNow,
    async stop() {
      clearInterval(timer);
      await running;
    },
  };
}
