// Pure: no DOM access, so `bun test` can check it. How many rows of cards fit the window on the
// build page, and how tall their thumbnails can be.

/**
 * Thumbnail heights (CSS px) by density: rows are chosen so thumbnails are at least `min`, never
 * above `max`; `body` is the card's height without the thumbnail that rows are planned with
 * (cards on other pages may be taller than these). Compact is the build page as it was.
 */
export const DENSITY = {
  compact: { min: 84, max: 240, floor: 48, body: 110 },
  // A large card's name and status share a line, so its body is lower.
  large: { min: 200, max: 440, floor: 48, body: 96 },
} as const;
export type Density = keyof typeof DENSITY;
export const THUMB = DENSITY.compact;

/** A 16:10 screenshot as wide as a large card (less its borders and padding) is this high. */
const WIDE = 1.6;
const INSET = { width: 18, height: 16 };

export interface Room {
  /** Height left for the grid (window less what is above and below it). */
  height: number;
  /** Gap between rows. */
  gap: number;
  /** The tallest card on this page without its thumbnail. */
  body: number;
  /** Keep this many rows (the page size is set); else as many as fit. */
  rows?: number | undefined;
  /** A card's width: a large thumbnail is no taller than a 16:10 screenshot as wide as the card. */
  width?: number | undefined;
}

export function fitRows(room: Room, density: Density = 'compact'): { rows: number; thumb: number } {
  const bounds = DENSITY[density];
  const planned = Math.max(room.body, bounds.body);
  const rows = room.rows ?? Math.max(1, Math.floor((room.height + room.gap) / (bounds.min + planned + room.gap)));
  const thumb = Math.floor((room.height + room.gap) / rows - room.gap - room.body);
  const max =
    density === 'large' && room.width
      ? Math.min(bounds.max, Math.round((room.width - INSET.width) / WIDE + INSET.height))
      : bounds.max;
  return { rows, thumb: Math.max(bounds.floor, Math.min(max, thumb)) };
}
