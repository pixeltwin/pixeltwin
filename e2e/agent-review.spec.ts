import { expect, open, test } from './fixtures';

interface CheckJson {
  review: string;
  suggestion: unknown;
  reviewComment: string | null;
}

test("an agent's suggestion: the reviewer sees its reason, accepts it in one click and moves on", async ({
  reviewerPage: page,
  seeded,
  admin,
}) => {
  await admin.call('PATCH', `/projects/${seeded.slug}`, { agentReview: 'suggest' });
  const answer = await seeded.ci.call<{ outcome: string }>('POST', `/checks/${seeded.changed}/approve`, {
    reason: 'The button is red and wider on purpose: the new call to action.',
  });
  expect(answer.outcome).toBe('suggested');

  await open(page, `/ui/checks/${seeded.changed}?filter=pending`);
  const card = page.getByRole('region', { name: 'Agent suggestion' });
  await expect(card).toContainText('Agent suggests approving: The button is red and wider on purpose');
  await expect(card).toContainText('agent');
  await expect(page.locator('.review-history')).toContainText('Suggested approving by token “e2e”');

  await card.getByRole('button', { name: 'Accept and approve' }).click();
  // On to the next check waiting for review, with the usual notice.
  await expect(page).toHaveURL(new RegExp(`/ui/checks/${seeded.fresh}`));
  await expect(page.locator('.toast').last()).toContainText('Approved');
  const check = await seeded.ci.call<CheckJson>('GET', `/checks/${seeded.changed}`);
  expect(check).toMatchObject({ review: 'approved', suggestion: null });
  expect(check.reviewComment).toContain('new call to action');
});

test('dismissing a suggestion keeps the check waiting', async ({ reviewerPage: page, seeded, admin }) => {
  await admin.call('PATCH', `/projects/${seeded.slug}`, { agentReview: 'suggest' });
  await seeded.ci.call('POST', `/checks/${seeded.changed}/reject`, { reason: 'Looks broken.' });
  await open(page, `/ui/checks/${seeded.changed}?filter=pending`);
  const card = page.getByRole('region', { name: 'Agent suggestion' });
  await expect(card).toContainText('Agent suggests rejecting: Looks broken.');
  await card.getByRole('button', { name: 'Dismiss' }).click();
  await expect(page.locator('.toast').last()).toContainText('Suggestion dismissed');
  await expect(card).toHaveCount(0);
  expect((await seeded.ci.call<CheckJson>('GET', `/checks/${seeded.changed}`)).review).toBe('pending');
});
