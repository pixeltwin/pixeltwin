// Pages of the build page's grid. Pure, so `bun test` checks it without a server.

/** Cards per page: the client fits a page to the window and asks with `?size=` (UI spec §4.2). */
export const PAGE_SIZE = { min: 2, max: 60, default: 24 } as const;

/** The cookie the build page keeps the fitted page size in, so the next visit renders it at once. */
export const PAGE_SIZE_COOKIE = 'pt_page_size';

/** How big the build page's cards are: large (fewer, sharper) by default, or compact (more). */
export const DENSITIES = ['large', 'compact'] as const;
export type Density = (typeof DENSITIES)[number];
/** The viewer's density, kept like the page size so the server renders the cards at once. */
export const DENSITY_COOKIE = 'pt_density';

/** The density a cookie names; large by default. */
export function densityOf(value: string | undefined): Density {
  return DENSITIES.find((d) => d === value) ?? 'large';
}

/** A check, or the checks of one change group shown as one card: one slot of a page either way. */
export interface Slot {
  /** The card's element id: the check's id, or `group-<id>`. */
  key: string;
  /** Its checks' ids, newest first. */
  ids: string[];
  groupId: string | null;
}

/**
 * The grid's slots in the list's order (newest first): checks of one change group that the
 * filters keep (two or more) become one slot where the newest of them is.
 */
export function slotsOf(checks: Array<{ id: string; groupId: string | null }>): Slot[] {
  const listed = new Map<string, string[]>();
  for (const c of checks) if (c.groupId) listed.set(c.groupId, [...(listed.get(c.groupId) ?? []), c.id]);
  const slots: Slot[] = [];
  for (const c of checks) {
    const members = c.groupId ? listed.get(c.groupId) : undefined;
    if (!c.groupId || !members || members.length < 2) slots.push({ key: c.id, ids: [c.id], groupId: null });
    else if (members[0] === c.id) slots.push({ key: `group-${c.groupId}`, ids: members, groupId: c.groupId });
  }
  return slots;
}

/** `?size=` (else the cookie, else the default), clamped; anything not a number is the default. */
export function pageSizeOf(asked: string | undefined, remembered?: string | undefined): number {
  for (const value of [asked, remembered]) {
    const n = Number.parseInt(value ?? '', 10);
    if (Number.isFinite(n) && n > 0) return Math.min(PAGE_SIZE.max, Math.max(PAGE_SIZE.min, n));
  }
  return PAGE_SIZE.default;
}

export interface GridPage {
  /** 1-based, clamped to the pages there are. */
  page: number;
  pages: number;
  size: number;
  /** Slots in all pages. */
  total: number;
  /** Index of the page's first slot in the whole list (0-based). */
  offset: number;
  slots: Slot[];
}

/**
 * The page `?page=` asks for, or the page holding the card `focus` names (a check id, alone or in
 * a group, or a group card's id). A page past the end is the last one, so approving the last card
 * of the last page never leaves an empty page behind.
 */
export function pageOf(
  slots: Slot[],
  options: { page?: string | undefined; size: number; focus?: string | undefined },
): GridPage {
  const { size } = options;
  const pages = Math.max(1, Math.ceil(slots.length / size));
  let page = Number.parseInt(options.page ?? '', 10);
  if (!Number.isFinite(page) || page < 1) page = 1;
  if (options.focus) {
    const at = slots.findIndex((s) => s.key === options.focus || s.ids.includes(options.focus as string));
    if (at >= 0) page = Math.floor(at / size) + 1;
  }
  page = Math.min(page, pages);
  const offset = (page - 1) * size;
  return { page, pages, size, total: slots.length, offset, slots: slots.slice(offset, offset + size) };
}

/**
 * The page numbers a pager shows: the first and last, and two either side of the current page,
 * with `gap` where numbers are left out (a gap of one number shows the number instead).
 */
export function pageNumbers(page: number, pages: number): Array<number | 'gap'> {
  const shown = new Set([1, pages]);
  for (let p = page - 2; p <= page + 2; p++) if (p >= 1 && p <= pages) shown.add(p);
  const sorted = [...shown].sort((a, b) => a - b);
  const out: Array<number | 'gap'> = [];
  for (const p of sorted) {
    const last = out[out.length - 1];
    if (typeof last === 'number' && p - last === 2) out.push(last + 1);
    else if (typeof last === 'number' && p - last > 2) out.push('gap');
    out.push(p);
  }
  return out;
}

/** `13–24 of 87`; `7 of 87` for a page of one. */
export function rangeText(page: GridPage): string {
  if (page.total === 0) return '0 of 0';
  const from = page.offset + 1;
  const to = page.offset + page.slots.length;
  return from === to ? `${from} of ${page.total}` : `${from}–${to} of ${page.total}`;
}
