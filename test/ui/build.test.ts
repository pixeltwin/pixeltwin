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
    expect(all).toContain('To review <span class="count">2</span>');
    expect(all).toContain('Changed <span class="count">1</span>');
    expect(all).not.toContain('Errors <span');

    const pending = await html(await t.request('GET', `/ui/builds/${buildId}?filter=pending`, { as: viewer }));
    expect(pending).toMatch(/aria-current="page">To review <span class="count">2<\/span>/);
    expect(pending).not.toContain(`/ui/checks/${same.id}`);
    // Links from before the redesign keep working.
    const old = await html(await t.request('GET', `/ui/builds/${buildId}?review=pending`, { as: viewer }));
    expect(old).not.toContain(`/ui/checks/${same.id}`);
  });

  test('thumbnails show the diff for changed checks and open focus mode with the same filter', async () => {
    const { buildId, changed, same } = await seedBuild();
    const page = await html(await t.request('GET', `/ui/builds/${buildId}?filter=changed`, { as: viewer }));
    expect(page).toContain(`src="/api/v1/images/${changed.diffImageSha}"`);
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
    expect(page).toContain('data-islands="search live"');
    expect(page).toContain('data-live="build-head" data-live-watch=""');
  });

  test('an open build updates itself while it runs', async () => {
    const { buildId } = await seedBuild();
    const page = await html(await t.request('GET', `/ui/builds/${buildId}`, { as: viewer }));
    expect(page).toContain('data-islands="search live"');
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
