import type { Generated, Selectable } from 'kysely';

export const BUILD_STATES = ['open', 'finalized'] as const;
export const CHECK_RESULTS = ['unchanged', 'changed', 'new', 'error'] as const;
export const CHECK_REVIEWS = ['none', 'pending', 'approved', 'rejected', 'outdated'] as const;
export const USER_ROLES = ['admin', 'reviewer', 'viewer'] as const;

export type BuildState = (typeof BUILD_STATES)[number];
export type CheckResult = (typeof CHECK_RESULTS)[number];
export type CheckReview = (typeof CHECK_REVIEWS)[number];
export const REVIEW_ACTIONS = ['approved', 'rejected', 'reset'] as const;
export type ReviewAction = (typeof REVIEW_ACTIONS)[number];
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
  /** `owner/name` of the repository the commit is in (from CI); links the build to a pull request. */
  repository: string | null;
  /** The pull (merge) request's number, when CI ran for one. */
  pullRequest: number | null;
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
  /** The verdict last announced to webhooks (finalize or a change); internal, never sent to clients. */
  notifiedVerdict: Generated<string | null>;
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

export const WEBHOOK_EVENTS = ['build.finalized', 'build.verdict_changed', 'check.reviewed'] as const;
export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];
export const WEBHOOK_FORMATS = ['json', 'slack'] as const;
export type WebhookFormat = (typeof WEBHOOK_FORMATS)[number];
export const DELIVERY_STATES = ['pending', 'delivered', 'failed'] as const;
export type DeliveryState = (typeof DELIVERY_STATES)[number];

export const PROVIDERS = ['github', 'gitlab'] as const;
export type Provider = (typeof PROVIDERS)[number];

/** A project's code host integration (one at a time). Secrets are sealed (see domain/secrets.ts); flags are 0 or 1. */
export interface IntegrationsTable {
  projectId: string;
  provider: Provider;
  /** GitHub `owner/name` or GitLab `group/sub/project`: used when a build names none, and to match incoming webhooks. */
  repository: string | null;
  /** GitHub's API URL (`https://api.github.com`, GHES `https://host/api/v3`) or the GitLab instance URL. */
  baseUrl: string;
  token: string | null;
  tokenLast4: string | null;
  commitStatus: number;
  prComment: number;
  autoPromote: number;
  /** Verifies the code host's webhook (auto-promote): GitHub's signature secret or GitLab's secret token. */
  webhookSecret: string | null;
  createdAt: number;
  updatedAt: number;
}

/** A build whose state the code host should see: coalesced, one replica at a time (`lockedUntil`). */
export interface IntegrationSyncsTable {
  buildId: string;
  projectId: string;
  requested: number;
  done: number;
  dueAt: number;
  lockedUntil: number | null;
  attempts: number;
  /** The pull request comment (GitLab: merge request note) this build edits. */
  commentId: string | null;
  lastError: string | null;
  syncedAt: number | null;
  updatedAt: number;
}

/** A merged pull (merge) request handled by auto-promote (its key makes a redelivery a no-op). */
export interface IntegrationMergesTable {
  projectId: string;
  provider: Provider;
  repository: string;
  pullRequest: number;
  headBranch: string;
  baseBranch: string;
  mergeSha: string | null;
  mergedBy: string | null;
  deliveryId: string | null;
  /** Baselines promoted; null while the promotion runs. */
  promoted: number | null;
  createdAt: number;
}

export interface WebhooksTable {
  id: string;
  projectId: string;
  url: string;
  /** Sealed; signs each delivery (X-Pixeltwin-Signature). */
  secret: string;
  secretLast4: string;
  /** JSON array of WebhookEvent. */
  events: string;
  format: WebhookFormat;
  enabled: number;
  createdAt: number;
  updatedAt: number;
}

/** One event sent (or to be sent) to one webhook; the newest are kept as its history. */
export interface WebhookDeliveriesTable {
  id: string;
  webhookId: string;
  projectId: string;
  /** A WebhookEvent, or `ping` for Send test. */
  event: string;
  /** The JSON body, fixed when the event happened. */
  payload: string;
  state: DeliveryState;
  attempts: number;
  dueAt: number;
  lockedUntil: number | null;
  statusCode: number | null;
  error: string | null;
  durationMs: number | null;
  createdAt: number;
  finishedAt: number | null;
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
  integrations: IntegrationsTable;
  integrationSyncs: IntegrationSyncsTable;
  integrationMerges: IntegrationMergesTable;
  webhooks: WebhooksTable;
  webhookDeliveries: WebhookDeliveriesTable;
}

export type Project = Omit<Selectable<ProjectsTable>, 'buildSeq' | 'autoApproveNew'> & { autoApproveNew: boolean };
export type Build = Omit<Selectable<BuildsTable>, 'notifiedVerdict'>;
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
