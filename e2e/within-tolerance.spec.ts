// Checks that pass only within the tolerance: marked on the build page, a chip of their own, and a
// check page that shows what differs and lets a reviewer take it as the baseline or reject it.
import { Api, expect, open, REVIEWER, screenshot, test } from './fixtures';

interface CheckJson {
  review: string;
  withinTolerance: boolean;
  reviewReasonCode?: string | null;
}

/**
 * A project with a 0.5% tolerance. Build #2: home and cart drift a little (a slightly wider
 * button: 0.13% and 0.08% of the pixels), footer is identical, about changed for real.
 */
async function seedDrift(admin: Api) {
  const slug = `e2e-${Math.random().toString(36).slice(2, 10)}`;
  await admin.call('POST', '/projects', { slug, name: `Drift ${slug.slice(4)}`, tolerancePercent: 0.5 });
  await admin.call('POST', `/projects/${slug}/members`, { email: REVIEWER, role: 'reviewer' });
  const { token } = await admin.call<{ token: string }>('POST', `/projects/${slug}/tokens`, {
    name: 'e2e',
    scopes: ['read', 'write'],
  });
  const ci = new Api(admin.url, { authorization: `Bearer ${token}` });
  const first = await ci.call<{ id: string }>('POST', `/projects/${slug}/builds`, { branch: 'main' });
  for (const name of ['home', 'cart', 'footer', 'about']) await ci.check(first.id, name, screenshot());
  await admin.call('POST', `/builds/${first.id}/approve`);
  await ci.call('POST', `/builds/${first.id}/finalize`);
  const build = await ci.call<{ id: string }>('POST', `/projects/${slug}/builds`, { branch: 'main' });
  const home = await ci.check(build.id, 'home', screenshot(undefined, 96));
  const about = await ci.check(build.id, 'about', screenshot([229, 72, 77], 130));
  const footer = await ci.check(build.id, 'footer', screenshot());
  const cart = await ci.check(build.id, 'cart', screenshot(undefined, 94));
  await ci.call('POST', `/builds/${build.id}/finalize`);
  return { ci, buildId: build.id, home: home.id, cart: cart.id, footer: footer.id, about: about.id };
}

test('the Within tolerance chip counts and lists the checks that passed by a small margin', async ({
  reviewerPage: page,
  admin,
}) => {
  const seeded = await seedDrift(admin);
  await open(page, `/ui/builds/${seeded.buildId}?filter=all`);
  await expect(page.locator('.meta-line')).toContainText('1 changed · 1 passed · 2 within tolerance');
  const chip = page.locator('.chips a', { hasText: 'Within tolerance' });
  await expect(chip.locator('.count')).toHaveText('2');
  await expect(page.locator('.chips a', { hasText: 'Passed' }).locator('.count')).toHaveText('3');
  // The cards say so, calmly: passed, with an amber tag and border.
  const home = page.locator(`[id="${seeded.home}"]`);
  await expect(home.locator('.card-state')).toHaveText('passed');
  await expect(home.locator('.tolerance-tag')).toHaveText('within tolerance 0.13% ≤ 0.5%');
  await expect(home.locator('.check-card')).toHaveClass(/card-tolerance/);
  await expect(page.locator(`[id="${seeded.footer}"] .tolerance-tag`)).toHaveCount(0);

  await chip.click();
  await expect(page).toHaveURL(/filter=tolerance/);
  await expect(page.locator('[data-grid] .check-card-wrap')).toHaveCount(2);
  await expect(page.locator('[data-grid] .tolerance-tag')).toHaveCount(2);
  await expect(chip).toHaveAttribute('aria-current', 'page');
});

test('on the check page a reviewer takes one as the new baseline and rejects the other, by keyboard', async ({
  reviewerPage: page,
  admin,
}) => {
  const seeded = await seedDrift(admin);
  // Newest first: cart (posted last), then home.
  await open(page, `/ui/checks/${seeded.cart}?filter=tolerance`);
  await expect(page.locator('.review-head .status')).toContainText('passed');
  await expect(page.locator('.review-head .status')).toContainText('within tolerance (0.08% ≤ 0.5%)');
  await expect(page.locator('[data-tolerance-note]')).toContainText('Passed within tolerance');
  await expect(page.locator('.review-position')).toHaveText('1 / 2');
  // What differs is there, although it passed: the diff view and the change.
  await page.keyboard.press('4');
  await expect(page.locator('#stage')).toHaveAttribute('data-mode', 'diff');
  await expect(page.locator('.changes .region-name').first()).toHaveText('Change 1');
  await expect(page.getByRole('button', { name: /Approve as new baseline/ })).toBeVisible();

  await page.keyboard.press('a');
  await expect(page.locator('.toast').last()).toContainText('Approved cart');
  await expect(page).toHaveURL(new RegExp(`/ui/checks/${seeded.home}`));
  expect((await seeded.ci.call<CheckJson>('GET', `/checks/${seeded.cart}`)).review).toBe('approved');

  await page.keyboard.press('r');
  await expect(page.locator('.reject-popover')).toBeVisible();
  await page.keyboard.press('6');
  await page.keyboard.press('Enter');
  await expect(page.locator('.toast').last()).toContainText('Rejected home (real bug)');
  await expect(page.getByRole('heading', { name: 'Build reviewed' })).toBeVisible();
  expect(await seeded.ci.call<CheckJson>('GET', `/checks/${seeded.home}`)).toMatchObject({
    review: 'rejected',
    withinTolerance: true,
    reviewReasonCode: 'real_bug',
  });

  // Undo puts it back as it was: passed within the tolerance.
  await page.keyboard.press('u');
  await expect(page).toHaveURL(new RegExp(`/ui/checks/${seeded.home}`));
  expect((await seeded.ci.call<CheckJson>('GET', `/checks/${seeded.home}`)).review).toBe('none');
  await expect(page.locator('.review-head .status')).toContainText('passed');
});
