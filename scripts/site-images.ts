// Builds the landing page's images in site/assets/ from docs/screenshots/ (run after `bun run screenshots`):
//   bun scripts/site-images.ts
// WebP copies at two widths of the screenshots the page shows, and the 1200×630 Open Graph image.
// It encodes with Chromium (Playwright's, `bunx playwright install chromium`), so it needs no image tools.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from '@playwright/test';

const root = join(import.meta.dir, '..');
const shots = join(root, 'docs/screenshots');
const out = join(root, 'site/assets');

/** Screenshots the page uses, each in light and dark. */
export const SITE_SCREENSHOTS = ['review-slider', 'review-diff', 'build', 'branches'] as const;
export const SITE_WIDTHS = [1440, 800] as const;
const QUALITY = 0.9;

const dataUrl = (file: string) => `data:image/png;base64,${readFileSync(file).toString('base64')}`;

async function main(): Promise<void> {
  mkdirSync(out, { recursive: true });
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.setContent('<canvas></canvas>');
    for (const name of SITE_SCREENSHOTS) {
      for (const theme of ['light', 'dark']) {
        const src = dataUrl(join(shots, `${name}-${theme}.png`));
        for (const width of SITE_WIDTHS) {
          const webp = await page.evaluate(
            async ({ src, width, quality }) => {
              const img = new Image();
              img.src = src;
              await img.decode();
              const canvas = document.createElement('canvas');
              canvas.width = width;
              canvas.height = Math.round((img.naturalHeight * width) / img.naturalWidth);
              const ctx = canvas.getContext('2d');
              if (!ctx) throw new Error('no 2d context');
              ctx.imageSmoothingQuality = 'high';
              ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
              return canvas.toDataURL('image/webp', quality);
            },
            { src, width, quality: QUALITY },
          );
          const file = join(out, `${name}-${theme}-${width}.webp`);
          writeFileSync(file, Buffer.from(webp.split(',')[1] ?? '', 'base64'));
          console.log(`✓ ${file.slice(root.length + 1)}`);
        }
      }
    }
    await og(page);
  } finally {
    await browser.close();
  }
}

/** The social card: the logo, the one-line pitch and the slider view, drawn as a page and screenshotted. */
async function og(page: import('@playwright/test').Page): Promise<void> {
  await page.setViewportSize({ width: 1200, height: 630 });
  await page.setContent(`<!doctype html><html><head><style>
    * { box-sizing: border-box; margin: 0; }
    body { width: 1200px; height: 630px; overflow: hidden; background: #0a0a0a; color: #ededed;
      font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; position: relative; }
    .glow { position: absolute; inset: 0; background: radial-gradient(800px 420px at 85% 110%, rgb(59 158 255 / 0.22), transparent 70%); }
    .text { position: absolute; left: 72px; top: 72px; width: 520px; }
    .brand { display: flex; align-items: center; gap: 14px; font-size: 30px; font-weight: 650; letter-spacing: -0.01em; }
    .brand svg { width: 44px; height: 44px; }
    h1 { margin-top: 56px; font-size: 54px; line-height: 1.08; font-weight: 700; letter-spacing: -0.03em; }
    p { margin-top: 24px; font-size: 24px; line-height: 1.4; color: #a1a1aa; }
    .tags { position: absolute; left: 72px; bottom: 64px; display: flex; gap: 10px; }
    .tags span { border: 1px solid #3a3a40; border-radius: 999px; padding: 7px 14px; font-size: 18px; color: #d4d4d8; }
    .shot { position: absolute; left: 640px; top: 96px; width: 760px; border-radius: 14px; overflow: hidden;
      border: 1px solid #3a3a40; box-shadow: 0 30px 80px rgb(0 0 0 / 0.6); }
    .shot img { display: block; width: 100%; }
  </style></head><body>
    <div class="glow"></div>
    <div class="text">
      <div class="brand"><svg viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="#fff"/><path d="M16 7 26 24H6Z" fill="#111"/></svg>pixeltwin</div>
      <h1>Visual regression testing you host yourself</h1>
      <p>With an API built for CI and AI agents.</p>
    </div>
    <div class="tags"><span>Open source</span><span>Apache-2.0</span><span>Self-hosted</span></div>
    <div class="shot"><img src="${dataUrl(join(shots, 'review-slider-dark.png'))}" alt=""></div>
  </body></html>`);
  await page.locator('img').evaluate((img: HTMLImageElement) => img.decode());
  const file = join(out, 'og.png');
  await page.screenshot({ path: file });
  console.log(`✓ ${file.slice(root.length + 1)}`);
}

if (import.meta.main) await main();
