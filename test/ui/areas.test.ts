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
    // Short labels; the tooltip says what the tool draws.
    expect(body).toContain('title="Draw an ignore area">Ignore <kbd>I</kbd></button>');
    expect(body).toContain('title="Draw a compare area">Compare <kbd>C</kbd></button>');
    // Compare modes on the left; the drawing tools and zoom together on the right.
    expect(body).toContain('<div class="stage-actions">');
    expect(body.indexOf('class="segmented modes"')).toBeLessThan(body.indexOf('class="stage-actions"'));
    expect(body.indexOf('class="stage-actions"')).toBeLessThan(body.indexOf('data-draw="ignore"'));
    expect(body.indexOf('data-draw="ignore"')).toBeLessThan(body.indexOf('data-zoom="toggle"'));
    // Fit / 100 % shows an icon, not its key (Z still works and is in the tooltip).
    expect(body).toContain('<span data-zoom-label="true">Fit</span><svg class="icon icon-fit"');
    expect(body).not.toContain('<kbd>Z</kbd>');
    expect(body).toContain('title="Fit / 100% (Z)"');
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
    expect(body).toContain(`<button type="button" class="small ghost icon-button" data-area-edit="${area.id}" hidden`);
    // Edit and Delete are icons, named for screen readers and in a tooltip.
    expect(body).toContain('<svg class="icon icon-edit"');
    expect(body).toContain('<svg class="icon icon-delete"');
    expect(body).not.toMatch(/>\s*(Edit|Delete)\s*<\/button>/);
    expect(body).toContain('<div class="area-edit-bar" hidden');
    expect(body).toContain('data-area-save');
    expect(body).toContain('data-area-cancel');
    const forViewer = await page(`/ui/checks/${check.id}`, viewer);
    expect(forViewer).not.toContain('/delete"');
    expect(forViewer).not.toContain('data-area-edit');
  });

  test('each change has Ignore, which adds an ignore area over it (4 px around), also without JavaScript', async () => {
    const check = await changedCheck();
    const body = await page(`/ui/checks/${check.id}?filter=all`);
    // The change is 10×10 at (10,10) on a 100×100 screenshot.
    expect(body).toContain(`<form method="post" action="/ui/checks/${check.id}/areas" data-area-add="true">`);
    expect(body).toContain(
      '<input type="hidden" name="kind" value="ignore"/><input type="hidden" name="x" value="6"/><input type="hidden" name="y" value="6"/><input type="hidden" name="width" value="18"/><input type="hidden" name="height" value="18"/>',
    );
    expect(body).toContain('aria-label="Ignore change 1"');
    expect(await page(`/ui/checks/${check.id}`, viewer)).not.toContain('data-area-add');

    const res = await postForm(
      t,
      `/ui/checks/${check.id}/areas`,
      { filter: 'all', kind: 'ignore', x: '6', y: '6', width: '18', height: '18' },
      reviewer,
    );
    expect(location(res)).toBe(`/ui/checks/${check.id}?filter=all&done=area-added`);
    expect(
      (await listAreas(t.deps, check.id)).map(({ kind, x, y, width, height }) => [kind, x, y, width, height]),
    ).toEqual([['ignore', 6, 6, 18, 18]]);
    expect((await getCheck(t.deps, check.id)).result).toBe('unchanged');
    const forViewer = await postForm(
      t,
      `/ui/checks/${check.id}/areas`,
      { kind: 'ignore', x: '0', y: '0', width: '5', height: '5' },
      viewer,
    );
    expect(forViewer.status).toBe(403);
  });

  test('Ignore is disabled on a snapshot that has compare areas', async () => {
    const check = await changedCheck();
    await createArea(t.deps, check.id, reviewer.id, { kind: 'compare', x: 0, y: 0, width: 100, height: 100 });
    const body = await page(`/ui/checks/${check.id}`);
    expect(body).toMatch(/aria-label="Ignore change 1"[^>]*disabled/);
    expect(body).toContain('Delete the compare areas first to ignore a change');
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

  describe('ignore regions sent through the API with the check', () => {
    const statusBar = { x: 0, y: 0, width: 100, height: 20 };

    async function checkWithApiIgnore() {
      await seedBaseline(t.deps, project, white);
      const buildId = await openBuild(t.deps, 'web');
      return (await submit(t.deps, buildId, withClock, { ignoreRegions: [statusBar] })).check;
    }

    test('are drawn on the screenshot, marked as API and not editable', async () => {
      const check = await checkWithApiIgnore();
      const body = await page(`/ui/checks/${check.id}`);
      expect(body).toContain('<rect class="area area-api-ignore" x="0" y="0" width="100" height="20"></rect>');
      expect(body).toContain('class="area-api-label"');
      expect(body).toMatch(/>(IGNORED · )?API<\/text>/);
      // Not a drawn area: no id, so the island never picks it for editing.
      expect(body).not.toMatch(/area-api-ignore"[^>]*data-area=/);
    });

    test('are listed with an API badge, without edit or delete, and say they apply to this check only', async () => {
      const check = await checkWithApiIgnore();
      const body = await page(`/ui/checks/${check.id}`);
      expect(body).toContain('<li class="area-item area-item-api">');
      expect(body).toContain(
        '<span class="badge-api" title="Sent with the check through the API (ignoreRegions)">API</span>',
      );
      expect(body).toContain('top center · 100×20 px');
      expect(body).toContain('Sent by the test with this check only');
      const item = body.slice(body.indexOf('area-item-api'), body.indexOf('</li>', body.indexOf('area-item-api')));
      expect(item).not.toContain('data-area-edit');
      expect(item).not.toContain('data-area-delete');
    });

    test('show for viewers too, and a check without them has no Areas section', async () => {
      const check = await checkWithApiIgnore();
      expect(await page(`/ui/checks/${check.id}`, viewer)).toContain('area-item-api');
      const plain = await changedCheck();
      expect(await page(`/ui/checks/${plain.id}`)).not.toContain('aria-label="Areas"');
    });
  });
});
