import type { Generated, Selectable } from 'kysely';

export const BUILD_STATES = ['open', 'finalized'] as const;
export const CHECK_RESULTS = ['unchanged', 'changed', 'new', 'error'] as const;
export const CHECK_REVIEWS = ['none', 'pending', 'approved', 'rejected', 'outdated'] as const;
export const USER_ROLES = ['admin', 'reviewer', 'viewer'] as const;
/** A user's role in one project (a membership); `admin` is global only. Lowest first. */
export const PROJECT_ROLES = ['viewer', 'reviewer', 'maintainer'] as const;

export type BuildState = (typeof BUILD_STATES)[number];
export type CheckResult = (typeof CHECK_RESULTS)[number];
export type CheckReview = (typeof CHECK_REVIEWS)[number];
export const REVIEW_ACTIONS = ['approved', 'rejected', 'reset'] as const;
export type ReviewAction = (typeof REVIEW_ACTIONS)[number];
export const AREA_KINDS = ['ignore', 'compare'] as const;
export type AreaKind = (typeof AREA_KINDS)[number];
export type UserRole = (typeof USER_ROLES)[number];
export type ProjectRole = (typeof PROJECT_ROLES)[number];

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
  /** 1: every user may open the project with their global role, members or not. */
  visibleToAll: Generated<number>;
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
  createdAt: number;
}

export interface UsersTable {
  id: string;
  email: string;
  passwordHash: string;
  role: UserRole;
  createdAt: number;
}

/** A non-admin user's access to one project. */
export interface ProjectMembersTable {
  projectId: string;
  userId: string;
  role: ProjectRole;
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
  comment: string | null;
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
  projectMembers: ProjectMembersTable;
  sessions: SessionsTable;
  reviewEvents: ReviewEventsTable;
  snapshotAreas: SnapshotAreasTable;
  storedObjects: StoredObjectsTable;
}

export type Project = Omit<Selectable<ProjectsTable>, 'buildSeq' | 'autoApproveNew' | 'visibleToAll'> & {
  autoApproveNew: boolean;
  visibleToAll: boolean;
};
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
