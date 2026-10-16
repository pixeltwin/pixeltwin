import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { Project } from '../../src/db/schema';
import { createProject } from '../../src/domain/projects';
import { createTestApp, type TestApp } from '../helpers/app';
import { BLACK, makePng, WHITE } from '../helpers/png';
import { openBuild, seedBaseline, submit } from '../helpers/scenario';
import { html, location, postForm } from '../helpers/ui';

const white = makePng(100, 100);
const withSquare = makePng(100, 100, WHITE, [{ x: 10, y: 10, width: 10, height: 10, color: BLACK }]);

describe('UI build page', () => {
  let t: TestApp;
  let project: Project;
  let reviewer: { cookie: string; id: string };
  let viewer: { cookie: string; id: string };

  beforeEach(async () => {
    t = await createTestApp();
    project = await createProject(t.deps, { slug: 'web', name: 'Web shop' });
    reviewer = await t.userAs('reviewer');
    viewer = await t.userAs('viewer');
  });

  afterEach(async () => {
    await t.close();
  });

  /** Build #1 on feature/cart: one changed (pending), one new (pending), one unchanged check. */
  async function seedBuild() {
    await seedBaseline(t.deps, project, white, { name: 'home' });
    await seedBaseline(t.deps, project, white, { name: 'footer' });
    const buildId = await openBuild(t.deps, 'web', {
      branch: 'feature/cart',
      externalId: 'ci-77',
      commitSha: 'abcdef1234567890',
    });
    const changed = (await submit(t.deps, buildId, withSquare, { name: 'home' })).check;
    const fresh = (await submit(t.deps, buildId, white, { name: 'cart' })).check;
    const same = (await submit(t.deps, buildId, white, { name: 'footer' })).check;
    return { buildId, changed, fresh, same };
  }

  describe('filtering by tag', () => {
    /** Four checks: two devices × two OS versions. */
    async function seedVariants() {
      const buildId = await openBuild(t.deps, 'web');
      const ids: Record<string, string> = {};
      for (const device of ['iphone_13', 'pixel_7']) {
        for (const os of ['ios_16', 'ios_17']) {
          ids[`${device} ${os}`] = (
            await submit(t.deps, buildId, white, { name: 'home', variant: { device, os } })
          ).check.id;
        }
      }
      return { buildId, ids };
    }
    const shown = (body: string, ids: Record<string, string>) =>
      Object.entries(ids)
        .filter(([, id]) => body.includes(`id="${id}"`))
        .map(([k]) => k)
        .sort();

    test('the tags of the build are offered with their counts, each a link that turns it on', async () => {
      const { buildId } = await seedVariants();
      const body = await html(await t.request('GET', `/ui/builds/${buildId}?filter=all`, { as: viewer }));
      expect(body).toContain('<nav class="tag-filter" aria-label="Filter by tag" data-live="tags">');
      expect(body).toContain(
        `<a class="tag-chip" href="/ui/builds/${buildId}?filter=all&amp;tag=device%3Apixel_7" title="device: pixel_7">pixel 7 <span class="count">2</span></a>`,
      );
    });

    test('a tag narrows the grid; tags of one key add up, tags of different keys narrow further', async () => {
      const { buildId, ids } = await seedVariants();
      const page = async (query: string) =>
        html(await t.request('GET', `/ui/builds/${buildId}?filter=all&${query}`, { as: viewer }));
      expect(shown(await page('tag=device:pixel_7'), ids)).toEqual(['pixel_7 ios_16', 'pixel_7 ios_17']);
      expect(shown(await page('tag=device:pixel_7&tag=device:iphone_13'), ids)).toHaveLength(4);
      expect(shown(await page('tag=device:pixel_7&tag=os:ios_17'), ids)).toEqual(['pixel_7 ios_17']);
      const on = await page('tag=device:pixel_7');
      // The chip that is on turns it off again; Clear drops every tag, keeping the filter.
      expect(on).toContain(`<a class="tag-chip on" href="/ui/builds/${buildId}?filter=all" aria-current="true"`);
      expect(on).toContain(`<a class="tag-clear" href="/ui/builds/${buildId}?filter=all">Clear</a>`);
    });
  });

  describe('approving a new screenshot from its card', () => {
    // Plain form without JavaScript; with it the live island posts to the API in place (no reload, no scroll).
    const approveForm = (id: string) =>
      `<form class="card-approve" method="post" action="/ui/checks/${id}/approve" data-inplace="/checks/${id}/approve"`;

    test('reviewers get an Approve button on new checks waiting for review only; viewers do not', async () => {
      const { buildId, changed, fresh, same } = await seedBuild();
      const body = await html(await t.request('GET', `/ui/builds/${buildId}?filter=all`, { as: reviewer }));
      expect(body).toContain(approveForm(fresh.id));
      expect(body).not.toContain(approveForm(changed.id));
      expect(body).not.toContain(approveForm(same.id));
      // The card stays a link; the form sits beside it, not inside it.
      expect(body).toContain(`<div class="check-card-wrap approvable" id="${fresh.id}"`);
      const forViewer = await html(await t.request('GET', `/ui/builds/${buildId}?filter=all`, { as: viewer }));
      expect(forViewer).not.toContain('class="card-approve"');
    });

    test('Approve makes it the baseline and comes back to the build, at the same filter and card', async () => {
      const { buildId, fresh } = await seedBuild();
      const res = await postForm(t, `/ui/checks/${fresh.id}/approve`, { filter: 'all', back: 'build' }, reviewer);
      expect(location(res)).toBe(`/ui/builds/${buildId}?filter=all&done=approved#${fresh.id}`);
      const body = await html(await t.request('GET', location(res).split('#')[0] as string, { as: reviewer }));
      expect(body).toContain('Approved.');
      expect(body).not.toContain(approveForm(fresh.id));
    });
  });

  test('the header names the build by number with its branch, commit, CI run and status', async () => {
    const { buildId } = await seedBuild();
    const page = await html(await t.request('GET', `/ui/builds/${buildId}`, { as: viewer }));
    expect(page).toContain('<h1>Build #1</h1>');
    expect(page).toContain('feature/cart');
    expect(page).toContain('vs main');
    expect(page).toContain('abcdef1');
    expect(page).toContain('ci-77');
    // The same pulsing indicator as on the project cards, not a pill.
    expect(page).toContain(
      '<span class="running-indicator"><span class="pulse" aria-hidden="true"></span>running</span>',
    );
    expect(page).not.toContain('tone-blue">running</span>');
    expect(page).toContain('<a href="/ui/p/web">Web shop</a>');
    expect(page).toContain('<a href="/ui/p/web/builds?branch=feature%2Fcart">feature/cart</a>');
  });

  test('filter chips show their counts; the current one is marked', async () => {
    const { buildId, same } = await seedBuild();
    const all = await html(await t.request('GET', `/ui/builds/${buildId}`, { as: viewer }));
    expect(all).toMatch(/aria-current="page">All <span class="count">3<\/span>/);
    expect(all).toContain('Unresolved <span class="count">2</span>');
    expect(all).toContain('Changed <span class="count">1</span>');
    expect(all).toContain('OK <span class="count">1</span>');
    expect(all).not.toContain('Errors <span');
    // All, New, Unresolved first, then the rest.
    const order = ['All', 'New', 'Unresolved', 'Changed', 'OK'].map((label) =>
      all.indexOf(`>${label} <span class="count">`),
    );
    expect(order.every((at) => at > 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    // An unchanged check's pill says "ok".
    expect(all).toContain('<span class="pill tone-green">ok</span>');
    // The counts say "ok" for unchanged checks too.
    expect(all).toContain('1 changed · 1 new · 1 ok');

    const pending = await html(await t.request('GET', `/ui/builds/${buildId}?filter=pending`, { as: viewer }));
    expect(pending).toMatch(/aria-current="page">Unresolved <span class="count">2<\/span>/);
    expect(pending).not.toContain(`/ui/checks/${same.id}`);
    // Links from before the redesign keep working.
    const old = await html(await t.request('GET', `/ui/builds/${buildId}?review=pending`, { as: viewer }));
    expect(old).not.toContain(`/ui/checks/${same.id}`);
  });

  test('a changed thumbnail is the screenshot with its changes marked in red, plus the diff percentage', async () => {
    const { buildId, changed } = await seedBuild();
    const page = await html(await t.request('GET', `/ui/builds/${buildId}?filter=changed`, { as: viewer }));
    // The new screenshot, and the diff for the island that paints the changed pixels over it.
    expect(page).toContain(
      `<div class="thumb" data-diff="/api/v1/images/${changed.diffImageSha}"><span class="thumb-stack"><img src="/api/v1/images/${changed.imageSha}"`,
    );
    expect(page).toContain('<span class="diff-pct" title="Pixels changed">1%</span>');
    // A check waiting for review says "unresolved".
    expect(page).toContain(
      '<span class="pill tone-amber">changed</span><span class="pill tone-amber">unresolved</span>',
    );
    expect(page).not.toContain('>to review</span>');
    expect(page).toContain('data-islands="search live thumbs"');
  });

  test('thumbnails open focus mode with the same filter', async () => {
    const { buildId, changed, same } = await seedBuild();
    const page = await html(await t.request('GET', `/ui/builds/${buildId}?filter=changed`, { as: viewer }));
    expect(page).toContain('loading="lazy" width="100" height="100"');
    expect(page).toContain(`href="/ui/checks/${changed.id}?filter=changed"`);
    const all = await html(await t.request('GET', `/ui/builds/${buildId}`, { as: viewer }));
    expect(all).toContain(`src="/api/v1/images/${same.imageSha}"`);
  });

  test('Start review opens the newest waiting check; it is gone when nothing waits', async () => {
    const { buildId, fresh } = await seedBuild();
    const page = await html(await t.request('GET', `/ui/builds/${buildId}`, { as: viewer }));
    expect(page).toContain(`href="/ui/checks/${fresh.id}?filter=pending"`);
    expect(page).toContain('Start review');
    await postForm(t, `/ui/builds/${buildId}/approve`, {}, reviewer);
    expect(await html(await t.request('GET', `/ui/builds/${buildId}`, { as: viewer }))).not.toContain('Start review');
  });

  test('Approve all is offered to reviewers, asks first, and approves every waiting check', async () => {
    const { buildId } = await seedBuild();
    const page = await html(await t.request('GET', `/ui/builds/${buildId}`, { as: reviewer }));
    expect(page).toContain('Approve all 2');
    expect(page).toContain('data-confirm="Approve all 2 checks waiting for review?');
    expect(await html(await t.request('GET', `/ui/builds/${buildId}`, { as: viewer }))).not.toContain('Approve all');

    const res = await postForm(t, `/ui/builds/${buildId}/approve`, {}, reviewer);
    expect(location(res)).toBe(`/ui/builds/${buildId}?done=approved-all`);
    const after = await html(await t.request('GET', location(res), { as: reviewer }));
    expect(after).toContain('All pending checks approved.');
    expect(after).toContain(
      '<span class="running-indicator"><span class="pulse" aria-hidden="true"></span>running</span>',
    );
    expect(after).not.toContain('needs review');
    expect((await postForm(t, `/ui/builds/${buildId}/approve`, {}, viewer)).status).toBe(403);
  });

  test('a finalized build still watches, so reviews by others show up', async () => {
    const { buildId } = await seedBuild();
    await postForm(t, `/ui/builds/${buildId}/approve`, {}, reviewer);
    const { finalizeBuild } = await import('../../src/domain/builds');
    await finalizeBuild(t.deps, buildId);
    const page = await html(await t.request('GET', `/ui/builds/${buildId}`, { as: viewer }));
    expect(page).toContain('data-islands="search live thumbs"');
    expect(page).toContain('data-live="build-head" data-live-watch=""');
  });

  test('an open build updates itself while it runs', async () => {
    const { buildId } = await seedBuild();
    const page = await html(await t.request('GET', `/ui/builds/${buildId}`, { as: viewer }));
    expect(page).toContain('data-islands="search live thumbs"');
    expect(page).toContain('data-live="build-head" data-live-open=""');
    expect(page).toContain('data-live="chips"');
    expect(page).toContain('data-live="checks"');
    expect(page).toContain('data-palette-review');
  });

  test('screenshots are listed newest first and can be searched, also without JavaScript', async () => {
    const { buildId, changed, fresh, same } = await seedBuild();
    const page = async (path: string) => html(await t.request('GET', path, { as: viewer }));
    const body = await page(`/ui/builds/${buildId}?filter=all`);
    const at = (id: string) => body.indexOf(`/ui/checks/${id}?filter=all"`);
    expect(at(same.id)).toBeLessThan(at(fresh.id));
    expect(at(fresh.id)).toBeLessThan(at(changed.id));
    expect(body).toContain('<form class="check-search" method="get" action=');
    expect(body).toContain('placeholder="Search screenshots"');

    const found = await page(`/ui/builds/${buildId}?filter=all&q=CART`);
    expect(found).toContain(`/ui/checks/${fresh.id}?filter=all"`);
    expect(found).not.toContain(`/ui/checks/${changed.id}?filter=all"`);
    expect(found).toContain('value="CART"');
    // Filter chips keep the search.
    expect(found).toContain(`href="/ui/builds/${buildId}?filter=pending&amp;q=CART"`);
    expect(await page(`/ui/builds/${buildId}?filter=all&q=nothing-like-this`)).toContain('No checks match');
  });

  test('an empty filter names what is missing and offers all checks', async () => {
    const { buildId } = await seedBuild();
    const page = await html(await t.request('GET', `/ui/builds/${buildId}?filter=error`, { as: viewer }));
    expect(page).toContain('No errors in this build');
    expect(page).toContain(`href="/ui/builds/${buildId}?filter=all"`);
    expect(page).not.toContain('No checks match this filter.');
  });

  test('with everything decided, To review celebrates instead of looking empty', async () => {
    const { buildId } = await seedBuild();
    await postForm(t, `/ui/builds/${buildId}/approve`, {}, reviewer);
    const page = await html(await t.request('GET', `/ui/builds/${buildId}?filter=pending`, { as: viewer }));
    expect(page).toContain('<div class="empty all-done">');
    expect(page).toContain('<svg class="all-done-art"');
    expect(page).toContain('Nothing to review');
    expect(page).toContain('Every check in build #1 is decided.');
    expect(page).toContain('Show all 3 checks');
  });

  test('a build where nothing changed says so', async () => {
    await seedBaseline(t.deps, project, white, { name: 'home' });
    const buildId = await openBuild(t.deps, 'web');
    await submit(t.deps, buildId, white, { name: 'home' });
    const page = await html(await t.request('GET', `/ui/builds/${buildId}?filter=pending`, { as: viewer }));
    expect(page).toContain('No changes');
    expect(page).toContain('Every screenshot matches its baseline.');
  });
});
