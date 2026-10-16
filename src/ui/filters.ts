import type { CheckResult, CheckReview } from '../db/schema';
import type { CheckStatusFilter } from '../domain/checks';
import type { BuildCounts } from '../domain/verdict';

/** The check filters of the build page and focus mode (UI spec §4.2, §5.1). */
export interface CheckFilter {
  key: string;
  label: string;
  result?: CheckResult;
  review?: CheckReview;
  /** The card's status word, when it is not one result or review state (see listChecks). */
  status?: CheckStatusFilter;
}

/** In the order the build page shows them; the keys stay what links already use. */
export const CHECK_FILTERS: CheckFilter[] = [
  { key: 'all', label: 'All' },
  { key: 'new', label: 'New', result: 'new' },
  { key: 'pending', label: 'Unresolved', review: 'pending' },
  { key: 'resolved', label: 'Resolved', status: 'resolved' },
  { key: 'error', label: 'Errors', result: 'error' },
  { key: 'unchanged', label: 'Passed', status: 'passed' },
  { key: 'rejected', label: 'Rejected', review: 'rejected' },
];

const ALL = CHECK_FILTERS.find((f) => f.key === 'all') as CheckFilter;

/** `?filter=pending`; links from before the redesign used `?result=` / `?review=`. */
export function filterFromQuery(
  query: { filter?: string | undefined; result?: string | undefined; review?: string | undefined },
  fallback = 'all',
): CheckFilter {
  const byKey = CHECK_FILTERS.find((f) => f.key === query.filter);
  if (byKey) return byKey;
  if (query.result || query.review) {
    const legacy = CHECK_FILTERS.find((f) => f.result === query.result && f.review === query.review);
    if (legacy) return legacy;
  }
  return CHECK_FILTERS.find((f) => f.key === fallback) ?? ALL;
}

export function countFor(filter: CheckFilter, counts: BuildCounts): number {
  if (filter.status === 'passed') return counts.result.unchanged + counts.autoApproved;
  if (filter.status === 'resolved') return counts.review.approved - counts.autoApproved;
  if (filter.result) return counts.result[filter.result];
  if (filter.review) return counts.review[filter.review];
  return counts.total;
}
