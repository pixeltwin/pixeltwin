import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { scaleOf } from '../../src/ui/charts';
import { spanText } from '../../src/ui/pages/insights';
import { createTestApp, type TestApp } from '../helpers/app';
import { seedInsights } from '../helpers/insights';
import { html } from '../helpers/ui';

describe('Insights page', () => {
  let t: TestApp;
  let rita: { cookie: string; id: string };

  beforeEach(async () => {
    t = await createTestApp();
    rita = await t.userAs('reviewer', 'rita@example.com', { projects: [] });
    const project = await seedInsights(t);
    await t.deps.db
      .insertInto('projectMembers')
      .values({ projectId: project.id, userId: rita.id, role: 'viewer', createdAt: Date.now() })
      .execute();
  });

  afterEach(async () => {
    await t.close();
  });

  const page = async (query = '') => html(await t.request('GET', `/ui/p/web/insights${query}`, { as: rita }));

  test('members with project.read see the tiles, five charts with their tables and the screen tables', async () => {
    const body = await page('?range=7');
    expect(body).toContain('<a href="/ui/p/web/insights" aria-current="page">Insights</a>');
    expect(body).toContain('aria-current="page" data-range="7"');
    for (const tile of ['auto-pass', 'time-to-decision', 'noise', 'run-time', 'flaky']) {
      expect(body).toContain(`data-tile="${tile}"`);
    }
    expect(body).toContain('<p class="tile-value">33%</p>');
    expect(body).toContain('<p class="tile-value">2 of 3</p>');
    const charts = [...body.matchAll(/<figure class="chart chart-kind-(line|stack)" id="([a-z-]+)"/g)].map((m) => m[2]);
    expect(charts).toEqual([
      'chart-auto-pass',
      'chart-review-load',
      'chart-reasons',
      'chart-time-to-decision',
      'chart-run-time',
    ]);
    // Accessible: named images, and the numbers as tables.
    expect(body).toContain('role="img" aria-labelledby="chart-auto-pass-title chart-auto-pass-desc"');
    expect(body).toContain('<title id="chart-auto-pass-title">Auto-pass rate</title>');
    expect(body.match(/<summary>Show the numbers<\/summary>/g)).toHaveLength(5);
    expect(body).toContain('data-islands="charts"');
    // Each band has a native tooltip until the island takes over.
    expect(body).toMatch(/<g class="chart-band" data-tip="[^"]+">/);
    // The screens to fix: about was rejected twice as not loaded, so the fix is a wait, not an area.
    expect(body).toContain('Screens to fix in the tests');
    expect(body).toMatch(
      /about<\/a>[\s\S]*?2× not loaded[\s\S]*?Wait for the page to finish loading[\s\S]*?Open check/,
    );
    expect(body).toContain('rita@example.com');
  });

  test('90 days are drawn in weeks; a branch without builds shows the empty state, no charts', async () => {
    const weeks = await page('?range=90');
    expect(weeks).toContain('class="chart-svg bars-13"');
    const none = await page('?range=30&branch=feature%2Fnone');
    expect(none).toContain('No builds in this range');
    expect(none).not.toContain('<figure class="chart');
    expect(none).toContain('<option value="feature/none" selected="">feature/none</option>');
    expect(none).toContain('No noisy screens in this range.');
  });

  test('an unknown range falls back to 30 days', async () => {
    expect(await page('?range=12')).toContain('aria-current="page" data-range="30"');
  });

  test('a user outside the project gets 404', async () => {
    const outsider = await t.userAs('reviewer', 'out@example.com', { projects: [] });
    const res = await t.request('GET', '/ui/p/web/insights', { as: outsider });
    expect(res.status).toBe(404);
  });

  test('the other project pages have the Insights tab', async () => {
    expect(await html(await t.request('GET', '/ui/p/web', { as: rita }))).toContain('href="/ui/p/web/insights"');
  });
});

describe('chart scales and times', () => {
  test('gridlines are round steps', () => {
    expect(scaleOf(27)).toEqual({ max: 30, ticks: [0, 10, 20, 30] });
    expect(scaleOf(3)).toEqual({ max: 3, ticks: [0, 1, 2, 3] });
    expect(scaleOf(0)).toEqual({ max: 1, ticks: [0, 1] });
    const hour = 3_600_000;
    expect(scaleOf(5 * hour, [hour, 2 * hour, 6 * hour]).ticks).toEqual([0, 2 * hour, 4 * hour, 6 * hour]);
  });

  test('times to decision read in the largest units that matter', () => {
    expect(spanText(45_000)).toBe('45 s');
    expect(spanText(18 * 60_000)).toBe('18m');
    expect(spanText(130 * 60_000)).toBe('2h 10m');
    expect(spanText(76 * 3_600_000)).toBe('3d 4h');
    expect(spanText(null)).toBe('—');
  });
});
