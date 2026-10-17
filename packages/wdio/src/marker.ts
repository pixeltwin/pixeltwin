// Where the page starts in a phone's screenshot. A mobile browser's screenshot shows the system
// bars (and the browser's own bars) around the page, so DOM boxes need an offset. The page shows a
// thin bar of MARKER colour at its top left for one screenshot; the offset is where it is found.
import { inflateSync } from 'node:zlib';

/** An unusual, exact colour: magenta. */
export const MARKER: readonly [number, number, number] = [255, 0, 255];

/** CSS pixels high: tall enough to survive scaling, short enough to stay out of the way. */
export const MARKER_HEIGHT = 2;

interface Decoded {
  width: number;
  height: number;
  /** Bytes per pixel: 3 (RGB) or 4 (RGBA). */
  channels: number;
  pixels: Uint8Array;
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

/**
 * Decodes an 8-bit RGB or RGBA, non-interlaced PNG (what browsers and Appium return). Throws on
 * anything else.
 */
export function decodePng(png: Uint8Array): Decoded {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  let width = 0;
  let height = 0;
  let channels = 0;
  const data: Uint8Array[] = [];
  for (let at = 8; at + 8 <= png.length; ) {
    const length = view.getUint32(at);
    const type = String.fromCharCode(png[at + 4] ?? 0, png[at + 5] ?? 0, png[at + 6] ?? 0, png[at + 7] ?? 0);
    const body = png.subarray(at + 8, at + 8 + length);
    if (type === 'IHDR') {
      width = view.getUint32(at + 8);
      height = view.getUint32(at + 12);
      const depth = body[8];
      const colour = body[9];
      const interlace = body[12];
      if (depth !== 8 || interlace !== 0 || (colour !== 2 && colour !== 6)) {
        throw new Error('pixeltwin: the screenshot is not an 8-bit RGB(A) PNG; pass ignore rectangles instead.');
      }
      channels = colour === 6 ? 4 : 3;
    } else if (type === 'IDAT') data.push(body);
    else if (type === 'IEND') break;
    at += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(data));
  const stride = width * channels;
  const pixels = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const out = y * stride;
    for (let i = 0; i < stride; i++) {
      const left = i >= channels ? (pixels[out + i - channels] ?? 0) : 0;
      const up = y > 0 ? (pixels[out - stride + i] ?? 0) : 0;
      const upLeft = y > 0 && i >= channels ? (pixels[out - stride + i - channels] ?? 0) : 0;
      const value = line[i] ?? 0;
      const predicted =
        filter === 1
          ? left
          : filter === 2
            ? up
            : filter === 3
              ? (left + up) >> 1
              : filter === 4
                ? paeth(left, up, upLeft)
                : 0;
      pixels[out + i] = (value + predicted) & 0xff;
    }
  }
  return { width, height, channels, pixels };
}

const near = (a: number, b: number) => Math.abs(a - b) <= 8;

/**
 * Screenshot pixels from the top left of the image to the top left of the page: the first row
 * (from the top) with a run of marker colour, and where that run starts. Null when not found.
 */
export function findMarker(png: Uint8Array): { x: number; y: number } | null {
  const { width, height, channels, pixels } = decodePng(png);
  const isMarker = (x: number, y: number) => {
    const i = (y * width + x) * channels;
    return (
      near(pixels[i] ?? 0, MARKER[0]) && near(pixels[i + 1] ?? 0, MARKER[1]) && near(pixels[i + 2] ?? 0, MARKER[2])
    );
  };
  // The bar spans the page's width: look for it in the middle column, then walk left to its start.
  const middle = Math.floor(width / 2);
  for (let y = 0; y < height; y++) {
    if (!isMarker(middle, y)) continue;
    let x = middle;
    while (x > 0 && isMarker(x - 1, y)) x--;
    return { x, y };
  }
  return null;
}
