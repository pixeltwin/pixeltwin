import { PNG } from 'pngjs';

export type Rgba = [number, number, number, number];

export const WHITE: Rgba = [255, 255, 255, 255];
export const BLACK: Rgba = [0, 0, 0, 255];

export interface FilledRect {
  x: number;
  y: number;
  width: number;
  height: number;
  color: Rgba;
}

/** Encodes a solid-colour PNG with optional filled rectangles. */
export function makePng(width: number, height: number, fill: Rgba = WHITE, rects: FilledRect[] = []): Uint8Array {
  const png = new PNG({ width, height });
  for (let i = 0; i < width * height; i++) png.data.set(fill, i * 4);
  for (const r of rects) {
    for (let y = r.y; y < r.y + r.height; y++) {
      for (let x = r.x; x < r.x + r.width; x++) png.data.set(r.color, (y * width + x) * 4);
    }
  }
  return new Uint8Array(PNG.sync.write(png));
}

export function decodePng(bytes: Uint8Array): PNG {
  return PNG.sync.read(Buffer.from(bytes));
}

export function pixelAt(png: PNG, x: number, y: number): number[] {
  const i = (y * png.width + x) * 4;
  return Array.from(png.data.subarray(i, i + 4));
}
