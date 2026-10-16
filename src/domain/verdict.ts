import { CHECK_RESULTS, CHECK_REVIEWS, type CheckResult, type CheckReview } from '../db/schema';

export type Verdict = 'empty' | 'error' | 'rejected' | 'pending' | 'outdated' | 'passed';

export interface BuildCounts {
  total: number;
  result: Record<CheckResult, number>;
  review: Record<CheckReview, number>;
}

export function emptyCounts(): BuildCounts {
  return {
    total: 0,
    result: Object.fromEntries(CHECK_RESULTS.map((r) => [r, 0])) as Record<CheckResult, number>,
    review: Object.fromEntries(CHECK_REVIEWS.map((r) => [r, 0])) as Record<CheckReview, number>,
  };
}

/** Derived on every read; never stored. Only `passed` means success. */
export function deriveVerdict(counts: BuildCounts): Verdict {
  if (counts.total === 0) return 'empty';
  if (counts.result.error > 0) return 'error';
  if (counts.review.rejected > 0) return 'rejected';
  if (counts.review.pending > 0) return 'pending';
  // A newer build of the branch decided these screens; this build is not a success of its own.
  if (counts.review.outdated > 0) return 'outdated';
  return 'passed';
}
