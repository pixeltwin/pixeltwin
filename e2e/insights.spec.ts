import { expect, open, test } from './fixtures';

test('the Insights tab: tiles, charts, the screens to fix, and switching the range', async ({
  reviewerPage: page,
  seeded,
}) => {
  // Home was captured before it loaded; the new cart screen is fine.
  await seeded.ci.call('POST', `/checks/${seeded.changed}/reject`, { reasonCode: 'not_loaded', reason: 'Spinner' });
  await seeded.ci.call('POST', `/checks/${seeded.fresh}/approve`, { reason: 'New cart page' });

  await open(page, `/ui/p/${seeded.slug}`);
  await page.getByRole('navigation', { name: 'Project' }).getByRole('link', { name: 'Insights' }).click();
  await page.locator('body[data-ready]').waitFor({ state: 'attached' });
  await expect(page).toHaveURL(new RegExp(`/ui/p/${seeded.slug}/insights$`));
  await expect(page.getByRole('link', { name: '30 days' })).toHaveAttribute('aria-current', 'page');

  const tile = (name: string) => page.locator(`[data-tile="${name}"] .tile-value`);
  // 5 checks in two builds; footer twice and the first build's two (approved before finalize) …
  await expect(tile('auto-pass')).toHaveText('20%');
  await expect(tile('noise')).toHaveText('1 of 1');
  await expect(page.getByRole('img', { name: /Auto-pass rate/ })).toBeVisible();
  await expect(page.locator('figure.chart')).toHaveCount(5);
  const fix = page.locator('section[aria-labelledby="noisy-title"] tbody tr');
  await expect(fix).toHaveCount(1);
  await expect(fix).toContainText('home');
  await expect(fix).toContainText('Wait for the page to finish loading');

  // A focused chart answers the arrow keys with a tooltip, values first.
  await page.locator('#chart-review-load .chart-plot').focus();
  const tip = page.locator('.chart-tip');
  await expect(tip).toBeVisible();
  await expect(tip).toContainText('Rejected');
  await page.keyboard.press('ArrowLeft');
  await expect(tip).toContainText('Passed by themselves');
  await page.keyboard.press('Escape');
  await expect(tip).toBeHidden();

  await page.getByRole('link', { name: '7 days' }).click();
  await expect(page).toHaveURL(/range=7/);
  await expect(page.getByRole('link', { name: '7 days' })).toHaveAttribute('aria-current', 'page');
  await expect(page.locator('#chart-auto-pass .chart-band')).toHaveCount(7);
  await page.getByRole('link', { name: '90 days' }).click();
  await expect(page).toHaveURL(/range=90/);
  // 90 days in weeks.
  await expect(page.locator('#chart-auto-pass .chart-band')).toHaveCount(13);
  await expect(page.locator('.insights-span')).toContainText('finalized builds on main');
});

test('picking another branch shows its numbers at once', async ({ reviewerPage: page, seeded }) => {
  const build = await seeded.ci.call<{ id: string }>('POST', `/projects/${seeded.slug}/builds`, {
    branch: 'feature/cart',
  });
  await seeded.ci.call('POST', `/builds/${build.id}/finalize`);
  await open(page, `/ui/p/${seeded.slug}/insights?range=7`);
  await page.getByLabel('Branch').selectOption('feature/cart');
  await expect(page).toHaveURL(/branch=feature%2Fcart/);
  await expect(page.locator('.insights-span')).toContainText('finalized builds on feature/cart');
  await expect(page.getByRole('link', { name: '7 days' })).toHaveAttribute('aria-current', 'page');
  await expect(page.locator('[data-tile="auto-pass"] .tile-value')).toHaveText('—');
  await expect(page.getByRole('heading', { name: 'No checks in this range' })).toBeVisible();
});
