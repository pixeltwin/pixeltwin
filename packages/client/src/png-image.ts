// Just enough PNG for `pixeltwin mcp` to crop and shrink screenshots before an agent looks at them:
// 8-bit greyscale, RGB, palette and their alpha variants, not interlaced (what browsers and
// pixeltwin write). Node only (zlib).
import { deflateSync, inflateSync } from 'node:zlib';

const SIGNATURE = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** RGBA pixels, row by row. */
export interface RgbaImage {
  width: number;
  height: number;
  data: Uint8Array;
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/** Decodes a PNG to RGBA; null for what this decoder does not read (16-bit, interlaced, low bit depths). */
export function decodePng(png: Uint8Array): RgbaImage | null {
  if (png.length < 33 || SIGNATURE.some((b, i) => png[i] !== b)) return null;
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  let width = 0;
  let height = 0;
  let colour = -1;
  let palette: Uint8Array | null = null;
  let transparency: Uint8Array | null = null;
  const data: Uint8Array[] = [];
  for (let at = 8; at + 8 <= png.length; ) {
    const length = view.getUint32(at);
    const type = String.fromCharCode(...png.subarray(at + 4, at + 8));
    const body = png.subarray(at + 8, at + 8 + length);
    if (type === 'IHDR') {
      width = view.getUint32(at + 8);
      height = view.getUint32(at + 12);
      const depth = body[8];
      colour = body[9] ?? -1;
      if (depth !== 8 || body[12] !== 0) return null;
    } else if (type === 'PLTE') palette = body;
    else if (type === 'tRNS') transparency = body;
    else if (type === 'IDAT') data.push(body);
    else if (type === 'IEND') break;
    at += 12 + length;
  }
  const channels = ({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 } as Record<number, number>)[colour];
  if (!channels || !width || !height || (colour === 3 && !palette)) return null;
  let raw: Uint8Array;
  try {
    raw = inflateSync(Buffer.concat(data));
  } catch {
    return null;
  }
  const stride = width * channels;
  if (raw.length < (stride + 1) * height) return null;
  const line = new Uint8Array(stride);
  const previous = new Uint8Array(stride);
  const out = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const src = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let i = 0; i < stride; i++) {
      const left = i >= channels ? (line[i - channels] ?? 0) : 0;
      const up = previous[i] ?? 0;
      const upLeft = i >= channels ? (previous[i - channels] ?? 0) : 0;
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
      line[i] = ((src[i] ?? 0) + predicted) & 0xff;
    }
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      const s = x * channels;
      if (colour === 3 && palette) {
        const index = line[s] ?? 0;
        out[o] = palette[index * 3] ?? 0;
        out[o + 1] = palette[index * 3 + 1] ?? 0;
        out[o + 2] = palette[index * 3 + 2] ?? 0;
        out[o + 3] = transparency?.[index] ?? 255;
      } else if (channels <= 2) {
        const grey = line[s] ?? 0;
        out[o] = grey;
        out[o + 1] = grey;
        out[o + 2] = grey;
        out[o + 3] = channels === 2 ? (line[s + 1] ?? 255) : 255;
      } else {
        out[o] = line[s] ?? 0;
        out[o + 1] = line[s + 1] ?? 0;
        out[o + 2] = line[s + 2] ?? 0;
        out[o + 3] = channels === 4 ? (line[s + 3] ?? 255) : 255;
      }
    }
    previous.set(line);
  }
  return { width, height, data: out };
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) c = (CRC_TABLE[(c ^ b) & 0xff] ?? 0) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + body.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, body.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(body, 8);
  view.setUint32(8 + body.length, crc32(out.subarray(4, 8 + body.length)));
  return out;
}

/** Encodes RGBA pixels as a PNG (no filter; zlib does the work). */
export function encodePng(image: RgbaImage): Uint8Array {
  const { width, height, data } = image;
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  header[8] = 8;
  header[9] = 6;
  const raw = new Uint8Array((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) raw.set(data.subarray(y * width * 4, (y + 1) * width * 4), y * (width * 4 + 1) + 1);
  const parts = [SIGNATURE, chunk('IHDR', header), chunk('IDAT', deflateSync(raw)), chunk('IEND', new Uint8Array())];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/** The part of the image inside the rectangle (clipped to the image); null when nothing is left. */
export function crop(
  image: RgbaImage,
  rect: { x: number; y: number; width: number; height: number },
): RgbaImage | null {
  const x0 = Math.max(0, Math.floor(rect.x));
  const y0 = Math.max(0, Math.floor(rect.y));
  const x1 = Math.min(image.width, Math.ceil(rect.x + rect.width));
  const y1 = Math.min(image.height, Math.ceil(rect.y + rect.height));
  if (x1 <= x0 || y1 <= y0) return null;
  const width = x1 - x0;
  const data = new Uint8Array(width * (y1 - y0) * 4);
  for (let y = y0; y < y1; y++) {
    data.set(image.data.subarray((y * image.width + x0) * 4, (y * image.width + x1) * 4), (y - y0) * width * 4);
  }
  return { width, height: y1 - y0, data };
}

/** Shrinks by a whole factor, averaging each `factor`×`factor` block. */
export function shrink(image: RgbaImage, factor: number): RgbaImage {
  if (factor <= 1) return image;
  const width = Math.ceil(image.width / factor);
  const height = Math.ceil(image.height / factor);
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const sum = [0, 0, 0, 0];
      let n = 0;
      for (let sy = y * factor; sy < Math.min(image.height, (y + 1) * factor); sy++) {
        for (let sx = x * factor; sx < Math.min(image.width, (x + 1) * factor); sx++) {
          const i = (sy * image.width + sx) * 4;
          for (let c = 0; c < 4; c++) sum[c] = (sum[c] ?? 0) + (image.data[i + c] ?? 0);
          n += 1;
        }
      }
      for (let c = 0; c < 4; c++) data[(y * width + x) * 4 + c] = Math.round((sum[c] ?? 0) / n);
    }
  }
  return { width, height, data };
}
