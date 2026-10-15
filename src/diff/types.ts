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
  colorThreshold: number;
  tolerancePercent: number;
}

export type DiffJobResult =
  | { kind: 'validated'; width: number; height: number }
  | { kind: 'compared'; result: 'unchanged' | 'changed'; diff: DiffData; diffPng: Uint8Array | null }
  | { kind: 'invalid_image'; message: string }
  | { kind: 'error'; code: DiffErrorCode; message: string };

export type DiffRunner = (job: DiffJob) => Promise<DiffJobResult>;
