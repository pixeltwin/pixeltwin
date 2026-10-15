export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

/** `rows` must hold up to `limit + 1` items; the extra one only signals that more exist. */
export function toPage<T extends { id: string }>(rows: T[], limit: number): Page<T> {
  const items = rows.slice(0, limit);
  const last = items[items.length - 1];
  return { items, nextCursor: rows.length > limit && last ? last.id : null };
}
