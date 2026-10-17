import type { RejectReason } from './reasons.js';

// The API shapes the SDK reads, as in openapi.json.

export type Verdict = 'empty' | 'error' | 'rejected' | 'pending' | 'outdated' | 'passed';
export type CheckResult = 'unchanged' | 'changed' | 'new' | 'error';
export type CheckReview = 'none' | 'pending' | 'approved' | 'rejected' | 'outdated';
export type Variant = Record<string, string>;

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface BuildCounts {
  total: number;
  result: Record<CheckResult, number>;
  review: Record<CheckReview, number>;
  /** Approved by the project's auto-approve-new setting (part of `review.approved`). */
  autoApproved: number;
  /** Checks whose snapshot has drawn ignore or compare areas. */
  withAreas: number;
  /** Checks with an agent's open suggestion, waiting for a person (agent review policy). */
  suggested: number;
  /** Unchanged only because the diff is within the tolerance, whatever their review (servers before it leave it out). */
  withinTolerance?: number;
  /** Of withinTolerance, those that passed with no review. */
  withinTolerancePassed?: number;
}

/** A branch screen whose baseline differs from main's: what a promotion would change. */
export interface PromotionCandidate {
  snapshotKey: string;
  name: string;
  variant: Record<string, string>;
  branchImageSha: string;
  mainImageSha: string | null;
  approvedAt: number;
}

export interface Build {
  id: string;
  projectId: string;
  /** Sequential per project: #1, #2, … */
  number: number;
  branch: string;
  baseBranch: string;
  externalId: string | null;
  commitSha: string | null;
  /** `owner/name` of the repository the commit is in. */
  repository: string | null;
  /** The pull (merge) request CI ran for. */
  pullRequest: number | null;
  state: 'open' | 'finalized';
  createdAt: number;
  finalizedAt: number | null;
  /** A parallel build: how many parts (CI jobs) finalize it; null for an ordinary build. */
  parallelTotal: number | null;
  /** Parts of a parallel build that have finalized it so far. */
  partsFinished: number;
  /**
   * How long pixeltwin took, in ms: what the SDK measured for `checks` checks (screenshots, uploads,
   * retakes) and the server time of every check (`compareMs`).
   */
  timing: { checks: number; screenshotMs: number; uploadMs: number; retakes: number; compareMs: number };
  /** Only `passed` is success. */
  verdict: Verdict;
  counts: BuildCounts;
}

/**
 * A page element measured with a screenshot. The SDKs send them (box in screenshot pixels) so the
 * diff can name what changed. `key`: `[data-testid=…]`, `#id`, `role=…[name="…"]` or a CSS path.
 */
export interface PageElement extends Rect {
  key: string;
  /** The CSS path, also when the key is something else. */
  path?: string | undefined;
  tag: string;
  role?: string | undefined;
  /** Accessible name. */
  name?: string | undefined;
  /** A short snippet of the visible text. */
  text?: string | undefined;
  /** Colours as `#rrggbb`; `fontSize` as computed (`16px`). */
  style?: { color?: string | undefined; background?: string | undefined; fontSize?: string | undefined } | undefined;
}

export type ChangeKind = 'moved' | 'resized' | 'text' | 'style' | 'added' | 'removed';

/** A change of one element between the baseline and the new screenshot. */
export interface ElementChange {
  kind: ChangeKind;
  kinds: ChangeKind[];
  key: string;
  tag: string;
  role: string | null;
  label: string;
  from: Rect | null;
  to: Rect | null;
  dx?: number;
  dy?: number;
  dw?: number;
  dh?: number;
  text?: { from: string | null; to: string | null };
  style?: Record<string, { from: string | null; to: string | null }>;
  inside?: number;
  /** Indexes into `Diff.regions` that this change explains. */
  regions: number[];
  /** One sentence: "`button[data-testid=submit]` moved 4 px down". */
  description: string;
}

export interface Diff {
  percent: number;
  pixels: number;
  colorThreshold: number;
  tolerancePercent: number;
  dimensions: { baseline: { width: number; height: number }; current: { width: number; height: number } } | null;
  regions: (Rect & { pixels: number })[];
  regionsTruncated: boolean;
  /** One sentence; names elements when both screenshots came with elements. */
  summary: string;
  /** Element by element, most important first; only when both screenshots came with elements. */
  changes?: ElementChange[];
  changesTruncated?: boolean;
}

/** An agent's open suggestion (agent review policy): the check waits for a person. */
export interface Suggestion {
  action: 'approve' | 'reject';
  reason: string | null;
  /** A suggested rejection's category (servers before reject reasons leave it out). */
  reasonCode?: RejectReason | null;
  by: { kind: 'token'; id: string; name: string | null };
  at: number;
}

export interface DiffError {
  error: { code: 'diff_timeout' | 'diff_failed'; message: string };
}

export interface Check {
  id: string;
  buildId: string;
  projectId: string;
  name: string;
  variant: Variant;
  snapshotKey: string;
  imageSha: string;
  baseline: { id: string; branch: string; fallback: boolean; imageSha: string } | null;
  diffImageSha: string | null;
  ignoreRegions: Rect[];
  colorThreshold: number;
  tolerancePercent: number;
  result: CheckResult;
  review: CheckReview;
  /**
   * Unchanged only because the diff is within the tolerance: some pixels differ (`diff.percent`,
   * at most `tolerancePercent`). Servers before it leave it out.
   */
  withinTolerance?: boolean;
  diff: Diff | DiffError | null;
  reviewedBy: string | null;
  reviewedAt: number | null;
  reviewComment: string | null;
  /** The category of the current rejection (servers before reject reasons leave it out). */
  reviewReasonCode?: RejectReason | null;
  /** Server time this check took, in ms: baseline, compare and store. */
  compareMs: number | null;
  /** Page elements sent with the screenshot; null when none. */
  elementCount: number | null;
  suggestion: Suggestion | null;
  /** The change group: other checks of this build with exactly the same changes; null when none. */
  groupId?: string | null;
  createdAt: number;
  updatedAt: number;
  /** Paths from the server root: API images and the review page. */
  links: { image: string; baseline: string | null; diff: string | null; review: string };
}

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

export interface OpenBuildInput {
  /** Defaults to the project's main branch on the server. */
  branch?: string;
  baseBranch?: string;
  commitSha?: string;
  /** `owner/name` (GitLab: `group/project`); with `pullRequest`, where the GitHub integration reports. */
  repository?: string;
  /** The pull (merge) request number CI ran for. */
  pullRequest?: number;
  /** Opening again with the same id returns the same build. Generated when missing. */
  externalId?: string;
  /**
   * A parallel build: this many parts (CI jobs, with the same `externalId`) each finalize it with
   * their `part`; the last one closes it.
   */
  parallelTotal?: number;
}

export interface CheckInput {
  name: string;
  /** PNG bytes. */
  image: Uint8Array;
  /** Separates baselines: the snapshot is the name plus the variant. */
  variant?: Variant;
  /** Image pixels never compared. */
  ignoreRegions?: Rect[];
  colorThreshold?: number;
  tolerancePercent?: number;
  /** A diff within the tolerance waits for review instead of passing (default: the project's setting). */
  reviewWithinTolerance?: boolean;
  /** Page elements in the screenshot (screenshot pixels), at most 300: the diff then names what changed. */
  elements?: PageElement[];
}

/** One entry of a check's review history. */
export interface ReviewEvent {
  id: string;
  checkId: string;
  projectId: string;
  action: 'approved' | 'rejected' | 'reset' | 'suggested_approval' | 'suggested_rejection' | 'suggestion_dismissed';
  actor: string;
  actorKind: 'user' | 'token' | 'auto';
  actorName: string | null;
  comment: string | null;
  /** A rejection's category (servers before reject reasons leave it out). */
  reasonCode?: RejectReason | null;
  createdAt: number;
}

/** What a token's approve or reject did: applied, or recorded as a suggestion for a person. */
export type ReviewOutcome = 'applied' | 'suggested';

/** An ignore or compare area drawn on a snapshot. */
export interface Area extends Rect {
  id: string;
  projectId: string;
  snapshotKey: string;
  kind: 'ignore' | 'compare';
  createdBy: string;
  createdAt: number;
}

/** Checks of one build with exactly the same changes (the same change on several screens). */
export interface ChangeGroup {
  /** The members' change key. */
  id: string;
  buildId: string;
  /** Members (at least 2). */
  size: number;
  /** Members per review state. */
  counts: Record<'pending' | 'approved' | 'rejected' | 'outdated', number>;
  /** The changes, as found on the first member. */
  regions: (Rect & { pixels: number; fingerprint?: string })[];
  /** Members, newest first. */
  checks: Array<{
    id: string;
    name: string;
    variant: Variant;
    review: CheckReview;
    reviewedBy: string | null;
    /** An agent's open suggestion for the check, if any. */
    suggestion: 'approve' | 'reject' | null;
    imageSha: string;
    diffImageSha: string | null;
    baselineImageSha: string | null;
  }>;
}

/** What a group approve or reject did. */
export interface GroupReview {
  /** Checks this call reviewed. */
  changed: string[];
  /** Checks a token's review left as suggestions for a person (agent review policy). */
  suggested: string[];
  /** Members left as they were (already reviewed, outdated, or not in `checkIds`). */
  skipped: Array<{ checkId: string; review: CheckReview }>;
  group: ChangeGroup;
  /** The build's verdict after the call. */
  verdict: Verdict;
}

/** A screen that keeps flipping (a clock, an ad): its changes are likely noise. */
export interface Flaky {
  /** Flips per run in the history, 0 to 1. */
  score: number;
  flips: number;
  /** Checks looked at: the last 20 of the screen on the branch. */
  checks: number;
  lastSeen: number;
  /** Where it keeps changing (screenshot pixels). */
  unstableArea: Rect | null;
}

/** One rejection of a screen. */
export interface Rejection {
  checkId: string;
  buildId: string;
  buildNumber: number;
  branch: string;
  reasonCode: RejectReason | null;
  /** The comment. */
  reason: string | null;
  by: { kind: 'user' | 'token' | 'auto'; id: string; name: string | null };
  at: number;
}

export type RejectionCategory = RejectReason | 'uncategorized';

/** Why a screen was rejected. */
export interface ScreenRejections {
  snapshotKey: string;
  name: string;
  variant: Variant;
  /** In a build's patterns: the screen's check in that build. */
  checkId?: string;
  count: number;
  byCategory: Partial<Record<RejectionCategory, number>>;
  /** The category given most often; null when none was given. */
  top: RejectReason | null;
  /** Rejections as not_loaded or late_asset: the screenshot was taken too early. */
  tooEarly: number;
  /** What the rejections say and what to do, in one sentence. */
  hint: string;
  /** Newest first, at most 5. */
  recent: Rejection[];
  lastAt: number;
}

/** Why screens were rejected: by category (most given first) and by screen (newest first). */
export interface RejectionPatterns {
  total: number;
  categories: Array<{ code: RejectionCategory; count: number; screens: number; lastAt: number }>;
  screens: ScreenRejections[];
}

/** A screen's last checks on a branch, newest first, and whether it is flaky. */
export interface ScreenHistory {
  snapshotKey: string;
  name: string;
  variant: Variant;
  branch: string;
  flaky: Flaky | null;
  items: Array<{
    checkId: string;
    buildId: string;
    buildNumber: number;
    imageSha: string;
    result: CheckResult;
    review: CheckReview;
    createdAt: number;
  }>;
}

/** Why a screen is noisy: a rejection category that says noise, or `flaky` (it keeps flipping). */
export type NoiseReason = 'not_loaded' | 'late_asset' | 'animation' | 'dynamic_data' | 'flaky';

/** GET /projects/{slug}/insights: how healthy a branch's visual tests are over a range of UTC days. */
export interface Insights {
  branch: string;
  from: string;
  to: string;
  days: number;
  timeZone: 'UTC';
  totals: {
    builds: number;
    checks: number;
    autoPassed: number;
    autoPassRate: number | null;
    neededReview: number;
    approved: number;
    rejected: number;
    outdated: number;
    pending: number;
    errors: number;
    rejections: {
      total: number;
      byReason: Record<RejectionCategory, number>;
      noise: number;
      realBug: number;
      other: number;
    };
    suggestions: { made: number; accepted: number; dismissed: number; acceptRate: number | null };
    timeToDecision: { decidedBuilds: number; medianMs: number | null; p90Ms: number | null; meanMs: number | null };
    runTime: {
      screenshotMs: number;
      uploadMs: number;
      compareMs: number;
      retakes: number;
      timedChecks: number;
      perBuildMs: number | null;
    };
  };
  previous: {
    from: string;
    to: string;
    builds: number;
    autoPassRate: number | null;
    medianTimeToDecisionMs: number | null;
  };
  daily: Array<{
    date: string;
    builds: number;
    checks: number;
    autoPassed: number;
    autoPassRate: number | null;
    approved: number;
    rejected: number;
    rejectedBy: Record<RejectionCategory, number>;
    medianMs: number | null;
    p90Ms: number | null;
  }>;
  flakyScreensNow: number;
  noisyScreens: Array<{
    snapshotKey: string;
    name: string;
    variant: Variant;
    checkId: string;
    flakyScore: number | null;
    flips: number;
    noiseRejections: number;
    byReason: Partial<Record<RejectReason, number>>;
    mainReason: NoiseReason;
    action: string;
    lastSeen: number;
  }>;
  slowScreens: Array<{
    snapshotKey: string;
    name: string;
    variant: Variant;
    checkId: string;
    checks: number;
    compareMsAvg: number;
    compareMsMax: number;
  }>;
  reviewers: Array<{
    kind: 'user' | 'token';
    id: string;
    name: string;
    decisions: number;
    approved: number;
    rejected: number;
    medianMs: number | null;
    suggestionsAccepted: number;
    suggestionsDismissed: number;
    acceptRate: number | null;
    suggestionsMade: number;
  }>;
  retentionDays: number;
}
