import { z } from 'zod';
import { AGENT_REVIEW_POLICIES, AREA_KINDS } from '../db/schema';
import { validationError } from '../errors';

// Input schemas shared by the domain and (in Plan 2) the HTTP layer. Objects are strict:
// unknown keys are rejected so a typo surfaces as a 422 instead of being silently ignored.

export const slugSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{1,62}$/, 'Use 2-63 lowercase letters, digits or hyphens, starting with a letter or digit');

export const branchSchema = z.string().trim().min(1).max(255);

// Coordinates fit a 32-bit integer column (snapshot_areas on Postgres).
const coordinate = z.number().int().max(2_147_483_647);

export const rectSchema = z.strictObject({
  x: coordinate.min(0),
  y: coordinate.min(0),
  width: coordinate.min(1),
  height: coordinate.min(1),
});

export const variantSchema = z
  .record(z.string().min(1).max(64), z.string().max(64))
  .refine((variant) => Object.keys(variant).length <= 10, 'At most 10 variant keys');

const colorThreshold = z.number().min(0).max(1);
const tolerancePercent = z.number().min(0).max(100);

const projectSettings = {
  name: z.string().trim().min(1).max(200),
  mainBranch: branchSchema,
  colorThreshold,
  tolerancePercent,
  retentionDays: z.number().int().min(1).max(3650),
  /** A new screenshot (no baseline yet) is approved as soon as it arrives. */
  autoApproveNew: z.boolean(),
  /** What a project token's approve or reject does: apply it (off) or record a suggestion. */
  agentReview: z.enum(AGENT_REVIEW_POLICIES),
  /** With `auto-below`: the largest diff percent a token may approve itself. */
  agentMaxDiffPercent: z.number().min(0).max(100),
};

export const createProjectSchema = z.strictObject({
  /** Optional: made from the name when missing or empty. */
  slug: z.preprocess((value) => (value === '' ? undefined : value), slugSchema.optional()),
  name: projectSettings.name,
  mainBranch: projectSettings.mainBranch.default('main'),
  colorThreshold: projectSettings.colorThreshold.default(0.1),
  tolerancePercent: projectSettings.tolerancePercent.default(0),
  // CI often runs several times a day; baselines are kept whatever the retention.
  retentionDays: projectSettings.retentionDays.default(5),
  autoApproveNew: projectSettings.autoApproveNew.default(false),
  agentReview: projectSettings.agentReview.default('off'),
  agentMaxDiffPercent: projectSettings.agentMaxDiffPercent.default(1),
});

export const updateProjectSchema = z.strictObject(projectSettings).partial();

export const createBuildSchema = z.strictObject({
  branch: branchSchema.optional(),
  baseBranch: branchSchema.optional(),
  externalId: z.string().trim().min(1).max(200).optional(),
  commitSha: z.string().trim().min(1).max(64).optional(),
  /** A parallel build: this many parts (CI jobs) each finalize it; the last one closes it. */
  parallelTotal: z.number().int().min(1).max(1000).optional(),
});

/** What one SDK worker measured, added to the build's totals. */
export const timingsSchema = z.strictObject({
  checks: z.number().int().min(0).max(1_000_000).default(0),
  screenshotMs: z.number().int().min(0).max(1e10).default(0),
  uploadMs: z.number().int().min(0).max(1e10).default(0),
  retakes: z.number().int().min(0).max(1_000_000).default(0),
});

export const finalizeBuildSchema = z.strictObject({
  /** The part (CI job) of a parallel build that is done; without it the build is finalized at once. */
  part: z.string().trim().min(1).max(200).optional(),
});

/** At most this many elements per screenshot (the SDKs send the most telling ones first). */
export const MAX_ELEMENTS = 300;

const shortText = (max: number) => z.string().max(max).optional();

/**
 * A page element measured with the screenshot (box in screenshot pixels). Unlike the rest of the
 * metadata, unknown keys are dropped rather than refused, so a newer SDK can send more.
 */
export const snapshotElementSchema = z.object({
  key: z.string().min(1).max(300),
  path: shortText(300),
  tag: z.string().min(1).max(40),
  role: shortText(40),
  name: shortText(120),
  text: shortText(120),
  x: coordinate.min(0),
  y: coordinate.min(0),
  width: coordinate.min(1),
  height: coordinate.min(1),
  style: z.object({ color: shortText(40), background: shortText(40), fontSize: shortText(20) }).optional(),
});

export const checkMetaSchema = z.strictObject({
  name: z.string().trim().min(1).max(200),
  variant: variantSchema.default({}),
  ignoreRegions: z.array(rectSchema).max(100).default([]),
  colorThreshold: colorThreshold.optional(),
  tolerancePercent: tolerancePercent.optional(),
  /** The page elements in the screenshot; with them the diff lists element changes. */
  elements: z.array(snapshotElementSchema).max(MAX_ELEMENTS).optional(),
});

/** An ignore or compare area drawn on a snapshot (Plan 6). */
export const areaInputSchema = rectSchema.extend({ kind: z.enum(AREA_KINDS) });

/** Moving or resizing an area; its kind stays (delete it and draw the other kind instead). */
export const areaUpdateSchema = rectSchema;

export const reviewInputSchema = z.strictObject({
  /** Why: kept in the review history. A token must give one when the project's agent review policy is not `off`. */
  reason: z.string().trim().max(1000).optional(),
  /** The older name of `reason`. */
  comment: z.string().trim().max(1000).optional(),
});

export const pageInputSchema = z.strictObject({
  cursor: z.string().min(1).optional(),
  limit: z.number().int().min(1).max(200).default(50),
});

export type CheckMeta = z.output<typeof checkMetaSchema>;
export type PageInput = z.input<typeof pageInputSchema>;

/** Parses input or throws a 422 `validation_failed` AppError. */
export function parseInput<S extends z.ZodType>(schema: S, input: unknown): z.output<S> {
  const result = schema.safeParse(input);
  if (!result.success) throw validationError(result.error);
  return result.data;
}
