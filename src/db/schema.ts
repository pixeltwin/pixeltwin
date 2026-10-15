import type { Generated, Selectable } from 'kysely';

export const BUILD_STATES = ['open', 'finalized'] as const;
export const CHECK_RESULTS = ['unchanged', 'changed', 'new', 'error'] as const;
export const CHECK_REVIEWS = ['none', 'pending', 'approved', 'rejected'] as const;
export const USER_ROLES = ['admin', 'reviewer', 'viewer'] as const;

export type BuildState = (typeof BUILD_STATES)[number];
export type CheckResult = (typeof CHECK_RESULTS)[number];
export type CheckReview = (typeof CHECK_REVIEWS)[number];
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

export interface DB {
  projects: ProjectsTable;
  images: ImagesTable;
  builds: BuildsTable;
  checks: ChecksTable;
  baselines: BaselinesTable;
  users: UsersTable;
  projectTokens: ProjectTokensTable;
  sessions: SessionsTable;
}

export type Project = Omit<Selectable<ProjectsTable>, 'buildSeq'>;
export type Build = Selectable<BuildsTable>;
export type CheckRow = Selectable<ChecksTable>;
export type Baseline = Selectable<BaselinesTable>;
