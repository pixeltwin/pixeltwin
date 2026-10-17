import type { Region } from './types';

export const CELL_SIZE = 8;
export const MAX_REGIONS = 50;

/** Changed pixels per `size`×`size` cell of the mask, row by row. */
export interface CellGrid {
  size: number;
  cols: number;
  rows: number;
  counts: Uint32Array;
}

export interface RegionResult {
  regions: Region[];
  /** Number of regions found before truncation. */
  total: number;
  truncated: boolean;
  /** The grid the regions were grown on (element changes count changed pixels with it). */
  cells: CellGrid;
}

/**
 * Groups changed pixels into regions. The mask is split into `cellSize` cells; cells with
 * any changed pixel are joined with their 8 neighbours. Each region reports the tight
 * bounding box of its changed pixels. Sorted by pixels desc, then y, then x.
 */
export function extractRegions(
  mask: Uint8Array,
  width: number,
  height: number,
  cellSize = CELL_SIZE,
  maxRegions = MAX_REGIONS,
): RegionResult {
  const cols = Math.ceil(width / cellSize);
  const rows = Math.ceil(height / cellSize);
  const cellPixels = new Uint32Array(cols * rows);
  for (let y = 0; y < height; y++) {
    const cellRow = Math.floor(y / cellSize) * cols;
    for (let x = 0; x < width; x++) {
      if (mask[y * width + x]) cellPixels[cellRow + Math.floor(x / cellSize)] += 1;
    }
  }

  const visited = new Uint8Array(cols * rows);
  const regions: Region[] = [];
  const stack: number[] = [];

  for (let start = 0; start < cellPixels.length; start++) {
    if (cellPixels[start] === 0 || visited[start]) continue;
    visited[start] = 1;
    stack.push(start);
    let minX = width;
    let minY = height;
    let maxX = -1;
    let maxY = -1;
    let pixels = 0;

    while (stack.length > 0) {
      const cell = stack.pop() as number;
      const cx = cell % cols;
      const cy = Math.floor(cell / cols);
      pixels += cellPixels[cell] as number;

      const x1 = Math.min((cx + 1) * cellSize, width);
      const y1 = Math.min((cy + 1) * cellSize, height);
      for (let y = cy * cellSize; y < y1; y++) {
        for (let x = cx * cellSize; x < x1; x++) {
          if (!mask[y * width + x]) continue;
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }

      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = cx + dx;
          const ny = cy + dy;
          if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
          const neighbour = ny * cols + nx;
          if (cellPixels[neighbour] === 0 || visited[neighbour]) continue;
          visited[neighbour] = 1;
          stack.push(neighbour);
        }
      }
    }

    regions.push({ x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1, pixels });
  }

  regions.sort((a, b) => b.pixels - a.pixels || a.y - b.y || a.x - b.x);
  return {
    regions: regions.slice(0, maxRegions),
    total: regions.length,
    truncated: regions.length > maxRegions,
    cells: { size: cellSize, cols, rows, counts: cellPixels },
  };
}
