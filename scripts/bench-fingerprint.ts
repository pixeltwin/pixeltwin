// Measures what change fingerprints add to a comparison (run: bun scripts/bench-fingerprint.ts).
// Each case compares the same pair of screenshots with and without fingerprinting.
import { PNG } from 'pngjs';
import { compareImages } from '../src/diff/compare';
import { regionFingerprint } from '../src/diff/fingerprint';
import { extractRegions } from '../src/diff/regions';

function page(width: number, height: number, logo: number, noise: number): Uint8Array {
  const png = new PNG({ width, height });
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const header = y < 64;
      const inLogo = header && y > 16 && y < 48 && x > 24 && x < 24 + logo;
      // Text-like stripes below the header, so the page is not one flat colour.
      const text = !header && y % 24 < 12 && x % 9 < 6 && x > 40 && x < width - 40;
      const flip = noise > 0 && !header && (x * 7 + y * 13) % noise === 0;
      const v = inLogo ? 20 : header ? 40 : text !== flip ? 60 : 250;
      png.data[i] = v;
      png.data[i + 1] = v;
      png.data[i + 2] = header ? 90 : v;
      png.data[i + 3] = 255;
    }
  }
  return new Uint8Array(PNG.sync.write(png));
}

function time(fn: () => void, runs: number): number {
  fn();
  const all: number[] = [];
  for (let i = 0; i < runs; i++) {
    const t = performance.now();
    fn();
    all.push(performance.now() - t);
  }
  all.sort((a, b) => a - b);
  return all[Math.floor(all.length / 2)] as number;
}

const cases: Array<[string, number, number, number]> = [
  ['1280×800, header change', 1280, 800, 0],
  ['1280×8000 full page, header change', 1280, 8000, 0],
  ['1280×8000 full page, changes everywhere', 1280, 8000, 5],
];
for (const [label, width, height, noise] of cases) {
  const baseline = page(width, height, 200, 0);
  const current = page(width, height, 260, noise);
  const job = { current, baseline, ignoreRegions: [], colorThreshold: 0.1, tolerancePercent: 0, maxPixels: 40_000_000 };
  const total = time(() => compareImages(job), 7);
  // The fingerprint part alone, on the same mask and pixels compareImages works with.
  const a = PNG.sync.read(Buffer.from(baseline));
  const b = PNG.sync.read(Buffer.from(current));
  const mask = new Uint8Array(width * height);
  for (let i = 0; i < mask.length; i++) {
    const p = i * 4;
    if (a.data[p] !== b.data[p] || a.data[p + 2] !== b.data[p + 2]) mask[i] = 1;
  }
  const { regions } = extractRegions(mask, width, height);
  const prints = time(() => {
    for (const r of regions) regionFingerprint(r, mask, a.data, b.data, width);
  }, 7);
  console.log(
    `${label}: compare ${total.toFixed(1)} ms, of which fingerprints ${prints.toFixed(2)} ms (${((prints / total) * 100).toFixed(1)}%), ${regions.length} regions`,
  );
}
