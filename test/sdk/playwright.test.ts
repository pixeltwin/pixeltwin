// Runs the Playwright suite in packages/playwright/test/suite through the SDK against a real server.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Check, PixeltwinClient } from '@pixeltwin/client';
import { REPO, startServer, type TestServer } from './server';

let server: TestServer;
let client: PixeltwinClient;
let outputDir: string;

beforeAll(async () => {
  server = await startServer('pw');
  client = new PixeltwinClient({ url: server.url, token: server.token });
  outputDir = mkdtempSync(join(tmpdir(), 'pixeltwin-pw-'));
}, 60_000);

afterAll(async () => {
  await server?.stop();
  if (outputDir) rmSync(outputDir, { recursive: true, force: true });
});

function playwright(env: Record<string, string> = {}, args: string[] = []) {
  const run = spawnSync(
    join(REPO, 'node_modules/.bin/playwright'),
    ['test', '-c', 'packages/playwright/test/suite/playwright.config.ts', ...args],
    {
      cwd: REPO,
      encoding: 'utf8',
      env: {
        PATH: process.env.PATH ?? '',
        HOME: process.env.HOME ?? '',
        PIXELTWIN_URL: server.url,
        PIXELTWIN_TOKEN: server.token,
        PIXELTWIN_BRANCH: 'main',
        SUITE_PROJECT: 'pw',
        SUITE_OUTPUT_DIR: outputDir,
        ...env,
      },
    },
  );
  const output = `${run.stdout}\n${run.stderr}`;
  const buildId = /\/ui\/builds\/(bld_[0-9A-Z]+)/.exec(output)?.[1] ?? '';
  return { status: run.status, output, buildId };
}

async function checksOf(buildId: string): Promise<Check[]> {
  return (await client.listChecks(buildId, { limit: 200 })).items;
}

const key = (c: Check) => `${c.name} ${c.variant.viewport}`;

describe('Playwright Test through @pixeltwin/playwright', () => {
  test('new → approve → unchanged with the gate → a change fails the gate; shards share one build', async () => {
    // Run 1: no baselines yet, every check is new; without the gate the run passes.
    const first = playwright();
    expect(first.status).toBe(0);
    expect(first.output).toContain('9 passed');
    expect(first.output).toContain('verdict pending');
    const one = await client.getBuild(first.buildId);
    expect(one.state).toBe('finalized');
    expect(one.counts.result.new).toBe(9);
    const checks = await checksOf(first.buildId);
    expect(checks.map(key).sort()).toEqual(
      ['412x839', '640x480', '800x600'].flatMap((v) => [`full page ${v}`, `header ${v}`, `home ${v}`]).sort(),
    );
    for (const c of checks) expect(c.variant.browser).toBe('chromium');

    // Ignore boxes land in screenshot pixels: the clock is 150 CSS pixels wide.
    const find = (name: string, viewport: string) =>
      checks.find((c) => c.name === name && c.variant.viewport === viewport);
    const width = (name: string, viewport: string) => find(name, viewport)?.ignoreRegions[0]?.width ?? 0;
    expect(width('home', '800x600')).toBeWithin(150, 152);
    expect(width('home', '640x480')).toBeWithin(300, 302); // device scale factor 2
    // The phone (scale factor 2.625) shows the page zoomed out to 980 CSS pixels: 2.625 × 412 / 980.
    expect(width('home', '412x839')).toBeWithin(164, 168);
    expect(find('home', '800x600')?.ignoreRegions).toHaveLength(1); // the footer clock is below the fold
    expect(find('home', '412x839')?.ignoreRegions).toHaveLength(2); // zoomed out, the footer shows
    expect(find('full page', '800x600')?.ignoreRegions).toHaveLength(2);
    expect(find('full page', '640x480')?.ignoreRegions[1]?.y).toBeGreaterThan(2 * 1200);
    expect(find('header', '640x480')?.ignoreRegions[0]?.y).toBeLessThan(2 * 64);
    // Chromium paints the footer clock (x 50.6875, 150 wide) snapped to CSS pixels 51–201, which at
    // 2.625 ends inside device column 527 (527.625). The exact box ends at 526.8; the region must
    // reach 528 or column 527 is compared and the random digits make the run flaky.
    const footer = find('full page', '412x839')?.ignoreRegions[1];
    expect(footer?.x).toBeLessThanOrEqual(133);
    expect((footer?.x ?? 0) + (footer?.width ?? 0)).toBeGreaterThanOrEqual(528);

    await client.approveBuild(first.buildId);

    // Run 2 with the gate: the clocks changed but are ignored, so everything is unchanged.
    const second = playwright({ PIXELTWIN_GATE: '1' });
    expect(second.output).toContain('verdict passed');
    expect(second.status).toBe(0);
    expect((await client.getBuild(second.buildId)).counts.result.unchanged).toBe(9);

    // Run 3: the heading changed; tests still pass, the gate fails the run and names the checks.
    const third = playwright({ PIXELTWIN_GATE: '1', SUITE_CHANGE: '1' });
    expect(third.status).toBe(1);
    expect(third.output).toContain('9 passed');
    expect(third.output).toContain('verdict pending');
    expect(third.output).toMatch(/changed\s+home \(chromium, 800x600\)/);
    expect(third.output).toContain('not "passed"');
    const changed = await client.getBuild(third.buildId);
    expect(changed.counts.result).toEqual({ unchanged: 3, changed: 6, new: 0, error: 0 });

    // failOnChange: the changed checks fail their tests at once, with the link, and the test gets
    // the expected, actual and diff images.
    const failing = playwright({ PIXELTWIN_FAIL_ON_CHANGE: '1', SUITE_CHANGE: '1', SUITE_LIST_ATTACHMENTS: '1' });
    expect(failing.status).toBe(1);
    expect(failing.output).toContain('6 failed');
    expect(failing.output).toContain('3 passed');
    expect(failing.output).toMatch(/PixeltwinCheckError: pixeltwin: "home" \(chromium, 800x600\) is changed/);
    expect(failing.output).toContain(
      'attachments of home: pixeltwin home, pixeltwin home expected, pixeltwin home actual, pixeltwin home diff',
    );

    // Two shards with one externalId post to one build; neither finalizes; the CLI does.
    const shardEnv = { PIXELTWIN_EXTERNAL_ID: 'pw-shards-1', PIXELTWIN_GATE: '1' };
    const shard1 = playwright(shardEnv, ['--shard=1/2']);
    const shard2 = playwright(shardEnv, ['--shard=2/2']);
    expect(shard1.status).toBe(0);
    expect(shard2.status).toBe(0);
    expect(shard1.output).toContain('npx pixeltwin finalize');
    expect(shard2.buildId).toBe(shard1.buildId);
    const open = await client.getBuild(shard1.buildId);
    expect(open.state).toBe('open');
    expect(open.counts.total).toBe(9);

    const finalize = spawnSync(process.execPath, ['packages/client/src/bin.ts', 'finalize', '--gate'], {
      cwd: REPO,
      encoding: 'utf8',
      env: {
        PATH: process.env.PATH ?? '',
        PIXELTWIN_URL: server.url,
        PIXELTWIN_TOKEN: server.token,
        PIXELTWIN_PROJECT: 'pw',
        PIXELTWIN_BRANCH: 'main',
        PIXELTWIN_EXTERNAL_ID: 'pw-shards-1',
      },
    });
    expect(finalize.stdout).toContain('verdict passed');
    expect(finalize.status).toBe(0);
    expect((await client.getBuild(shard1.buildId)).state).toBe('finalized');
  }, 180_000);

  test('a run without a token stops before any test', () => {
    const run = playwright({ PIXELTWIN_TOKEN: '' });
    expect(run.status).toBe(1);
    expect(run.output).toContain('PIXELTWIN_TOKEN');
    expect(run.output).not.toContain('passed');
  }, 60_000);

  test('PIXELTWIN_DISABLED=1 runs the tests and posts nothing', () => {
    const run = playwright({ PIXELTWIN_TOKEN: '', PIXELTWIN_DISABLED: '1' });
    expect(run.status).toBe(0);
    expect(run.output).toContain('9 passed');
    expect(run.output).toContain('disabled');
  }, 60_000);
});
