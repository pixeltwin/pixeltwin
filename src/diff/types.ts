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
