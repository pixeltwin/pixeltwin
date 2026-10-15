import { z } from '@hono/zod-openapi';
import { BUILD_STATES, CHECK_RESULTS, CHECK_REVIEWS, USER_ROLES } from '../db/schema';
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
    verdict: z.enum(['empty', 'error', 'rejected', 'pending', 'passed']),
    counts: z.object({ total: z.number().int(), result: countsBy(CHECK_RESULTS), review: countsBy(CHECK_REVIEWS) }),
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
          verdict: z.enum(['empty', 'error', 'rejected', 'pending', 'passed']),
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
