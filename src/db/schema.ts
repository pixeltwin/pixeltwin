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
export type ProjectRole = (typeof PROJECT_ROLES)[number];
/** `pending`: signed up, waiting for an admin; `rejected`: an admin said no. Neither may use anything. */
export const USER_STATUSES = ['active', 'pending', 'rejected'] as const;
export type UserStatus = (typeof USER_STATUSES)[number];
export const LINK_PURPOSES = ['invite', 'password_reset', 'verify_email'] as const;
export type LinkPurpose = (typeof LINK_PURPOSES)[number];
export const REQUEST_STATUSES = ['pending', 'approved', 'rejected'] as const;
export type RequestStatus = (typeof REQUEST_STATUSES)[number];

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
  /** The page elements the SDK measured with the screenshot (`element_sets.sha`); null without. */
  elementsSha: Generated<string | null>;
  /** An agent's open suggestion under the `suggest` policy: the check stays pending until a person decides. */
  suggestion: Generated<Suggestion | null>;
  /** The token that suggested, and its name when it suggested. */
  suggestedBy: Generated<string | null>;
  suggestedByName: Generated<string | null>;
  suggestionReason: Generated<string | null>;
  suggestedAt: Generated<number | null>;
  /**
   * The set of this changed check's change fingerprints (diff/fingerprint.ts); checks of a build
   * with the same key form a change group. Null when unchanged, new, resized or older than groups.
   */
  changeKey: string | null;
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
  status: Generated<UserStatus>;
  /** Optional, given when signing up. */
  name: Generated<string | null>;
  createdAt: number;
}

/**
 * A one-time link (spec: invites): an invite, a password reset or an email check. Only the token's
 * sha256 is stored. An invite may carry a project and role, and the global role of the new user.
 */
export interface AuthLinksTable {
  id: string;
  purpose: LinkPurpose;
  tokenHash: string;
  email: string;
  userId: string | null;
  projectId: string | null;
  projectRole: ProjectRole | null;
  globalRole: UserRole | null;
  createdBy: string | null;
  createdAt: number;
  expiresAt: number;
  usedAt: number | null;
}

/** Someone who signed up and waits for an admin (their user has status `pending`). */
export interface AccessRequestsTable {
  id: string;
  userId: string;
  note: string | null;
  /** When they confirmed their email; null without SMTP (admins see "not verified"). */
  verifiedAt: number | null;
  status: RequestStatus;
  decidedBy: string | null;
  decidedAt: number | null;
  reason: string | null;
  createdAt: number;
}

export interface ServerSettingsTable {
  key: string;
  value: string;
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
  projectMembers: ProjectMembersTable;
  authLinks: AuthLinksTable;
  accessRequests: AccessRequestsTable;
  serverSettings: ServerSettingsTable;
  sessions: SessionsTable;
  reviewEvents: ReviewEventsTable;
  snapshotAreas: SnapshotAreasTable;
  storedObjects: StoredObjectsTable;
  integrations: IntegrationsTable;
  integrationSyncs: IntegrationSyncsTable;
  integrationMerges: IntegrationMergesTable;
  webhooks: WebhooksTable;
  webhookDeliveries: WebhookDeliveriesTable;
  elementSets: ElementSetsTable;
}

export type UserRow = Selectable<UsersTable>;
export type Project = Omit<Selectable<ProjectsTable>, 'buildSeq' | 'autoApproveNew' | 'visibleToAll'> & {
  autoApproveNew: boolean;
  visibleToAll: boolean;
};
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
