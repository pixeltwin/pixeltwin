import { z } from 'zod';
import { AREA_KINDS } from '../db/schema';
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
});

export const updateProjectSchema = z.strictObject(projectSettings).partial();

export const createBuildSchema = z.strictObject({
  branch: branchSchema.optional(),
  baseBranch: branchSchema.optional(),
  externalId: z.string().trim().min(1).max(200).optional(),
  commitSha: z.string().trim().min(1).max(64).optional(),
});

export const checkMetaSchema = z.strictObject({
  name: z.string().trim().min(1).max(200),
  variant: variantSchema.default({}),
  ignoreRegions: z.array(rectSchema).max(100).default([]),
  colorThreshold: colorThreshold.optional(),
  tolerancePercent: tolerancePercent.optional(),
});

/** An ignore or compare area drawn on a snapshot (Plan 6). */
export const areaInputSchema = rectSchema.extend({ kind: z.enum(AREA_KINDS) });

/** Moving or resizing an area; its kind stays (delete it and draw the other kind instead). */
export const areaUpdateSchema = rectSchema;

export const reviewInputSchema = z.strictObject({
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
