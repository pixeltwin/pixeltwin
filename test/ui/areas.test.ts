import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { Project } from '../../src/db/schema';
import { createArea, listAreas } from '../../src/domain/areas';
import { getCheck } from '../../src/domain/checks';
import { createProject } from '../../src/domain/projects';
import { createTestApp, type TestApp } from '../helpers/app';
import { BLACK, makePng, WHITE } from '../helpers/png';
import { openBuild, seedBaseline, submit } from '../helpers/scenario';
import { html, location, postForm } from '../helpers/ui';

const white = makePng(100, 100);
const withClock = makePng(100, 100, WHITE, [{ x: 10, y: 10, width: 10, height: 10, color: BLACK }]);
const overClock = { x: 5, y: 5, width: 20, height: 20 };

describe('UI areas', () => {
  let t: TestApp;
  let project: Project;
  let reviewer: { cookie: string; id: string };
  let viewer: { cookie: string; id: string };

  beforeEach(async () => {
    t = await createTestApp();
    project = await createProject(t.deps, { slug: 'web', name: 'Web shop' });
    reviewer = await t.userAs('reviewer', 'rev@example.com');
    viewer = await t.userAs('viewer');
  });

  afterEach(async () => {
    await t.close();
  });

  async function changedCheck() {
    await seedBaseline(t.deps, project, white);
    const buildId = await openBuild(t.deps, 'web');
    return (await submit(t.deps, buildId, withClock)).check;
  }

  const page = async (path: string, as = reviewer) => html(await t.request('GET', path, { as }));

  test('reviewers get the tools to draw ignore and compare areas; viewers do not', async () => {
    const check = await changedCheck();
    const body = await page(`/ui/checks/${check.id}`);
    expect(body).toContain('data-draw="ignore"');
    expect(body).toContain('data-draw="compare"');
    expect(body).toContain('data-key="i"');
    const forViewer = await page(`/ui/checks/${check.id}`, viewer);
    expect(forViewer).not.toContain('data-draw=');
  });

  test('areas show on every screenshot and are listed with what they do', async () => {
    const check = await changedCheck();
    const { area } = await createArea(t.deps, check.id, reviewer.id, { kind: 'ignore', ...overClock });
    await createArea(t.deps, check.id, reviewer.id, { kind: 'ignore', x: 0, y: 60, width: 50, height: 40 });
    const body = await page(`/ui/checks/${check.id}`);
    expect(body).toContain('<rect class="area area-ignore" x="5" y="5" width="20" height="20"');
    expect(body.split('class="area-layer"').length - 1).toBeGreaterThanOrEqual(2);
    expect(body).toContain('<section class="areas" aria-label="Areas"><h3>Areas</h3>');
    expect(body).toContain('<strong>Ignored</strong>');
    // Ignore areas are on this snapshot, so compare areas cannot be drawn (and the other way round).
    expect(body).toMatch(/data-draw="compare"[^>]* disabled/);
    expect(body).toContain('Delete the ignore areas first to use compare areas');
    expect(body).not.toMatch(/data-draw="ignore"[^>]* disabled/);
    expect(body).toContain(`action="/ui/checks/${check.id}/areas/${area.id}/delete"`);
    // Pointing at an area in the list lights it up on the screenshots.
    expect(body).toContain(`height="20" data-area="${area.id}"`);
    expect(body).toContain(`<li class="area-item area-item-ignore" data-area-item="${area.id}">`);
    // Editing needs JavaScript: the island shows Edit and the Save / Cancel bar.
    expect(body).toContain(`<button type="button" class="small ghost" data-area-edit="${area.id}" hidden`);
    expect(body).toContain('<div class="area-edit-bar" hidden');
    expect(body).toContain('data-area-save');
    expect(body).toContain('data-area-cancel');
    const forViewer = await page(`/ui/checks/${check.id}`, viewer);
    expect(forViewer).not.toContain('/delete"');
    expect(forViewer).not.toContain('data-area-edit');
  });

  test('deleting an area works without JavaScript and compares the check again', async () => {
    const check = await changedCheck();
    const { area } = await createArea(t.deps, check.id, reviewer.id, { kind: 'ignore', ...overClock });
    expect((await getCheck(t.deps, check.id)).result).toBe('unchanged');
    const res = await postForm(t, `/ui/checks/${check.id}/areas/${area.id}/delete`, { filter: 'all' }, reviewer);
    expect(location(res)).toBe(`/ui/checks/${check.id}?filter=all&done=area-deleted`);
    expect(await listAreas(t.deps, check.id)).toEqual([]);
    expect((await getCheck(t.deps, check.id)).result).toBe('changed');
    const forViewer = await postForm(t, `/ui/checks/${check.id}/areas/${area.id}/delete`, {}, viewer);
    expect(forViewer.status).toBe(403);
  });
});
