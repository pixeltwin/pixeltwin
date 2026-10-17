// How Insights numbers read in words: the page, Slack, mail and the MCP tool say them alike.

/** `45 s`, `18m`, `2h 10m`, `3d 4h`: a time to decision; `—` for none. */
export function spanText(ms: number | null): string {
  if (ms === null) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h${m % 60 ? ` ${m % 60}m` : ''}`;
  const d = Math.floor(h / 24);
  return `${d}d${h % 24 ? ` ${h % 24}h` : ''}`;
}

/** `83%`; `—` for none. */
export function percentText(rate: number | null): string {
  return rate === null ? '—' : `${Math.round(rate * 100)}%`;
}

/** `▲ 4 pts`, `▼ 2 pts`, `no change`; null when either rate is missing. */
export function pointsText(now: number | null, before: number | null): string | null {
  if (now === null || before === null) return null;
  const pts = Math.round((now - before) * 100);
  if (pts === 0) return 'no change';
  return `${pts > 0 ? '▲' : '▼'} ${Math.abs(pts)} pts`;
}

/** ` (chromium, mobile)`, or nothing without a variant. */
export function variantText(variant: Record<string, string>): string {
  const values = Object.keys(variant)
    .sort()
    .map((k) => variant[k]);
  return values.length > 0 ? ` (${values.join(', ')})` : '';
}

/** `Oct 3` from `2026-10-03`. */
export function shortDate(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  return `${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getUTCMonth()]} ${d.getUTCDate()}`;
}
