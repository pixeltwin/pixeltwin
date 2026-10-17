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
    // Drawn areas have a source badge like the API's.
    expect(body).toContain(
      '<span class="badge-source" title="Drawn in pixeltwin: applies to every check of this snapshot, on every branch">UI</span>',
    );
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
    // Instead of a sentence, a ring that counts down to the autosave (shown once the area changed).
    expect(body).toContain('data-autosave="true" hidden=""');
    expect(body).toContain('<span class="autosave-left" data-autosave-left="true">5s</span>');
    expect(body).not.toContain('Editing area');
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

  test('Ignore all changes adds an ignore area around each change at once, also without JavaScript', async () => {
    await seedBaseline(t.deps, project, white);
    const twoChanges = makePng(100, 100, WHITE, [
      { x: 10, y: 10, width: 10, height: 10, color: BLACK },
      { x: 70, y: 70, width: 10, height: 10, color: BLACK },
    ]);
    const check = (await submit(t.deps, await openBuild(t.deps, 'web'), twoChanges)).check;
    const form = `<form class="ignore-all" method="post" action="/ui/checks/${check.id}/areas/ignore-changes" data-ignore-changes="true">`;
    expect(await page(`/ui/checks/${check.id}?filter=all`)).toContain(form);
    expect(await page(`/ui/checks/${check.id}`, viewer)).not.toContain('data-ignore-changes');

    expect((await postForm(t, `/ui/checks/${check.id}/areas/ignore-changes`, {}, viewer)).status).toBe(403);
    const res = await postForm(t, `/ui/checks/${check.id}/areas/ignore-changes`, { filter: 'all' }, reviewer);
    expect(location(res)).toBe(`/ui/checks/${check.id}?filter=all&done=changes-ignored`);
    expect(await listAreas(t.deps, check.id)).toHaveLength(2);
    expect((await getCheck(t.deps, check.id)).result).toBe('unchanged');
  });

  test('Delete all areas deletes every area of the snapshot at once, after asking, also without JavaScript', async () => {
    const check = await changedCheck();
    await createArea(t.deps, check.id, reviewer.id, { kind: 'ignore', x: 0, y: 0, width: 5, height: 5 });
    // One area has only its own Delete.
    expect(await page(`/ui/checks/${check.id}?filter=all`)).not.toContain('data-areas-delete-all');
    await createArea(t.deps, check.id, reviewer.id, { kind: 'ignore', x: 20, y: 20, width: 5, height: 5 });
    const body = await page(`/ui/checks/${check.id}?filter=all`);
    expect(body).toContain(`action="/ui/checks/${check.id}/areas/delete-all" data-areas-delete-all="true"`);
    expect(body).toContain('Delete all 2 areas');
    expect(body).toContain('data-ask="Delete all 2 areas of this snapshot?');
    expect(await page(`/ui/checks/${check.id}`, viewer)).not.toContain('data-areas-delete-all');

    expect((await postForm(t, `/ui/checks/${check.id}/areas/delete-all`, {}, viewer)).status).toBe(403);
    const res = await postForm(t, `/ui/checks/${check.id}/areas/delete-all`, { filter: 'all' }, reviewer);
    expect(location(res)).toBe(`/ui/checks/${check.id}?filter=all&done=areas-deleted`);
    expect(await listAreas(t.deps, check.id)).toHaveLength(0);
  });

  test('a single change has no Ignore all: its own Ignore does the same', async () => {
    const check = await changedCheck();
    expect(await page(`/ui/checks/${check.id}`)).not.toContain('data-ignore-changes');
  });

  test('the build page finds the screenshots that have drawn areas', async () => {
    const check = await changedCheck();
    const other = (await submit(t.deps, check.buildId, white, { name: 'footer' })).check;
    await createArea(t.deps, check.id, reviewer.id, { kind: 'ignore', ...overClock });
    const body = await page(`/ui/builds/${check.buildId}?filter=areas`);
    expect(body).toMatch(/aria-current="page">Areas <span class="count">1<\/span>/);
    expect(body).toContain(`id="${check.id}"`);
    expect(body).not.toContain(`id="${other.id}"`);
  });

  test('areas can be switched off on the check page to see what they hide; nothing changes', async () => {
    const check = await changedCheck();
    await createArea(t.deps, check.id, reviewer.id, { kind: 'ignore', ...overClock });
    const on = await page(`/ui/checks/${check.id}?filter=all`);
    expect(on).toContain(
      `<a class="button small areas-toggle" href="/ui/checks/${check.id}?filter=all&amp;areas=off" data-areas="on"`,
    );
    expect(on).not.toContain('class="pane pane-diff"');

    const off = await page(`/ui/checks/${check.id}?filter=all&areas=off`);
    // The Areas list stays where it is, disabled, so the panel does not jump; no banner.
    expect(off).not.toContain('class="areas-off"');
    expect(off).toContain('<section class="areas is-off" aria-label="Areas">');
    expect(off).toMatch(/aria-label="Delete this area"[^>]*disabled/);
    expect(off).toMatch(/aria-label="Ignore change 1"[^>]*disabled/);
    expect(off).toContain(
      `<a class="button small areas-toggle" href="/ui/checks/${check.id}?filter=all" data-areas="off"`,
    );
    expect(off).toContain('class="pane pane-diff"');
    expect(off).toContain('<span class="count">1</span>');
    // No area is drawn while they are off, and none can be drawn.
    expect(off).not.toContain('class="area area-ignore"');
    expect(off).not.toContain('data-draw="ignore"');
    expect((await getCheck(t.deps, check.id)).result).toBe('unchanged');
    // A check without areas has no switch.
    const plain = (await submit(t.deps, check.buildId, withClock, { name: 'plain' })).check;
    expect(await page(`/ui/checks/${plain.id}`)).not.toContain('areas-toggle');
  });

  test('the toolbar keeps the same buttons with Show diff on and off, so nothing moves', async () => {
    // The area hides the only change: as compared, the check has no diff.
    const check = await changedCheck();
    await createArea(t.deps, check.id, reviewer.id, { kind: 'ignore', ...overClock });
    const toolbar = (body: string) => {
      const from = body.indexOf('<div class="stage-toolbar"');
      return body.slice(from, body.indexOf('<div class="panes">', from));
    };
    const buttons = (body: string) =>
      [...toolbar(body).matchAll(/<(?:button|a)\b[^>]*>(?:(?!<\/(?:button|a)>).)*<\/(?:button|a)>/gs)].map((m) =>
        m[0]
          .replace(/<[^>]+>/g, '')
          .replace(/\s+/g, ' ')
          .trim(),
      );
    const on = await page(`/ui/checks/${check.id}?filter=all`);
    const off = await page(`/ui/checks/${check.id}?filter=all&areas=off`);
    expect(buttons(on)).toEqual(buttons(off));
    expect(buttons(on)).toContain('Diff 4');
    // Without a diff, Diff and Changes are there but disabled.
    expect(toolbar(on)).toMatch(/<button type="button" data-mode-button="diff" aria-pressed="false" disabled/);
    // Drawing is off while Show diff is on, but its buttons stay.
    expect(toolbar(off)).toContain('class="segmented draw-tools"');
    expect(toolbar(off)).not.toContain('data-draw=');
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

    test('are drawn on the screenshot like a drawn ignore area, without a label, and not editable', async () => {
      const check = await checkWithApiIgnore();
      const body = await page(`/ui/checks/${check.id}`);
      // The same colour as a drawn ignore area; only the Areas list's API badge tells them apart.
      expect(body).toContain(
        '<rect class="area area-ignore area-from-api" x="0" y="0" width="100" height="20"></rect>',
      );
      // No label on the screenshot: the Areas list says where they come from.
      expect(body).not.toContain('<text');
      // Not a drawn area: no id, so the island never picks it for editing.
      expect(body).not.toMatch(/area-from-api"[^>]*data-area=/);
    });

    test('are listed with an API badge, without edit or delete, and say they apply to this check only', async () => {
      const check = await checkWithApiIgnore();
      const body = await page(`/ui/checks/${check.id}`);
      expect(body).toContain('<li class="area-item area-item-api">');
      expect(body).toContain(
        '<span class="badge-source" title="Sent with the check through the API (ignoreRegions)">API</span>',
      );
      // Two lines: what it is and where it comes from, then where it is and how big.
      expect(body).toContain('<span class="area-place muted">top center · 100×20 px</span>');
      // No explanation under the list: the API badge's tooltip says it.
      expect(body).not.toContain('Sent by the test');
      const item = body.slice(body.indexOf('area-item-api'), body.indexOf('</li>', body.indexOf('area-item-api')));
      expect(item).not.toContain('data-area-edit');
      expect(item).not.toContain('data-area-delete');
    });

    test('the Areas section comes before the list of changes', async () => {
      await seedBaseline(t.deps, project, white);
      const buildId = await openBuild(t.deps, 'web');
      const check = (
        await submit(t.deps, buildId, withClock, { ignoreRegions: [{ x: 60, y: 60, width: 20, height: 20 }] })
      ).check;
      const body = await page(`/ui/checks/${check.id}`);
      expect(body.indexOf('aria-label="Areas"')).toBeGreaterThan(0);
      expect(body.indexOf('aria-label="Areas"')).toBeLessThan(body.indexOf('<details class="changes"'));
    });

    test('show for viewers too, and a check without them has no Areas section', async () => {
      const check = await checkWithApiIgnore();
      expect(await page(`/ui/checks/${check.id}`, viewer)).toContain('area-item-api');
      const plain = await changedCheck();
      expect(await page(`/ui/checks/${plain.id}`)).not.toContain('aria-label="Areas"');
    });
  });
});
