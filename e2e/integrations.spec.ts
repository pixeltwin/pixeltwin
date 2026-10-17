import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect, open, test } from './fixtures';

/** A webhook receiver on a free port that answers 200 and records what it got. */
async function receiver(): Promise<{ url: string; received: Array<Record<string, unknown>>; server: Server }> {
  const received: Array<Record<string, unknown>> = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      received.push({ event: req.headers['x-pixeltwin-event'], body: JSON.parse(body) });
      res.end('ok');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/hook`, received, server };
}

test('choosing GitLab in the pull request settings: the hint follows, the token is kept write-only', async ({
  adminPage: page,
  seeded,
}) => {
  await open(page, `/ui/p/${seeded.slug}/settings`);
  const section = page.locator('section[aria-labelledby="integration-title"]');
  await expect(section.locator('#integration-provider-hint')).toContainText('fine-grained personal access token');
  await section.getByLabel('Code host').selectOption('gitlab');
  await expect(section.locator('#integration-provider-hint')).toContainText('project access token');
  await section.getByLabel('Repository').fill('group/sub/shop');
  await section.getByLabel('Token').fill('glpat-e2e-token-9z9z');
  await section.getByRole('button', { name: 'Save' }).click();
  await expect(page.locator('.toast').last()).toContainText('Pull request settings saved.');
  await expect(section.locator('#integration-token-hint')).toContainText('Set, ends in 9z9z');
  await expect(section.getByLabel('Code host')).toHaveValue('gitlab');
  await expect(section.getByLabel('API or instance URL')).toHaveValue('https://gitlab.com');
  await expect(section).toContainText('/api/v1/integrations/gitlab/webhook');
  expect(await page.content()).not.toContain('glpat-e2e-token');
  await expect(section.getByRole('button', { name: 'Remove GitLab integration' })).toBeVisible();
});

test('a webhook is added, its secret shown once, and Send test lists the delivery', async ({
  adminPage: page,
  seeded,
}) => {
  const hook = await receiver();
  try {
    await open(page, `/ui/p/${seeded.slug}/settings`);
    await page.getByRole('link', { name: 'New webhook' }).click();
    await page.getByLabel('URL').fill(hook.url);
    await page.getByLabel('check.reviewed').check();
    await page.getByRole('button', { name: 'Add webhook' }).click();
    await expect(page.locator('#new-webhook-secret')).toHaveText(/^whsec_[0-9A-Za-z]{32}$/);
    await page.getByRole('button', { name: 'Send test' }).click();
    await expect(page.locator('.toast').last()).toContainText('Test delivered.');
    await expect(page.locator('table.deliveries')).toContainText('ping');
    await expect(page.locator('table.deliveries')).toContainText('delivered · 200');
    // Shown once: gone after the reload.
    await expect(page.locator('#new-webhook-secret')).toHaveCount(0);
    expect(hook.received.map((r) => r.event)).toEqual(['ping']);

    // A review in the UI is delivered too.
    await open(page, `/ui/checks/${seeded.changed}`);
    await page.keyboard.press('a');
    await expect.poll(() => hook.received.map((r) => r.event), { timeout: 10_000 }).toContain('check.reviewed');

    await open(page, `/ui/p/${seeded.slug}/settings`);
    const row = page.locator('section[aria-labelledby="webhooks-title"] tbody tr');
    await expect(row).toContainText(hook.url);
    await expect(row).toContainText('delivered · 200');
  } finally {
    hook.server.close();
  }
});
