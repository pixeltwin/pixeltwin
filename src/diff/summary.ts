import { describeChanges } from './elements';
import type { Dimensions, ElementChange, Region } from './types';

export const IDENTICAL_SUMMARY = 'Identical to baseline.';

const GRID = [
  ['top-left', 'top-center', 'top-right'],
  ['middle-left', 'center', 'middle-right'],
  ['bottom-left', 'bottom-center', 'bottom-right'],
] as const;

/** Names the 3×3 grid cell that contains the region's center. */
export function positionOf(region: Region, width: number, height: number): string {
  const col = Math.min(2, Math.floor(((region.x + region.width / 2) / width) * 3));
  const row = Math.min(2, Math.floor(((region.y + region.height / 2) / height) * 3));
  return GRID[row]?.[col] ?? 'center';
}

export function formatPercent(percent: number, pixels: number): string {
  if (pixels > 0 && percent < 0.01) return '<0.01%';
  return `${percent.toFixed(2)}%`;
}

export interface SummaryInput {
  regions: Region[];
  regionCount: number;
  pixels: number;
  percent: number;
  width: number;
  height: number;
  dimensions: Dimensions | null;
  withinTolerance: boolean;
  tolerancePercent: number;
  /** Element changes (when both screenshots had elements); without any, the summary names regions. */
  changes?: { items: ElementChange[]; truncated: boolean; explained: number } | undefined;
}

/** Deterministic one-paragraph description of a diff. */
export function summarize(input: SummaryInput): string {
  const parts: string[] = [];
  const largest = input.regions[0];
  const changes = input.changes;
  if (input.pixels === 0 || !largest) {
    parts.push('No visible changes.');
  } else if (changes && changes.items.length > 0) {
    parts.push(describeChanges(changes.items, changes.truncated));
    const others = input.regionCount - changes.explained;
    if (others > 0) parts.push(`${others} other changed region${others === 1 ? '' : 's'}.`);
    parts.push(`${formatPercent(input.percent, input.pixels)} of pixels changed.`);
  } else {
    const n = input.regionCount;
    const position = positionOf(largest, input.width, input.height);
    parts.push(
      `${n} changed region${n === 1 ? '' : 's'}; largest ${largest.width}×${largest.height} at (${largest.x},${largest.y}) in ${position}; ${formatPercent(input.percent, input.pixels)} of pixels changed.`,
    );
  }
  if (input.dimensions) {
    const { baseline, current } = input.dimensions;
    parts.push(`Size changed from ${baseline.width}×${baseline.height} to ${current.width}×${current.height}.`);
  }
  if (input.withinTolerance && input.pixels > 0) {
    parts.push(`Within tolerance of ${input.tolerancePercent}%.`);
  }
  return parts.join(' ');
}
