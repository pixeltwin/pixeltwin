import type { CheckResult, CheckReview } from '../db/schema';
import type { BuildCounts } from '../domain/verdict';

/** The check filters of the build page and focus mode (UI spec §4.2, §5.1). */
export interface CheckFilter {
  key: string;
  label: string;
  result?: CheckResult;
  review?: CheckReview;
}

export const CHECK_FILTERS: CheckFilter[] = [
  { key: 'pending', label: 'To review', review: 'pending' },
  { key: 'changed', label: 'Changed', result: 'changed' },
  { key: 'new', label: 'New', result: 'new' },
  { key: 'error', label: 'Errors', result: 'error' },
  { key: 'unchanged', label: 'Unchanged', result: 'unchanged' },
  { key: 'rejected', label: 'Rejected', review: 'rejected' },
  { key: 'all', label: 'All' },
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
  if (filter.result) return counts.result[filter.result];
  if (filter.review) return counts.review[filter.review];
  return counts.total;
}
