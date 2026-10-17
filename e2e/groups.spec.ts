import { makePng, WHITE } from '../test/helpers/png';
import { Api, expect, open, REVIEWER, test } from './fixtures';

interface CheckJson {
  id: string;
  review: string;
  result: string;
  groupId: string | null;
}

/** A screen of a small site: a header whose logo is `logo` wide, and a block of its own at `x`. */
const site = (logo: number, x: number, clock = 0) =>
  makePng(480, 300, WHITE, [
    { x: 0, y: 0, width: 480, height: 60, color: [17, 17, 17, 255] },
    { x: 20, y: 18, width: logo, height: 24, color: [255, 255, 255, 255] },
    { x, y: 120, width: 120, height: 80, color: [0, 112, 243, 255] },
    // A clock in the corner: its digits' heights follow `clock`.
    ...[0, 1, 2].map((d) => ({
      x: 380 + d * 22,
      y: 230,
      width: 16,
      height: 12 + ((clock + d) % 2) * 10,
      color: [60, 60, 60, 255] as [number, number, number, number],
    })),
  ]);

const SCREENS = ['home', 'cart', 'account'];

/** A project of its own: build #1 approved; build #2 widened the logo on every screen. */
async function seedGroup(admin: Api) {
  const slug = `grp-${Math.random().toString(36).slice(2, 10)}`;
  await admin.call('POST', '/projects', { slug, name: `Groups ${slug.slice(4)}` });
  // New projects are members only: the reviewer the tests log in as is added.
  await admin.call('POST', `/projects/${slug}/members`, { email: REVIEWER, role: 'reviewer' });
  const { token } = await admin.call<{ token: string }>('POST', `/projects/${slug}/tokens`, {
    name: 'e2e',
    scopes: ['read', 'write', 'review'],
  });
  const ci = new Api(admin.url, { authorization: `Bearer ${token}` });
  const first = await ci.call<{ id: string }>('POST', `/projects/${slug}/builds`, { branch: 'main' });
  for (const [i, name] of SCREENS.entries()) await ci.check(first.id, name, site(90, 40 + i * 140));
  await ci.call('POST', `/builds/${first.id}/approve`);
  const second = await ci.call<{ id: string }>('POST', `/projects/${slug}/builds`, { branch: 'main' });
  const ids: string[] = [];
  for (const [i, name] of SCREENS.entries()) ids.push((await ci.check(second.id, name, site(140, 40 + i * 140))).id);
  return { slug, ci, buildId: second.id, ids };
}

test('a group card approves every screen at once with A, in place, and U undoes it', async ({
  reviewerPage: page,
  admin,
}) => {
  const { ci, buildId, ids } = await seedGroup(admin);
  await open(page, `/ui/builds/${buildId}?filter=pending`);
  await page.evaluate(() => {
    (window as unknown as { stayed: boolean }).stayed = true;
  });
  const card = page.locator('[data-group-card]');
  await expect(card).toHaveCount(1);
  await expect(card).toContainText('Same change on 3 screens');
  await expect(card.getByRole('button', { name: 'Approve all 3' })).toBeVisible();
  const before = await card.boundingBox();

  await card.focus();
  await page.keyboard.press('a');
  await expect(page.locator('.toast').last()).toContainText('Approved the same change on 3 screens');
  await expect(card.locator('.card-state')).toHaveText('resolved');
  await expect(card).toBeFocused();
  // In place: the same spot, the same height, no page load.
  expect(await card.boundingBox()).toEqual(before);
  expect(await page.evaluate(() => (window as unknown as { stayed?: boolean }).stayed)).toBe(true);
  for (const id of ids) expect((await ci.call<CheckJson>('GET', `/checks/${id}`)).review).toBe('approved');
  await expect(page.locator('[data-live="chips"]')).toContainText('Resolved 3');

  await page.keyboard.press('u');
  await expect(page.locator('.toast').last()).toContainText('Review undone');
  await expect(card.getByRole('button', { name: 'Approve all 3' })).toBeVisible();
  await expect(card).toBeFocused();
  for (const id of ids) expect((await ci.call<CheckJson>('GET', `/checks/${id}`)).review).toBe('pending');

  // R asks why for the whole group; the reason goes on every member. Undo on the toast takes it back.
  await page.keyboard.press('r');
  await expect(card.locator('.reject-popover')).toBeVisible();
  await page.keyboard.press('1');
  await page.keyboard.press('Enter');
  await expect(page.locator('.toast')).toHaveCount(1);
  await expect(page.locator('.toast.tone-danger').last()).toContainText('Rejected the same change on 3 screens');
  await expect(card.locator('.card-state')).toHaveText('rejected');
  await expect(card).toBeFocused();
  for (const id of ids) {
    expect((await ci.call<CheckJson & { reviewReasonCode: string }>('GET', `/checks/${id}`)).reviewReasonCode).toBe(
      'not_loaded',
    );
  }
  await page.locator('.toast.tone-danger').last().getByRole('button', { name: 'Undo (U)' }).click();
  await expect(card.getByRole('button', { name: 'Approve all 3' })).toBeVisible();
  for (const id of ids) expect((await ci.call<CheckJson>('GET', `/checks/${id}`)).review).toBe('pending');

  // Shift+R: the old one-key reject, without a reason.
  await card.focus();
  await page.keyboard.press('Shift+R');
  await expect(card.locator('.card-state')).toHaveText('rejected');
  for (const id of ids) {
    expect(await ci.call<CheckJson & { reviewReasonCode: string | null }>('GET', `/checks/${id}`)).toMatchObject({
      review: 'rejected',
      reviewReasonCode: null,
    });
  }
});

test('a check of a group approves the whole group from focus mode, and U undoes it', async ({
  reviewerPage: page,
  admin,
}) => {
  const { ci, ids } = await seedGroup(admin);
  await open(page, `/ui/checks/${ids[0]}?filter=pending`);
  await expect(page.locator('.group-note')).toContainText('Also on 2 other screens');
  await page.locator('.group-note').getByRole('button', { name: 'Approve all 3' }).click();
  await expect(page.locator('.toast').last()).toContainText('Approved the same change on 3 screens');
  await expect(page.getByRole('heading', { name: 'Build reviewed' })).toBeVisible();
  await expect(page.locator('.reviewed-screen')).toContainText('3 approved');
  for (const id of ids) expect((await ci.call<CheckJson>('GET', `/checks/${id}`)).review).toBe('approved');

  await page.keyboard.press('u');
  await expect(page.locator('.toast').last()).toContainText('Review undone');
  await expect(page).toHaveURL(new RegExp(`/ui/checks/${ids[0]}`));
  for (const id of ids) expect((await ci.call<CheckJson>('GET', `/checks/${id}`)).review).toBe('pending');
});

test('a flaky screen offers to ignore the area that keeps changing, with a preview first', async ({
  reviewerPage: page,
  admin,
}) => {
  const { slug, ci } = await seedGroup(admin);
  // The clock flips run after run while nothing else changes.
  let last = '';
  for (const clock of [1, 0, 1, 0, 1]) {
    const build = await ci.call<{ id: string }>('POST', `/projects/${slug}/builds`, { branch: 'main' });
    last = (await ci.check(build.id, 'home', site(90, 40, clock))).id;
  }
  await open(page, `/ui/p/${slug}/noisy`);
  await expect(page.locator('.noisy-item')).toHaveCount(1);
  await expect(page.locator('.noisy-item')).toContainText('home');

  await open(page, `/ui/checks/${last}?filter=all`);
  await expect(page.locator('.review-head .flaky-badge')).toBeVisible();
  await expect(page.locator('.screen-history-strip .square')).toHaveCount(7);
  const stageArea = page.locator('.pane-overlay .unstable-layer');
  await expect(stageArea).toBeHidden();
  await page.getByText('Ignore noisy area').click();
  // The preview, and the same area on the stage while it is unfolded.
  await expect(page.locator('.unstable-preview .unstable-mark rect')).toBeVisible();
  await expect(stageArea).toBeVisible();
  // Cancel folds the preview back; unfolding it again brings it back.
  await page.locator('.unstable-actions').getByRole('button', { name: 'Cancel' }).click();
  await expect(page.locator('.unstable-preview')).toBeHidden();
  await expect(page.locator('.unstable > summary')).toBeFocused();
  await page.getByText('Ignore noisy area').click();
  await page.getByRole('button', { name: 'Ignore this area' }).click();
  await expect(page.locator('.toast').last()).toContainText('Ignore area added');
  await expect(page.locator('.review-head .status')).toHaveText('passed');
  await expect(page.locator('.review-head .flaky-badge')).toHaveCount(0);
  expect((await ci.call<CheckJson>('GET', `/checks/${last}`)).result).toBe('unchanged');

  await open(page, `/ui/p/${slug}/noisy`);
  await expect(page.getByRole('heading', { name: 'No noisy screens' })).toBeVisible();
});
