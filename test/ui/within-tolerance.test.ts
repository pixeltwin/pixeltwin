import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { Project } from '../../src/db/schema';
import { getCheck } from '../../src/domain/checks';
import { createProject, getProjectBySlug } from '../../src/domain/projects';
import { createTestApp, type TestApp } from '../helpers/app';
import { BLACK, makePng, WHITE } from '../helpers/png';
import { openBuild, seedBaseline, submit } from '../helpers/scenario';
import { html, location, postForm } from '../helpers/ui';

const white = makePng(100, 100);
/** 100 of 10 000 pixels differ: 1%, within the project's 2%. */
const drift = makePng(100, 100, WHITE, [{ x: 10, y: 10, width: 10, height: 10, color: BLACK }]);
/** 900 pixels: 9%, changed. */
const changed = makePng(100, 100, WHITE, [{ x: 10, y: 10, width: 30, height: 30, color: BLACK }]);

describe('UI: checks within the tolerance', () => {
  let t: TestApp;
  let project: Project;
  let reviewer: { cookie: string; id: string };
  let viewer: { cookie: string; id: string };

  beforeEach(async () => {
    t = await createTestApp();
    project = await createProject(t.deps, { slug: 'web', name: 'Web shop', tolerancePercent: 2 });
    reviewer = await t.userAs('reviewer');
    viewer = await t.userAs('viewer');
  });

  afterEach(async () => {
    await t.close();
  });

  /** Two within the tolerance (one rejected), one identical, one changed. */
  async function seedBuild() {
    for (const name of ['home', 'cart', 'footer', 'pricing']) await seedBaseline(t.deps, project, white, { name });
    const buildId = await openBuild(t.deps, 'web');
    const home = (await submit(t.deps, buildId, drift, { name: 'home' })).check;
    const cart = (await submit(t.deps, buildId, drift, { name: 'cart' })).check;
    const footer = (await submit(t.deps, buildId, white, { name: 'footer' })).check;
    const pricing = (await submit(t.deps, buildId, changed, { name: 'pricing' })).check;
    return { buildId, home, cart, footer, pricing };
  }

  test('a card within the tolerance says so, with how much differs, and paints its changes', async () => {
    const { buildId, home, footer } = await seedBuild();
    const body = await html(await t.request('GET', `/ui/builds/${buildId}?filter=all`, { as: viewer }));
    const card = (id: string) =>
      body.slice(body.indexOf(`id="${id}"`), body.indexOf('</a>', body.indexOf(`id="${id}"`)));
    expect(card(home.id)).toContain('class="check-card card-passed card-tolerance"');
    expect(card(home.id)).toContain('<span class="card-state">passed</span>');
    expect(card(home.id)).toContain('<span class="tolerance-word">within tolerance </span>1% ≤ 2%</span>');
    expect(card(home.id)).toContain('data-diff="/api/v1/images/');
    expect(card(footer.id)).toContain('class="check-card card-passed"');
    expect(card(footer.id)).not.toContain('tolerance');
  });

  test('the chip counts them; Passed and the meta line count each check once', async () => {
    const { buildId, cart } = await seedBuild();
    await postForm(t, `/ui/checks/${cart.id}/reject`, { reasonCode: 'real_bug' }, reviewer);
    const body = await html(await t.request('GET', `/ui/builds/${buildId}?filter=all`, { as: viewer }));
    expect(body).toContain(`?filter=tolerance">Within tolerance <span class="count">2</span></a>`);
    // home passed within the tolerance, footer is identical; the rejected cart is not a pass.
    expect(body).toContain(`?filter=unchanged">Passed <span class="count">2</span></a>`);
    expect(body).toContain('1 changed · 1 rejected · 1 passed · 2 within tolerance');
  });

  test('the filter lists exactly them, with search and paging', async () => {
    for (let i = 0; i < 5; i++) await seedBaseline(t.deps, project, white, { name: `screen-${i}` });
    await seedBaseline(t.deps, project, white, { name: 'same' });
    const buildId = await openBuild(t.deps, 'web');
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) ids.push((await submit(t.deps, buildId, drift, { name: `screen-${i}` })).check.id);
    const same = (await submit(t.deps, buildId, white, { name: 'same' })).check.id;
    const page = async (query: string) =>
      html(await t.request('GET', `/ui/builds/${buildId}?filter=tolerance&${query}`, { as: viewer }));
    const first = await page('size=2&page=1');
    expect(first).toContain('data-total="5"');
    expect(first).not.toContain(`id="${same}"`);
    // Newest first: the last two posted on page 1, the first one alone on page 3.
    expect(first).toContain(`id="${ids[4]}"`);
    expect(first).toContain(`id="${ids[3]}"`);
    const last = await page('size=2&page=3');
    expect(last).toContain(`id="${ids[0]}"`);
    expect(last).not.toContain(`id="${ids[1]}"`);
    const found = await page('q=screen-2');
    expect(found).toContain(`id="${ids[2]}"`);
    expect(found).not.toContain(`id="${ids[1]}"`);
  });

  test('lanes and the builds table count them apart from auto', async () => {
    const { buildId } = await seedBuild();
    const builds = await html(await t.request('GET', '/ui/p/web/builds', { as: viewer }));
    expect(builds).toContain('<span class="legend-auto">1</span> auto');
    expect(builds).toContain('<span class="legend-tolerance">2</span> within tolerance');
    expect(builds).toContain('title="1 automatically · 2 within tolerance · 1 needed review · 1 left"');
    expect(buildId).toBeTruthy();
  });

  test('the check page says it passed within tolerance and offers Approve as new baseline and Reject', async () => {
    const { home } = await seedBuild();
    const body = await html(await t.request('GET', `/ui/checks/${home.id}?filter=tolerance`, { as: reviewer }));
    expect(body).toContain('<span class="pill tone-green">passed</span>');
    expect(body).toContain('within tolerance (1% ≤ 2%)</span>');
    expect(body).toContain('<strong>Passed within tolerance</strong>');
    // The diff and the change are there although it passed.
    expect(body).toContain('data-mode-button="diff"');
    expect(body).toContain('<span class="region-name">Change 1</span>');
    expect(body).toContain('Approve as new baseline <kbd>A</kbd>');
    expect(body).toContain('data-reject-menu');
    expect(body).toContain('data-tolerance=""');

    const readOnly = await html(await t.request('GET', `/ui/checks/${home.id}`, { as: viewer }));
    expect(readOnly).not.toContain('Approve as new baseline');
    expect(readOnly).not.toContain('Approve to take this screenshot');
  });

  test('approving from the page takes it as the baseline and walks on to the next one within the tolerance', async () => {
    const { home, cart } = await seedBuild();
    const res = await postForm(t, `/ui/checks/${cart.id}/approve`, { filter: 'tolerance' }, reviewer);
    expect(res.status).toBe(303);
    expect(location(res)).toBe(`/ui/checks/${home.id}?filter=tolerance&done=approved`);
    expect(await getCheck(t.deps, cart.id)).toMatchObject({ review: 'approved', reviewedBy: reviewer.id });
    const page = await html(await t.request('GET', `/ui/checks/${cart.id}?filter=tolerance`, { as: reviewer }));
    expect(page).toContain('Undo review <kbd>U</kbd>');
    expect(page).toContain('<span class="pill tone-green">approved</span>');

    await postForm(t, `/ui/checks/${cart.id}/reset`, {}, reviewer);
    expect((await getCheck(t.deps, cart.id)).review).toBe('none');
  });

  test('rejecting, with a reason, flags it as a real change', async () => {
    const { buildId, home } = await seedBuild();
    await postForm(t, `/ui/checks/${home.id}/reject`, { reasonCode: 'real_bug', reason: 'Logo shifted' }, reviewer);
    expect(await getCheck(t.deps, home.id)).toMatchObject({ review: 'rejected', reviewReasonCode: 'real_bug' });
    const body = await html(await t.request('GET', `/ui/builds/${buildId}?filter=tolerance`, { as: viewer }));
    expect(body).toContain('class="check-card card-rejected card-tolerance"');
  });

  test('Settings turn on review of checks within the tolerance', async () => {
    const admin = await t.userAs('admin');
    const before = await html(await t.request('GET', '/ui/p/web/settings', { as: admin }));
    expect(before).toContain('Within-tolerance checks need review');
    const res = await postForm(
      t,
      '/ui/p/web/settings',
      {
        name: 'Web shop',
        mainBranch: 'main',
        colorThreshold: '0.1',
        tolerancePercent: '2',
        retentionDays: '5',
        reviewWithinTolerance: 'on',
      },
      admin,
    );
    expect(res.status).toBe(303);
    expect((await getProjectBySlug(t.deps, 'web')).reviewWithinTolerance).toBe(true);
    await seedBaseline(t.deps, project, white, { name: 'home' });
    const buildId = await openBuild(t.deps, 'web');
    const { check } = await submit(t.deps, buildId, drift, { name: 'home' });
    expect(check.review).toBe('pending');
    const page = await html(await t.request('GET', `/ui/checks/${check.id}`, { as: reviewer }));
    expect(page).toContain('<strong>Within tolerance, waits for review</strong>');
    expect(page).toContain('<span class="pill tone-amber">unresolved</span>');
  });
});
