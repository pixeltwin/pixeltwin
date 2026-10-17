// Pure: no DOM access, so `bun test` can check it. How many rows of cards fit the window on the
// build page, and how tall their thumbnails can be.

/** Thumbnail heights (CSS px): rows are chosen so thumbnails are at least `min`, never above `max`. */
export const THUMB = { min: 84, max: 240, floor: 48 } as const;

/** Card height without the thumbnail that rows are planned with: cards on other pages may be taller. */
const PLANNED_BODY = 110;

export interface Room {
  /** Height left for the grid (window less what is above and below it). */
  height: number;
  /** Gap between rows. */
  gap: number;
  /** The tallest card on this page without its thumbnail. */
  body: number;
  /** Keep this many rows (the page size is set); else as many as fit. */
  rows?: number | undefined;
}

export function fitRows(room: Room): { rows: number; thumb: number } {
  const planned = Math.max(room.body, PLANNED_BODY);
  const rows = room.rows ?? Math.max(1, Math.floor((room.height + room.gap) / (THUMB.min + planned + room.gap)));
  const thumb = Math.floor((room.height + room.gap) / rows - room.gap - room.body);
  return { rows, thumb: Math.max(THUMB.floor, Math.min(THUMB.max, thumb)) };
}
