// pixeltwin tests itself (UI spec §7.5): screenshots of the main pages, in both themes, posted to
// the pixeltwin under test as project "pixeltwin-ui". `bun run screenshots` runs only this test
// on a fresh server and writes the images to docs/screenshots/ for the README.
import { mkdirSync } from 'node:fs';
import { Api, expect, open, screenshot, test } from './fixtures';

const THEMES = ['light', 'dark'] as const;

// The UI's CSP forbids injected styles; only this test hides the toasts with one.
test.use({ bypassCSP: true });

/** "Web shop": main reviewed, feature/checkout waiting for review, fix/header still running. */
async function seedShop(admin: Api) {
  const { items } = await admin.call<{ items: Array<{ slug: string }> }>('GET', '/projects');
  if (!items.some((p) => p.slug === 'web-shop')) {
    await admin.call('POST', '/projects', { slug: 'web-shop', name: 'Web shop' });
  }
  const { token } = await admin.call<{ token: string }>('POST', '/projects/web-shop/tokens', {
    name: 'screenshots',
    scopes: ['read', 'write', 'review'],
  });
  const ci = new Api(admin.url, { authorization: `Bearer ${token}` });
  const pages = ['home', 'pricing', 'checkout', 'account', 'footer', 'header'];
  const post = async (
    branch: string,
    shot: (name: string) => Uint8Array<ArrayBuffer>,
    finish: 'approve' | 'finalize' | 'open',
  ) => {
    const build = await ci.call<{ id: string }>('POST', '/projects/web-shop/builds', { branch });
    const checks = [];
    for (const name of pages) checks.push({ name, ...(await ci.check(build.id, name, shot(name))) });
    if (finish === 'approve') await ci.call('POST', `/builds/${build.id}/approve`);
    if (finish !== 'open') await ci.call('POST', `/builds/${build.id}/finalize`);
    return { id: build.id, checks };
  };
  await post('main', () => screenshot(), 'approve');
  await post('main', () => screenshot(), 'finalize');
  const review = await post(
    'feature/checkout',
    (name) => (name === 'checkout' ? screenshot([229, 72, 77], 130) : screenshot()),
    'finalize',
  );
  await post('fix/header', () => screenshot(), 'open');
  const changed = review.checks.find((c) => c.name === 'checkout')?.id as string;
  return { buildId: review.id, changed };
}

test('screenshots of every main page, compared by pixeltwin itself', async ({ adminPage: page, admin, baseURL }) => {
  test.setTimeout(120_000);
  const shop = await seedShop(admin);
  const pages: Array<[name: string, path: string, setup?: () => Promise<void>]> = [
    ['projects', '/ui'],
    ['branches', '/ui/p/web-shop'],
    ['build', `/ui/builds/${shop.buildId}`],
    ['review-slider', `/ui/checks/${shop.changed}`, () => page.keyboard.press('2')],
    ['review-side', `/ui/checks/${shop.changed}`, () => page.keyboard.press('1')],
    ['review-diff', `/ui/checks/${shop.changed}`, () => page.keyboard.press('4')],
    ['settings', '/ui/p/web-shop/settings'],
  ];

  const outDir = process.env.UPDATE_SCREENSHOTS ? 'docs/screenshots' : test.info().outputPath('screenshots');
  mkdirSync(outDir, { recursive: true });
  const shots: Array<[name: string, png: Uint8Array<ArrayBuffer>]> = [];
  for (const theme of THEMES) {
    await page.context().addCookies([{ name: 'pt_theme', value: theme, url: baseURL as string }]);
    for (const [name, path, setup] of pages) {
      await open(page, path);
      await setup?.();
      await page.addStyleTag({ content: '.toasts { display: none !important; }' });
      const png = await page.screenshot({ path: `${outDir}/${name}-${theme}.png` });
      shots.push([`${name}-${theme}`, new Uint8Array(png)]);
    }
  }

  // Posted after the pictures are taken, so the projects page above shows only the shop.
  await admin.call('POST', '/projects', { slug: 'pixeltwin-ui', name: 'pixeltwin UI' });
  const { token } = await admin.call<{ token: string }>('POST', '/projects/pixeltwin-ui/tokens', {
    name: 'e2e',
    scopes: ['read', 'write'],
  });
  const self = new Api(admin.url, { authorization: `Bearer ${token}` });
  const build = await self.call<{ id: string }>('POST', '/projects/pixeltwin-ui/builds', {});
  for (const [name, png] of shots) expect((await self.check(build.id, name, png)).result).not.toBe('error');
  const done = await self.call<{ verdict: string; counts: { total: number } }>('POST', `/builds/${build.id}/finalize`);
  expect(done.counts.total).toBe(shots.length);
  expect(done.verdict).not.toBe('error');
});
