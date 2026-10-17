import type { Generated, Selectable } from 'kysely';

export const BUILD_STATES = ['open', 'finalized'] as const;
export const CHECK_RESULTS = ['unchanged', 'changed', 'new', 'error'] as const;
export const CHECK_REVIEWS = ['none', 'pending', 'approved', 'rejected', 'outdated'] as const;
export const USER_ROLES = ['admin', 'reviewer', 'viewer'] as const;

export type BuildState = (typeof BUILD_STATES)[number];
export type CheckResult = (typeof CHECK_RESULTS)[number];
export type CheckReview = (typeof CHECK_REVIEWS)[number];
export const REVIEW_ACTIONS = [
  'approved',
  'rejected',
  'reset',
  'suggested_approval',
  'suggested_rejection',
  'suggestion_dismissed',
] as const;
export type ReviewAction = (typeof REVIEW_ACTIONS)[number];
/** Who reviewed: a person, a project token (an agent or CI) or the auto-approve-new setting. */
export const ACTOR_KINDS = ['user', 'token', 'auto'] as const;
export type ActorKind = (typeof ACTOR_KINDS)[number];
/** What a token's approve or reject does (project setting). */
export const AGENT_REVIEW_POLICIES = ['off', 'suggest', 'auto-below'] as const;
export type AgentReviewPolicy = (typeof AGENT_REVIEW_POLICIES)[number];
export const SUGGESTIONS = ['approve', 'reject'] as const;
export type Suggestion = (typeof SUGGESTIONS)[number];
export const AREA_KINDS = ['ignore', 'compare'] as const;
export type AreaKind = (typeof AREA_KINDS)[number];
export type UserRole = (typeof USER_ROLES)[number];

// Timestamps are epoch milliseconds. JSON values are stored as text.

export interface ProjectsTable {
  id: string;
  slug: string;
  name: string;
  mainBranch: string;
  colorThreshold: number;
  tolerancePercent: number;
  retentionDays: number;
  /** 1: a new screenshot is approved as soon as it arrives. The domain's Project has a boolean. */
  autoApproveNew: Generated<number>;
  /** What a project token's approve or reject does: apply it, or record it as a suggestion. */
  agentReview: Generated<AgentReviewPolicy>;
  /** With `auto-below`: token approvals of a diff up to this percent apply; larger ones are suggestions. */
  agentMaxDiffPercent: Generated<number>;
  /** The last build number handed out (UI spec §3.5); internal, never sent to clients. */
  buildSeq: Generated<number>;
  createdAt: number;
  updatedAt: number;
}

export interface ImagesTable {
  sha: string;
  width: number;
  height: number;
  bytes: number;
  createdAt: number;
}

export interface BuildsTable {
  id: string;
  projectId: string;
  /** Sequential per project: #1, #2, … */
  number: number;
  branch: string;
  baseBranch: string;
  externalId: string | null;
  commitSha: string | null;
  state: BuildState;
  createdAt: number;
  finalizedAt: number | null;
  /** A parallel build: how many parts (CI jobs) finalize it; null for an ordinary build. */
  parallelTotal: number | null;
  /** What the SDK measured in its workers, added up (POST /builds/{id}/timings). */
  timingChecks: Generated<number>;
  timingScreenshotMs: Generated<number>;
  timingUploadMs: Generated<number>;
  timingRetakes: Generated<number>;
}

/** A finished part of a parallel build. */
export interface BuildPartsTable {
  buildId: string;
  part: string;
  finishedAt: number;
}

export interface ChecksTable {
  id: string;
  buildId: string;
  projectId: string;
  name: string;
  variant: string;
  snapshotKey: string;
  imageSha: string;
  baselineId: string | null;
  diffImageSha: string | null;
  ignoreRegions: string;
  colorThreshold: number;
  tolerancePercent: number;
  result: CheckResult;
  review: CheckReview;
  diff: string | null;
  reviewedBy: string | null;
  reviewedAt: number | null;
  reviewComment: string | null;
  /** The check whose approval in a newer build of this branch made this one `outdated`. */
  supersededBy: string | null;
  /** Server time this check took: baseline, compare and store (null before timings were kept). */
  compareMs: number | null;
  /** The page elements the SDK measured with the screenshot (`element_sets.sha`); null without. */
  elementsSha: Generated<string | null>;
  /** An agent's open suggestion under the `suggest` policy: the check stays pending until a person decides. */
  suggestion: Generated<Suggestion | null>;
  /** The token that suggested, and its name when it suggested. */
  suggestedBy: Generated<string | null>;
  suggestedByName: Generated<string | null>;
  suggestionReason: Generated<string | null>;
  suggestedAt: Generated<number | null>;
  createdAt: number;
  updatedAt: number;
}

export interface BaselinesTable {
  id: string;
  projectId: string;
  snapshotKey: string;
  name: string;
  variant: string;
  branch: string;
  imageSha: string;
  sourceCheckId: string | null;
  approvedBy: string;
  /** The elements of the check it was approved from: kept when retention deletes that check. */
  elementsSha: Generated<string | null>;
  createdAt: number;
}

export interface UsersTable {
  id: string;
  email: string;
  passwordHash: string;
  role: UserRole;
  createdAt: number;
}

export interface ProjectTokensTable {
  id: string;
  projectId: string;
  name: string;
  scopes: string;
  prefix: string;
  secretHash: string;
  lastUsedAt: number | null;
  createdAt: number;
}

export interface SessionsTable {
  id: string;
  userId: string;
  tokenHash: string;
  expiresAt: number;
  createdAt: number;
}

/** One approval, rejection or undo of a check (UI spec §5.2, review history). Append-only. */
export interface ReviewEventsTable {
  id: string;
  checkId: string;
  projectId: string;
  action: ReviewAction;
  /** The user or project token that acted, like `checks.reviewed_by`. */
  actor: string;
  actorKind: Generated<ActorKind>;
  /** A token's name when it acted (tokens can be deleted later); null for users. */
  actorName: Generated<string | null>;
  /** The reason given (`reason`, or `comment` in older clients). */
  comment: string | null;
  createdAt: number;
}

/** Page elements measured with a screenshot (JSON), once per content hash. */
export interface ElementSetsTable {
  sha: string;
  data: string;
  count: number;
  createdAt: number;
}

/**
 * A rectangle drawn on a snapshot in the UI (Plan 6). `ignore` skips its pixels; `compare`
 * limits the comparison to the compare areas. Applies to every check of the snapshot.
 */
export interface SnapshotAreasTable {
  id: string;
  projectId: string;
  snapshotKey: string;
  kind: AreaKind;
  x: number;
  y: number;
  width: number;
  height: number;
  createdBy: string;
  createdAt: number;
}

export interface DB {
  projects: ProjectsTable;
  images: ImagesTable;
  builds: BuildsTable;
  buildParts: BuildPartsTable;
  checks: ChecksTable;
  baselines: BaselinesTable;
  users: UsersTable;
  projectTokens: ProjectTokensTable;
  sessions: SessionsTable;
  reviewEvents: ReviewEventsTable;
  snapshotAreas: SnapshotAreasTable;
  storedObjects: StoredObjectsTable;
  elementSets: ElementSetsTable;
}

export type Project = Omit<Selectable<ProjectsTable>, 'buildSeq' | 'autoApproveNew'> & { autoApproveNew: boolean };
export type Build = Selectable<BuildsTable>;
export type CheckRow = Selectable<ChecksTable>;
export type Baseline = Selectable<BaselinesTable>;
export type ReviewEvent = Selectable<ReviewEventsTable>;
export type SnapshotArea = Selectable<SnapshotAreasTable>;

/** Image bytes when STORAGE=postgres (keys as for any storage: `images/ab/cd/<sha>.png`). */
export interface StoredObjectsTable {
  key: string;
  data: Uint8Array;
  createdAt: number;
}
