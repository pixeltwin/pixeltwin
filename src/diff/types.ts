export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Region extends Rect {
  /** Changed pixels in this region. */
  pixels: number;
}

export interface Size {
  width: number;
  height: number;
}

export interface Dimensions {
  baseline: Size;
  current: Size;
}

/** A few computed styles of an element, as the SDK read them (colours as `#rrggbb`). */
export interface ElementStyle {
  color?: string | undefined;
  background?: string | undefined;
  fontSize?: string | undefined;
}

/**
 * A page element the SDK measured with the screenshot. The box is in screenshot pixels. `key` is
 * the most stable name the SDK found (`[data-testid=submit]`, `#email`, `role=button[name="Buy"]`,
 * else a CSS path); `path` is always the CSS path, used when the key changed with the text.
 */
export interface SnapshotElement extends Rect {
  key: string;
  path?: string | undefined;
  tag: string;
  role?: string | undefined;
  /** Accessible name. */
  name?: string | undefined;
  /** A short snippet of the visible text. */
  text?: string | undefined;
  style?: ElementStyle | undefined;
}

export const CHANGE_KINDS = ['moved', 'resized', 'text', 'style', 'added', 'removed'] as const;
export type ChangeKind = (typeof CHANGE_KINDS)[number];

/** A change of one element between the baseline and the new screenshot. */
export interface ElementChange {
  /** The most telling aspect: added or removed, else text, style, resized, moved. */
  kind: ChangeKind;
  /** Every aspect that changed (one for added and removed). */
  kinds: ChangeKind[];
  /** The element's key in the new screenshot (in the baseline for `removed`). */
  key: string;
  tag: string;
  role: string | null;
  /** How the summary names the element. */
  label: string;
  /** Box in the baseline; null when added. */
  from: Rect | null;
  /** Box in the new screenshot; null when removed. */
  to: Rect | null;
  dx?: number;
  dy?: number;
  dw?: number;
  dh?: number;
  text?: { from: string | null; to: string | null };
  style?: Record<string, { from: string | null; to: string | null }>;
  /** Elements inside it that moved, appeared or disappeared with it; they are not listed on their own. */
  inside?: number;
  /** Indexes into `regions` of the changed regions it explains. */
  regions: number[];
  /** One plain sentence, e.g. "`button[data-testid=submit]` moved 4 px down". */
  description: string;
}

/** Agent-readable comparison result, stored as `checks.diff`. */
export interface DiffData {
  percent: number;
  pixels: number;
  colorThreshold: number;
  tolerancePercent: number;
  dimensions: Dimensions | null;
  regions: Region[];
  regionsTruncated: boolean;
  summary: string;
  /**
   * What changed, element by element: present only when both the baseline and the new screenshot
   * came with elements. Limited to elements on changed pixels, most important first.
   */
  changes?: ElementChange[];
  changesTruncated?: boolean;
}

export type DiffErrorCode = 'diff_timeout' | 'diff_failed';

export interface DiffErrorData {
  error: { code: DiffErrorCode; message: string };
}

export interface DiffJob {
  current: Uint8Array;
  /** null: only validate that `current` decodes. */
  baseline: Uint8Array | null;
  ignoreRegions: Rect[];
  /** When not empty, only pixels inside these rectangles are compared (UI-drawn compare areas). */
  compareRegions?: Rect[];
  colorThreshold: number;
  tolerancePercent: number;
  /** The elements of both screenshots, when both have them: the diff then lists element changes. */
  elements?: { baseline: SnapshotElement[]; current: SnapshotElement[] } | null;
  /**
   * Upper bound for the comparison canvas (max width × max height). Differently shaped images
   * can need a canvas far larger than either image, so the per-image limit is not enough.
   */
  maxPixels: number;
}

export type DiffJobResult =
  | { kind: 'validated'; width: number; height: number }
  | { kind: 'compared'; result: 'unchanged' | 'changed'; diff: DiffData; diffPng: Uint8Array | null }
  | { kind: 'invalid_image'; message: string }
  | { kind: 'error'; code: DiffErrorCode; message: string };

export type DiffRunner = (job: DiffJob) => Promise<DiffJobResult>;
