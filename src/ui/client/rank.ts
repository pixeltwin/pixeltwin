// Pure: no DOM access. Command palette ranking (UI spec §4.3) and live polling pace (§4.4).

export interface Rankable {
  label: string;
  /** Larger is more recent; breaks ties between equal matches. */
  recency?: number;
}

/** 3 for a prefix match, 2 for a substring, 1 for letters in order, null for no match. */
export function matchScore(query: string, text: string): number | null {
  const q = query.trim().toLowerCase();
  if (!q) return 0;
  const t = text.toLowerCase();
  if (t.startsWith(q)) return 3;
  if (t.includes(q)) return 2;
  let at = 0;
  for (const ch of t) if (ch === q[at]) at++;
  return at === q.length ? 1 : null;
}

export function rank<T extends Rankable>(items: T[], query: string, limit = 20): T[] {
  return items
    .map((item) => ({ item, score: matchScore(query, item.label) }))
    .filter((x): x is { item: T; score: number } => x.score !== null)
    .sort((a, b) => b.score - a.score || (b.item.recency ?? 0) - (a.item.recency ?? 0))
    .slice(0, limit)
    .map((x) => x.item);
}

/**
 * A page with a running build (`open`) polls every 5 s, and every 30 s after 10 polls in a row
 * without a change. A page that only watches for new builds (`watch`) polls every 10 s, and every
 * 30 s after 5 quiet minutes.
 */
export function pollDelay(unchangedPolls: number, mode: 'open' | 'watch' = 'open'): number {
  if (mode === 'watch') return unchangedPolls < 30 ? 10_000 : 30_000;
  return unchangedPolls < 10 ? 5000 : 30_000;
}
