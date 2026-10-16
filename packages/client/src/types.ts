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
  state: 'open' | 'finalized';
  createdAt: number;
  finalizedAt: number | null;
  /** A parallel build: how many parts (CI jobs) finalize it; null for an ordinary build. */
  parallelTotal: number | null;
  /** Parts of a parallel build that have finalized it so far. */
  partsFinished: number;
  /** Only `passed` is success. */
  verdict: Verdict;
  counts: BuildCounts;
}

export interface Diff {
  percent: number;
  pixels: number;
  colorThreshold: number;
  tolerancePercent: number;
  dimensions: { baseline: { width: number; height: number }; current: { width: number; height: number } } | null;
  regions: (Rect & { pixels: number })[];
  regionsTruncated: boolean;
  /** One sentence. */
  summary: string;
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
  diff: Diff | DiffError | null;
  reviewedBy: string | null;
  reviewedAt: number | null;
  reviewComment: string | null;
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
}
