import { z } from '@hono/zod-openapi';
import {
  ACTOR_KINDS,
  AGENT_REVIEW_POLICIES,
  AREA_KINDS,
  BUILD_STATES,
  CHECK_RESULTS,
  CHECK_REVIEWS,
  REVIEW_ACTIONS,
  SUGGESTIONS,
  USER_ROLES,
} from '../db/schema';
import { CHANGE_KINDS } from '../diff/types';
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
    agentReview: z.enum(AGENT_REVIEW_POLICIES).openapi({
      description:
        "What a project token's approve or reject does. off: it applies. suggest: it is recorded as a suggestion " +
        'and the check stays pending until a person accepts or dismisses it. auto-below: approvals of a diff up to ' +
        'agentMaxDiffPercent apply, others (and new screenshots) become suggestions; rejections apply. ' +
        'Unless off, a token must give a reason.',
    }),
    agentMaxDiffPercent: z
      .number()
      .openapi({ description: 'With agentReview "auto-below": the largest diff percent a token may approve itself' }),
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
      suggested: z.number().int().openapi({
        description: "Checks with an agent's open suggestion, waiting for a person to accept or dismiss it",
      }),
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
const FromTo = z.object({ from: z.string().nullable(), to: z.string().nullable() });

export const ElementChangeSchema = z
  .object({
    kind: z.enum(CHANGE_KINDS).openapi({
      description: 'The most telling aspect: added or removed, else text, style, resized, moved',
    }),
    kinds: z.array(z.enum(CHANGE_KINDS)).openapi({ description: 'Every aspect that changed' }),
    key: z.string().openapi({
      description: 'The element: [data-testid=…], #id, role=…[name="…"] or a CSS path (the baseline key for removed)',
      example: '[data-testid=submit]',
    }),
    tag: z.string(),
    role: z.string().nullable(),
    label: z.string().openapi({ description: 'How the summary names the element' }),
    from: RectSchema.nullable().openapi({ description: 'Box in the baseline, screenshot pixels; null when added' }),
    to: RectSchema.nullable().openapi({ description: 'Box in the new screenshot; null when removed' }),
    dx: z.number().int().optional(),
    dy: z.number().int().optional().openapi({ description: 'Moved down by this many pixels (negative: up)' }),
    dw: z.number().int().optional(),
    dh: z.number().int().optional(),
    text: FromTo.optional(),
    style: z.record(z.string(), FromTo).optional().openapi({ description: 'color, background, fontSize' }),
    inside: z
      .number()
      .int()
      .optional()
      .openapi({ description: 'Elements inside it that changed the same way (not listed on their own)' }),
    regions: z.array(z.number().int()).openapi({ description: 'Indexes into diff.regions that this change explains' }),
    description: z.string().openapi({ example: '`button[data-testid=submit]` moved 4 px down' }),
  })
  .openapi('ElementChange');

export const SnapshotElementSchema = z
  .object({
    key: z.string(),
    path: z.string().optional(),
    tag: z.string(),
    role: z.string().optional(),
    name: z.string().optional(),
    text: z.string().optional(),
    x: z.number().int(),
    y: z.number().int(),
    width: z.number().int(),
    height: z.number().int(),
    style: z
      .object({ color: z.string().optional(), background: z.string().optional(), fontSize: z.string().optional() })
      .optional(),
  })
  .openapi('SnapshotElement');

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
    changes: z
      .array(ElementChangeSchema)
      .optional()
      .openapi({
        description:
          'Element by element (moved, resized, text, style, added, removed), most important first, at most 50. ' +
          'Only when both the baseline and this check came with elements; then the summary names elements too.',
      }),
    changesTruncated: z.boolean().optional(),
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
    actorKind: z
      .enum(ACTOR_KINDS)
      .openapi({ description: 'user: a person; token: a project token (an agent or CI); auto: auto-approve-new' }),
    actorName: z.string().nullable().openapi({ description: "The token's name when it acted; null for people" }),
    comment: z.string().nullable().openapi({ description: 'The reason given' }),
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
    elementCount: z
      .number()
      .int()
      .nullable()
      .openapi({ description: 'Page elements the SDK sent with the screenshot; null when none' }),
    suggestion: z
      .object({
        action: z.enum(SUGGESTIONS),
        reason: z.string().nullable(),
        by: z.object({ kind: z.literal('token'), id: z.string(), name: z.string().nullable() }),
        at: z.number().int(),
      })
      .nullable()
      .openapi({
        description:
          "An agent's open suggestion (agent review policy): the check stays pending until a person accepts or dismisses it",
      }),
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
