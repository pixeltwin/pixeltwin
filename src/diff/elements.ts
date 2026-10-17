import type { CellGrid } from './regions';
import type { ChangeKind, ElementChange, Rect, Region, SnapshotElement } from './types';

export const MAX_CHANGES = 50;

/** Order of importance: an element that appeared or went, then its text, style, size, place. */
const KIND_WEIGHT: Record<ChangeKind, number> = { added: 6, removed: 6, text: 5, style: 4, resized: 3, moved: 2 };
const ASPECTS: ChangeKind[] = ['text', 'style', 'resized', 'moved'];
const STYLE_WORDS: Record<string, string> = { color: 'colour', background: 'background', fontSize: 'font size' };

/** Changed pixels in any rectangle, in constant time: prefix sums over the region grid's cells. */
class ChangedPixels {
  readonly #grid: CellGrid;
  readonly #sums: Float64Array;

  constructor(grid: CellGrid) {
    this.#grid = grid;
    const { cols, rows, counts } = grid;
    const sums = new Float64Array((cols + 1) * (rows + 1));
    for (let r = 0; r < rows; r++) {
      let row = 0;
      for (let c = 0; c < cols; c++) {
        row += counts[r * cols + c] ?? 0;
        sums[(r + 1) * (cols + 1) + c + 1] = (sums[r * (cols + 1) + c + 1] ?? 0) + row;
      }
    }
    this.#sums = sums;
  }

  /** Changed pixels in the cells the rectangle touches. */
  in(rect: Rect | null): number {
    if (!rect || rect.width < 1 || rect.height < 1) return 0;
    const { size, cols, rows } = this.#grid;
    const c0 = Math.max(0, Math.floor(rect.x / size));
    const r0 = Math.max(0, Math.floor(rect.y / size));
    const c1 = Math.min(cols, Math.floor((rect.x + rect.width - 1) / size) + 1);
    const r1 = Math.min(rows, Math.floor((rect.y + rect.height - 1) / size) + 1);
    if (c1 <= c0 || r1 <= r0) return 0;
    const w = cols + 1;
    const s = this.#sums;
    return (s[r1 * w + c1] ?? 0) - (s[r0 * w + c1] ?? 0) - (s[r1 * w + c0] ?? 0) + (s[r0 * w + c0] ?? 0);
  }
}

const box = ({ x, y, width, height }: Rect): Rect => ({ x, y, width, height });

function intersects(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

function contains(outer: Rect, inner: Rect): boolean {
  return (
    outer.x <= inner.x &&
    outer.y <= inner.y &&
    outer.x + outer.width >= inner.x + inner.width &&
    outer.y + outer.height >= inner.y + inner.height
  );
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** Elements whose `keyOf` occurs exactly once in `items`, by that key. */
function uniqueBy(
  items: SnapshotElement[],
  keyOf: (e: SnapshotElement) => string | null,
): Map<string, SnapshotElement> {
  const seen = new Map<string, SnapshotElement | null>();
  for (const item of items) {
    const key = keyOf(item);
    if (key === null) continue;
    seen.set(key, seen.has(key) ? null : item);
  }
  const out = new Map<string, SnapshotElement>();
  for (const [key, item] of seen) if (item) out.set(key, item);
  return out;
}

export interface ElementMatch {
  pairs: Array<[from: SnapshotElement, to: SnapshotElement]>;
  removed: SnapshotElement[];
  added: SnapshotElement[];
}

/**
 * Pairs the baseline's elements with the new screenshot's: by key, then (for keys that changed,
 * such as a role and name key after a text change) by CSS path, then by tag, role and text.
 * Each step only pairs elements that are unique on both sides.
 */
export function matchElements(baseline: SnapshotElement[], current: SnapshotElement[]): ElementMatch {
  const pairs: ElementMatch['pairs'] = [];
  let before = baseline;
  let after = current;
  const steps: Array<(e: SnapshotElement) => string | null> = [
    (e) => e.key,
    (e) => (e.path ? `${e.tag} ${e.path}` : null),
    (e) => (e.text ? `${e.tag} ${e.role ?? ''} ${e.text}` : null),
  ];
  for (const keyOf of steps) {
    const theirs = uniqueBy(after, keyOf);
    const paired = new Set<SnapshotElement>();
    for (const [key, from] of uniqueBy(before, keyOf)) {
      const to = theirs.get(key);
      if (!to) continue;
      pairs.push([from, to]);
      paired.add(from).add(to);
    }
    before = before.filter((e) => !paired.has(e));
    after = after.filter((e) => !paired.has(e));
  }
  return { pairs, removed: before, added: after };
}

const quality = (key: string) => (key.startsWith('[') || key.startsWith('#') ? 3 : key.startsWith('role=') ? 2 : 1);

/** How a sentence names an element: its selector, or its role (or tag) and text. */
function labelOf(e: SnapshotElement, forText: boolean): string {
  if (e.key.startsWith('[') || e.key.startsWith('#')) return `\`${e.tag}${e.key}\``;
  const what = e.role ?? e.tag;
  if (forText) return what;
  const words = e.key.startsWith('role=') && e.name ? e.name : e.text;
  return words ? `${what} "${clip(words, 40)}"` : `\`${e.key}\``;
}

function moveWords(dx: number, dy: number): string {
  const parts: string[] = [];
  if (dy) parts.push(`${Math.abs(dy)} px ${dy > 0 ? 'down' : 'up'}`);
  if (dx) parts.push(`${Math.abs(dx)} px ${dx > 0 ? 'right' : 'left'}`);
  return `moved ${parts.join(' and ')}`;
}

function textWords(from: string | null, to: string | null): string {
  if (!from) return `text "${clip(to ?? '', 40)}" appeared`;
  if (!to) return `text "${clip(from, 40)}" was removed`;
  return `text changed from "${clip(from, 40)}" to "${clip(to, 40)}"`;
}

function joinWords(parts: string[]): string {
  return parts.length <= 1 ? (parts[0] ?? '') : `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}`;
}

/** The sentence for a change, without a capital letter or full stop. */
function describe(change: Omit<ElementChange, 'description' | 'regions'>): string {
  const words: string[] = [];
  for (const kind of change.kinds) {
    if (kind === 'added') words.push('appeared');
    if (kind === 'removed') words.push('disappeared');
    if (kind === 'text' && change.text) words.push(textWords(change.text.from, change.text.to));
    if (kind === 'style' && change.style) {
      for (const [prop, { from, to }] of Object.entries(change.style)) {
        words.push(`${STYLE_WORDS[prop] ?? prop} changed from ${from ?? 'none'} to ${to ?? 'none'}`);
      }
    }
    if (kind === 'resized' && change.from && change.to) {
      words.push(`resized from ${change.from.width}×${change.from.height} to ${change.to.width}×${change.to.height}`);
    }
    if (kind === 'moved') words.push(moveWords(change.dx ?? 0, change.dy ?? 0));
  }
  const inside = change.inside ? ` (with ${change.inside} element${change.inside === 1 ? '' : 's'} inside)` : '';
  return `${change.label} ${joinWords(words)}${inside}`;
}

type Draft = Omit<ElementChange, 'description' | 'regions'> & { pixels: number };

function styleDelta(from: SnapshotElement, to: SnapshotElement): ElementChange['style'] | null {
  const delta: NonNullable<ElementChange['style']> = {};
  for (const prop of ['color', 'background', 'fontSize'] as const) {
    const a = from.style?.[prop] ?? null;
    const b = to.style?.[prop] ?? null;
    if (a !== b) delta[prop] = { from: a, to: b };
  }
  return Object.keys(delta).length > 0 ? delta : null;
}

function pairChange(from: SnapshotElement, to: SnapshotElement, changed: ChangedPixels): Draft | null {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const dw = to.width - from.width;
  const dh = to.height - from.height;
  const fromText = from.text ?? null;
  const toText = to.text ?? null;
  const style = styleDelta(from, to);
  const kinds = ASPECTS.filter(
    (k) =>
      (k === 'text' && fromText !== toText) ||
      (k === 'style' && style !== null) ||
      (k === 'resized' && (dw !== 0 || dh !== 0)) ||
      (k === 'moved' && (dx !== 0 || dy !== 0)),
  );
  const pixels = changed.in(from) + changed.in(to);
  // An element nobody can see change (its pixels are the same) is not a change of the screenshot.
  if (kinds.length === 0 || pixels === 0) return null;
  const textOnly = kinds[0] === 'text';
  return {
    kind: kinds[0] as ChangeKind,
    kinds,
    key: to.key,
    tag: to.tag,
    role: to.role ?? null,
    label: labelOf(to, textOnly),
    from: box(from),
    to: box(to),
    ...(kinds.includes('moved') ? { dx, dy } : {}),
    ...(kinds.includes('resized') ? { dw, dh } : {}),
    ...(kinds.includes('text') ? { text: { from: fromText, to: toText } } : {}),
    ...(style ? { style } : {}),
    pixels,
  };
}

function lonelyChange(e: SnapshotElement, kind: 'added' | 'removed', changed: ChangedPixels): Draft | null {
  const pixels = changed.in(e);
  if (pixels === 0) return null;
  return {
    kind,
    kinds: [kind],
    key: e.key,
    tag: e.tag,
    role: e.role ?? null,
    label: labelOf(e, false),
    from: kind === 'removed' ? box(e) : null,
    to: kind === 'added' ? box(e) : null,
    pixels,
  };
}

/**
 * Folds changes into the outermost element that changed the same way: an element that moved with
 * its container (same distance), or appeared or disappeared inside one that did too.
 */
function foldInner(drafts: Draft[]): Draft[] {
  const area = (d: Draft) => {
    const r = d.from ?? d.to;
    return r ? r.width * r.height : 0;
  };
  const sameWay = (a: Draft, b: Draft) =>
    a.kinds.length === 1 &&
    b.kinds.length === 1 &&
    a.kind === b.kind &&
    (a.kind === 'added' || a.kind === 'removed' || (a.kind === 'moved' && a.dx === b.dx && a.dy === b.dy));
  const outer: Draft[] = [];
  for (const draft of [...drafts].sort((a, b) => area(b) - area(a))) {
    const own = draft.from ?? draft.to;
    const container = own
      ? outer.find((o) => {
          const theirs = o.from ?? o.to;
          return o !== draft && sameWay(o, draft) && theirs !== null && contains(theirs, own);
        })
      : undefined;
    if (container) container.inside = (container.inside ?? 0) + 1 + (draft.inside ?? 0);
    else outer.push(draft);
  }
  return drafts.filter((d) => outer.includes(d));
}

export interface ElementChanges {
  changes: ElementChange[];
  truncated: boolean;
  /** How many of `regions` some change explains. */
  explained: number;
}

/**
 * The element changes between two screenshots: matched elements that moved, resized or changed
 * text or style, and elements that appeared or disappeared, each only when changed pixels touch
 * it. Most important first (kind, then how stable the key is, then changed pixels, then
 * position), at most MAX_CHANGES. Deterministic for the same input.
 */
export function elementChanges(
  baseline: SnapshotElement[],
  current: SnapshotElement[],
  grid: CellGrid,
  regions: Region[],
): ElementChanges {
  const changed = new ChangedPixels(grid);
  const { pairs, removed, added } = matchElements(baseline, current);
  const drafts: Draft[] = [];
  for (const [from, to] of pairs) {
    const draft = pairChange(from, to, changed);
    if (draft) drafts.push(draft);
  }
  for (const e of removed) {
    const draft = lonelyChange(e, 'removed', changed);
    if (draft) drafts.push(draft);
  }
  for (const e of added) {
    const draft = lonelyChange(e, 'added', changed);
    if (draft) drafts.push(draft);
  }
  const position = (d: Draft) => d.to ?? d.from ?? { x: 0, y: 0 };
  const sorted = foldInner(drafts).sort(
    (a, b) =>
      KIND_WEIGHT[b.kind] - KIND_WEIGHT[a.kind] ||
      quality(b.key) - quality(a.key) ||
      b.pixels - a.pixels ||
      position(a).y - position(b).y ||
      position(a).x - position(b).x ||
      (a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
  );
  const explained = new Set<number>();
  const changes = sorted.slice(0, MAX_CHANGES).map(({ pixels: _pixels, ...draft }) => {
    const own = [draft.from, draft.to].filter((r): r is Rect => r !== null);
    const hit = regions.flatMap((r, i) => (own.some((o) => intersects(o, r)) ? [i] : []));
    for (const i of hit) explained.add(i);
    return { ...draft, regions: hit, description: describe(draft) };
  });
  return { changes, truncated: sorted.length > MAX_CHANGES, explained: explained.size };
}

/** The first letter in capitals (a sentence may start with a backtick). */
function capitalize(text: string): string {
  return text.replace(/^[a-z]/, (c) => c.toUpperCase());
}

/**
 * The summary's opening for element changes: up to three, most important first; elements that
 * moved the same distance are named together.
 */
export function describeChanges(changes: ElementChange[], truncated: boolean): string {
  const groups: Array<{ change: ElementChange; others: number }> = [];
  for (const change of changes) {
    const movedOnly = change.kinds.length === 1 && change.kind === 'moved';
    const group = movedOnly
      ? groups.find(
          (g) =>
            g.change.kinds.length === 1 &&
            g.change.kind === 'moved' &&
            g.change.dx === change.dx &&
            g.change.dy === change.dy,
        )
      : undefined;
    if (group) group.others += 1;
    else groups.push({ change, others: 0 });
  }
  const shown = groups
    .slice(0, 3)
    .map(({ change, others }) =>
      others > 0
        ? `${change.label} and ${others} other element${others === 1 ? '' : 's'} ${moveWords(change.dx ?? 0, change.dy ?? 0)}`
        : change.description,
    );
  const more = groups.length - shown.length;
  const tail =
    more > 0 || truncated ? `; and ${more > 0 ? more : 'some'} more element change${more === 1 ? '' : 's'}` : '';
  return `${capitalize(shown.join('; '))}${tail}.`;
}
