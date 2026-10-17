import { z } from '@hono/zod-openapi';
import {
  AREA_KINDS,
  BUILD_STATES,
  CHECK_RESULTS,
  CHECK_REVIEWS,
  DELIVERY_STATES,
  PROVIDERS,
  REVIEW_ACTIONS,
  USER_ROLES,
  WEBHOOK_EVENTS,
  WEBHOOK_FORMATS,
} from '../db/schema';
import { TOKEN_SCOPES } from '../domain/auth/tokens';

// Response schemas. They document the API in openapi.json and type-check every handler's output.

export const ProblemSchema = z
  .object({
    type: z.string(),
    title: z.string(),
    status: z.number().int(),
    code: z.string().openapi({ example: 'build_finalized' }),
    detail: z.string(),
    requestId: z.string(),
    errors: z.array(z.object({ path: z.string(), message: z.string() })).optional(),
  })
  .openapi('Problem');

export const UserSchema = z
  .object({ id: z.string(), email: z.string(), role: z.enum(USER_ROLES), createdAt: z.number().int() })
  .openapi('User');

export const ProjectSchema = z
  .object({
    id: z.string(),
    slug: z.string(),
    name: z.string(),
    mainBranch: z.string(),
    colorThreshold: z.number(),
    tolerancePercent: z.number(),
    retentionDays: z.number().int(),
    autoApproveNew: z
      .boolean()
      .openapi({ description: 'A new screenshot (no baseline yet) is approved as soon as it arrives' }),
    createdAt: z.number().int(),
    updatedAt: z.number().int(),
  })
  .openapi('Project');

export const TokenSchema = z
  .object({
    id: z.string(),
    projectId: z.string(),
    name: z.string(),
    scopes: z.array(z.enum(TOKEN_SCOPES)),
    prefix: z.string(),
    lastUsedAt: z.number().int().nullable(),
    createdAt: z.number().int(),
  })
  .openapi('Token');

export const CreatedTokenSchema = TokenSchema.extend({
  token: z.string().openapi({ description: 'The full token. Shown only in this response.' }),
}).openapi('CreatedToken');

const countsBy = <T extends readonly string[]>(keys: T) =>
  z.object(Object.fromEntries(keys.map((k) => [k, z.number().int()])) as { [K in T[number]]: z.ZodNumber });

export const BuildSchema = z
  .object({
    id: z.string(),
    projectId: z.string(),
    number: z.number().int().openapi({ description: 'Sequential per project: #1, #2, …' }),
    branch: z.string(),
    baseBranch: z.string(),
    externalId: z.string().nullable(),
    commitSha: z.string().nullable(),
    repository: z
      .string()
      .nullable()
      .openapi({ description: '`owner/name` of the repository the commit is in; the SDK fills it in from CI' }),
    pullRequest: z
      .number()
      .int()
      .nullable()
      .openapi({ description: 'The pull (merge) request CI ran for; the GitHub integration comments on it' }),
    state: z.enum(BUILD_STATES),
    createdAt: z.number().int(),
    finalizedAt: z.number().int().nullable(),
    parallelTotal: z
      .number()
      .int()
      .nullable()
      .openapi({ description: 'A parallel build: how many parts (CI jobs) finalize it; null for an ordinary build' }),
    partsFinished: z.number().int().openapi({ description: 'Parts of a parallel build that have finalized it' }),
    timing: z
      .object({
        checks: z.number().int(),
        screenshotMs: z.number().int(),
        uploadMs: z.number().int(),
        retakes: z.number().int(),
        compareMs: z.number().int(),
      })
      .openapi({
        description:
          'How long pixeltwin took, in ms: what the SDK measured for `checks` checks (screenshots, uploads, retakes) ' +
          'and the server time of every check (compareMs)',
      }),
    verdict: z.enum(['empty', 'error', 'rejected', 'pending', 'outdated', 'passed']),
    counts: z.object({
      total: z.number().int(),
      result: countsBy(CHECK_RESULTS),
      review: countsBy(CHECK_REVIEWS),
      autoApproved: z
        .number()
        .int()
        .openapi({ description: "Approved by the project's auto-approve-new setting (part of review.approved)" }),
      withAreas: z.number().int().openapi({ description: 'Checks whose snapshot has drawn ignore or compare areas' }),
    }),
  })
  .openapi('Build');

export const BranchSummarySchema = z
  .object({
    branch: z.string(),
    latest: BuildSchema,
    recent: z
      .array(
        z.object({
          id: z.string(),
          number: z.number().int(),
          verdict: z.enum(['empty', 'error', 'rejected', 'pending', 'outdated', 'passed']),
          createdAt: z.number().int(),
        }),
      )
      .openapi({ description: 'The last 10 builds of the branch, newest first' }),
  })
  .openapi('BranchSummary');

const RectSchema = z.object({
  x: z.number().int(),
  y: z.number().int(),
  width: z.number().int(),
  height: z.number().int(),
});
const SizeSchema = z.object({ width: z.number().int(), height: z.number().int() });

export const DiffSchema = z
  .object({
    percent: z.number(),
    pixels: z.number().int(),
    colorThreshold: z.number(),
    tolerancePercent: z.number(),
    dimensions: z.object({ baseline: SizeSchema, current: SizeSchema }).nullable(),
    regions: z.array(RectSchema.extend({ pixels: z.number().int() })),
    regionsTruncated: z.boolean(),
    summary: z.string(),
  })
  .openapi('Diff');

export const DiffErrorSchema = z
  .object({ error: z.object({ code: z.enum(['diff_timeout', 'diff_failed']), message: z.string() }) })
  .openapi('DiffError');

export const AreaSchema = z
  .object({
    id: z.string(),
    projectId: z.string(),
    snapshotKey: z.string(),
    kind: z.enum(AREA_KINDS).openapi({
      description: 'ignore: skip these pixels; compare: compare only inside the compare areas.',
    }),
    x: z.number().int(),
    y: z.number().int(),
    width: z.number().int(),
    height: z.number().int(),
    createdBy: z.string(),
    createdAt: z.number().int(),
  })
  .openapi('Area');

export const ReviewEventSchema = z
  .object({
    id: z.string(),
    checkId: z.string(),
    projectId: z.string(),
    action: z.enum(REVIEW_ACTIONS),
    actor: z.string().openapi({ description: 'The user or project token that acted (an id, like reviewedBy).' }),
    comment: z.string().nullable(),
    createdAt: z.number().int(),
  })
  .openapi('ReviewEvent');

export const CheckSchema = z
  .object({
    id: z.string(),
    buildId: z.string(),
    projectId: z.string(),
    name: z.string(),
    variant: z.record(z.string(), z.string()),
    snapshotKey: z.string(),
    imageSha: z.string(),
    baseline: z.object({ id: z.string(), branch: z.string(), fallback: z.boolean(), imageSha: z.string() }).nullable(),
    diffImageSha: z.string().nullable(),
    ignoreRegions: z.array(RectSchema),
    colorThreshold: z.number(),
    tolerancePercent: z.number(),
    result: z.enum(CHECK_RESULTS),
    review: z.enum(CHECK_REVIEWS),
    diff: z.union([DiffSchema, DiffErrorSchema]).nullable(),
    reviewedBy: z.string().nullable(),
    reviewedAt: z.number().int().nullable(),
    reviewComment: z.string().nullable(),
    compareMs: z
      .number()
      .int()
      .nullable()
      .openapi({ description: 'Server time this check took, in ms: baseline, compare and store' }),
    supersededBy: z.string().nullable().openapi({
      description:
        'Set when review is "outdated": the check of a newer build of this branch whose approval decided this screen.',
    }),
    createdAt: z.number().int(),
    updatedAt: z.number().int(),
    links: z.object({
      image: z.string(),
      baseline: z.string().nullable(),
      diff: z.string().nullable(),
      review: z.string(),
    }),
  })
  .openapi('Check');

export const BaselineSchema = z
  .object({
    id: z.string(),
    projectId: z.string(),
    snapshotKey: z.string(),
    name: z.string(),
    variant: z.record(z.string(), z.string()),
    branch: z.string(),
    imageSha: z.string(),
    sourceCheckId: z.string().nullable(),
    approvedBy: z.string(),
    createdAt: z.number().int(),
  })
  .openapi('Baseline');

export const IntegrationSchema = z
  .object({
    configured: z.boolean().openapi({ description: 'False until the integration is first saved' }),
    provider: z.enum(PROVIDERS),
    repository: z.string().nullable().openapi({
      description: 'GitHub owner/name or GitLab group/sub/project; used when a build names none, and to match webhooks',
    }),
    baseUrl: z.string().openapi({ description: "GitHub's API URL or the GitLab instance URL" }),
    tokenSet: z.boolean(),
    tokenLast4: z
      .string()
      .nullable()
      .openapi({ description: "The token's last four characters; the token is never returned" }),
    commitStatus: z.boolean().openapi({ description: 'Post the pixeltwin/<slug> commit status' }),
    prComment: z.boolean().openapi({ description: 'Keep one pull/merge request comment per build up to date' }),
    autoPromote: z
      .boolean()
      .openapi({ description: 'A merged pull/merge request promotes its branch into the branch it was merged into' }),
    webhookSecretSet: z.boolean(),
    webhookUrl: z.string().openapi({ description: "Where the code host's webhook sends merge events (auto-promote)" }),
    encrypted: z.boolean().openapi({ description: 'Secrets are encrypted at rest (SECRET_KEY is set)' }),
    lastSync: z
      .object({ buildId: z.string(), at: z.number().int(), error: z.string().nullable() })
      .nullable()
      .openapi({ description: 'The last report to the code host, and its error if it failed' }),
    lastMerge: z
      .object({
        repository: z.string(),
        pullRequest: z.number().int(),
        headBranch: z.string(),
        baseBranch: z.string(),
        mergedBy: z.string().nullable(),
        promoted: z.number().int().nullable(),
        at: z.number().int(),
      })
      .nullable(),
    updatedAt: z.number().int().nullable(),
  })
  .openapi('Integration');

export const DeliverySchema = z
  .object({
    id: z.string().openapi({ description: 'Also sent as X-Pixeltwin-Delivery; the same on every retry' }),
    event: z.string().openapi({ description: 'A webhook event, or ping for Send test' }),
    state: z.enum(DELIVERY_STATES),
    attempts: z.number().int(),
    statusCode: z.number().int().nullable(),
    error: z.string().nullable(),
    durationMs: z.number().int().nullable(),
    createdAt: z.number().int(),
    finishedAt: z.number().int().nullable(),
  })
  .openapi('Delivery');

export const WebhookSchema = z
  .object({
    id: z.string(),
    projectId: z.string(),
    url: z.string(),
    events: z.array(z.enum(WEBHOOK_EVENTS)),
    format: z
      .enum(WEBHOOK_FORMATS)
      .openapi({ description: "json: pixeltwin's payload; slack: a Slack-compatible { text, blocks }" }),
    enabled: z.boolean(),
    secretLast4: z
      .string()
      .openapi({ description: "The signing secret's last four characters; the secret is never returned" }),
    createdAt: z.number().int(),
    updatedAt: z.number().int(),
    lastDelivery: DeliverySchema.nullable(),
  })
  .openapi('Webhook');

export const CreatedWebhookSchema = WebhookSchema.extend({
  secret: z
    .string()
    .nullable()
    .openapi({ description: 'The generated signing secret, shown only in this response; null when you chose it' }),
}).openapi('CreatedWebhook');

export const InboundResultSchema = z
  .object({
    handled: z.boolean().openapi({ description: 'False for events other than a merged pull/merge request' }),
    detail: z.string(),
    results: z.array(
      z.object({
        project: z.string(),
        outcome: z.enum(['promoted', 'already_promoted', 'auto_promote_off', 'same_branch']),
        promoted: z.number().int(),
      }),
    ),
  })
  .openapi('InboundWebhookResult');

export function pageOf<T extends z.ZodType>(item: T, name: string) {
  return z.object({ items: z.array(item), nextCursor: z.string().nullable() }).openapi(name);
}

/** Standard problem responses for a route's `responses` block. */
export function problems(...statuses: number[]) {
  return Object.fromEntries(
    statuses.map((status) => [
      status,
      { description: 'Problem', content: { 'application/problem+json': { schema: ProblemSchema } } },
    ]),
  );
}

export function json<T extends z.ZodType>(schema: T, description: string) {
  return { description, content: { 'application/json': { schema } } };
}

export const PageQuerySchema = z.object({
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});
