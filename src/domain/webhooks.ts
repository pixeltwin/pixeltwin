import { z } from 'zod';
import {
  type DeliveryState,
  WEBHOOK_EVENTS,
  WEBHOOK_FORMATS,
  type WebhookEvent,
  type WebhookFormat,
  type WebhooksTable,
} from '../db/schema';
import { AppError } from '../errors';
import { newId } from '../ids';
import { outboundUrlProblem } from '../notify/outbound';
import { randomBase62 } from './auth/random';
import type { Deps } from './deps';
import { secretsOf } from './integrations';
import { getProjectBySlug } from './projects';
import { parseInput } from './schemas';

// Outgoing webhooks of a project: a URL, the events it wants and a secret that signs each delivery
// (X-Pixeltwin-Signature: sha256=<HMAC of the body>). The secret is write-only: generated when none
// is given and shown once. Deliveries are queued (notify/notifier.ts); the newest are kept per webhook.

type WebhookDeps = Pick<Deps, 'db' | 'secrets'>;

/** Deliveries kept per webhook once finished (the UI shows them). */
export const DELIVERIES_KEPT = 20;

const urlSchema = z
  .string()
  .trim()
  .max(2000)
  .superRefine((value, ctx) => {
    const problem = outboundUrlProblem(value);
    if (problem) ctx.addIssue({ code: 'custom', message: problem });
  });
const eventsSchema = z
  .array(z.enum(WEBHOOK_EVENTS))
  .min(1, 'Pick at least one event')
  .transform((events) => WEBHOOK_EVENTS.filter((e) => events.includes(e)));
const secretSchema = z.string().min(16, 'At least 16 characters').max(200);

export const createWebhookSchema = z.strictObject({
  url: urlSchema,
  /** Signs each delivery; generated (and shown once) when missing. */
  secret: z.preprocess((value) => (value === '' ? undefined : value), secretSchema.optional()),
  events: eventsSchema,
  /** `slack` posts a Slack-compatible `{ text, blocks }` message instead of pixeltwin's JSON. */
  format: z.enum(WEBHOOK_FORMATS).default('json'),
  enabled: z.boolean().default(true),
});

export const updateWebhookSchema = z.strictObject({
  url: urlSchema.optional(),
  /** A new secret; the old one stops signing at once. */
  secret: z.preprocess((value) => (value === '' ? undefined : value), secretSchema.optional()),
  events: eventsSchema.optional(),
  format: z.enum(WEBHOOK_FORMATS).optional(),
  enabled: z.boolean().optional(),
});

export interface DeliveryView {
  id: string;
  event: string;
  state: DeliveryState;
  attempts: number;
  statusCode: number | null;
  error: string | null;
  durationMs: number | null;
  createdAt: number;
  finishedAt: number | null;
}

export interface WebhookView {
  id: string;
  projectId: string;
  url: string;
  events: WebhookEvent[];
  format: WebhookFormat;
  enabled: boolean;
  /** The secret's last four characters, to recognise it. */
  secretLast4: string;
  createdAt: number;
  updatedAt: number;
  lastDelivery: DeliveryView | null;
}

function toView(row: WebhooksTable, last: DeliveryView | null): WebhookView {
  return {
    id: row.id,
    projectId: row.projectId,
    url: row.url,
    events: JSON.parse(row.events) as WebhookEvent[],
    format: row.format,
    enabled: Number(row.enabled) === 1,
    secretLast4: row.secretLast4,
    createdAt: Number(row.createdAt),
    updatedAt: Number(row.updatedAt),
    lastDelivery: last,
  };
}

function deliveriesOf(deps: Pick<Deps, 'db'>, webhookId: string, limit: number) {
  return deps.db
    .selectFrom('webhookDeliveries')
    .select(['id', 'event', 'state', 'attempts', 'statusCode', 'error', 'durationMs', 'createdAt', 'finishedAt'])
    .where('webhookId', '=', webhookId)
    .orderBy('id', 'desc')
    .limit(limit)
    .execute();
}

function deliveryView(row: Awaited<ReturnType<typeof deliveriesOf>>[number]): DeliveryView {
  return {
    ...row,
    attempts: Number(row.attempts),
    statusCode: row.statusCode === null ? null : Number(row.statusCode),
    durationMs: row.durationMs === null ? null : Number(row.durationMs),
    createdAt: Number(row.createdAt),
    finishedAt: row.finishedAt === null ? null : Number(row.finishedAt),
  };
}

async function findRow(deps: Pick<Deps, 'db'>, projectId: string, id: string): Promise<WebhooksTable> {
  const found = await deps.db
    .selectFrom('webhooks')
    .selectAll()
    .where('id', '=', id)
    .where('projectId', '=', projectId)
    .executeTakeFirst();
  if (!found) throw new AppError('webhook_not_found', 404, `Webhook ${id} not found in this project.`);
  return found;
}

export async function listWebhooks(deps: WebhookDeps, projectSlug: string): Promise<WebhookView[]> {
  const project = await getProjectBySlug(deps, projectSlug);
  const rows = await deps.db
    .selectFrom('webhooks')
    .selectAll()
    .where('projectId', '=', project.id)
    .orderBy('id')
    .execute();
  return Promise.all(
    rows.map(async (row) => {
      const [last] = await deliveriesOf(deps, row.id, 1);
      return toView(row, last ? deliveryView(last) : null);
    }),
  );
}

export async function getWebhook(deps: WebhookDeps, projectSlug: string, id: string): Promise<WebhookView> {
  const project = await getProjectBySlug(deps, projectSlug);
  const row = await findRow(deps, project.id, id);
  const [last] = await deliveriesOf(deps, id, 1);
  return toView(row, last ? deliveryView(last) : null);
}

/** Creates a webhook. `secret` is the generated one, returned only here; null when the caller chose it. */
export async function createWebhook(
  deps: WebhookDeps,
  projectSlug: string,
  input: unknown,
): Promise<{ webhook: WebhookView; secret: string | null }> {
  const data = parseInput(createWebhookSchema, input);
  const project = await getProjectBySlug(deps, projectSlug);
  const generated = data.secret ? null : `whsec_${randomBase62(32)}`;
  const secret = data.secret ?? (generated as string);
  const now = Date.now();
  const row: WebhooksTable = {
    id: newId('whk'),
    projectId: project.id,
    url: data.url,
    secret: secretsOf(deps).seal(secret),
    secretLast4: secret.slice(-4),
    events: JSON.stringify(data.events),
    format: data.format,
    enabled: data.enabled ? 1 : 0,
    createdAt: now,
    updatedAt: now,
  };
  await deps.db.insertInto('webhooks').values(row).execute();
  return { webhook: toView(row, null), secret: generated };
}

export async function updateWebhook(
  deps: WebhookDeps,
  projectSlug: string,
  id: string,
  input: unknown,
): Promise<WebhookView> {
  const changes = parseInput(updateWebhookSchema, input);
  const project = await getProjectBySlug(deps, projectSlug);
  await findRow(deps, project.id, id);
  await deps.db
    .updateTable('webhooks')
    .set({
      ...(changes.url !== undefined ? { url: changes.url } : {}),
      ...(changes.secret !== undefined
        ? { secret: secretsOf(deps).seal(changes.secret), secretLast4: changes.secret.slice(-4) }
        : {}),
      ...(changes.events !== undefined ? { events: JSON.stringify(changes.events) } : {}),
      ...(changes.format !== undefined ? { format: changes.format } : {}),
      ...(changes.enabled !== undefined ? { enabled: changes.enabled ? 1 : 0 } : {}),
      updatedAt: Date.now(),
    })
    .where('id', '=', id)
    .execute();
  return getWebhook(deps, projectSlug, id);
}

/** Deletes the webhook with its deliveries, also those still waiting. */
export async function deleteWebhook(deps: WebhookDeps, projectSlug: string, id: string): Promise<void> {
  const project = await getProjectBySlug(deps, projectSlug);
  await findRow(deps, project.id, id);
  await deps.db.deleteFrom('webhooks').where('id', '=', id).execute();
}

/** The webhook's newest deliveries, newest first (the last DELIVERIES_KEPT plus any still waiting). */
export async function listDeliveries(deps: WebhookDeps, projectSlug: string, id: string): Promise<DeliveryView[]> {
  const project = await getProjectBySlug(deps, projectSlug);
  await findRow(deps, project.id, id);
  return (await deliveriesOf(deps, id, DELIVERIES_KEPT)).map(deliveryView);
}
