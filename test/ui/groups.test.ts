import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { Project } from '../../src/db/schema';
import { getCheck } from '../../src/domain/checks';
import { createProject } from '../../src/domain/projects';
import { rejectCheck } from '../../src/domain/reviews';
import { createTestApp, type TestApp } from '../helpers/app';
import { BLACK, makePng, WHITE } from '../helpers/png';
import { openBuild, seedBaseline, submit } from '../helpers/scenario';
import { html, location, postForm } from '../helpers/ui';

/** A screen: a header whose logo is `logo` wide and a block of its own at `x`. */
const page = (logo: number, x: number) =>
  makePng(160, 100, WHITE, [
    { x: 0, y: 0, width: 160, height: 16, color: [120, 120, 120, 255] },
    { x: 8, y: 4, width: logo, height: 8, color: BLACK },
    { x, y: 50, width: 20, height: 20, color: BLACK },
  ]);
const NAMES = ['home', 'cart', 'account'];

describe('UI change groups and flaky screens', () => {
  let t: TestApp;
  let project: Project;
  let reviewer: { cookie: string; id: string };
  let viewer: { cookie: string; id: string };
  let buildId: string;
  const ids: Record<string, string> = {};

  beforeEach(async () => {
    t = await createTestApp();
    project = await createProject(t.deps, { slug: 'web', name: 'Web shop' });
    reviewer = await t.userAs('reviewer');
    viewer = await t.userAs('viewer');
    for (const [i, name] of NAMES.entries()) await seedBaseline(t.deps, project, page(30, 20 + i * 40), { name });
    buildId = await openBuild(t.deps);
    for (const [i, name] of NAMES.entries())
      ids[name] = (await submit(t.deps, buildId, page(50, 20 + i * 40), { name })).check.id;
  });

  afterEach(async () => {
    await t.close();
  });

  test('the build page shows the group as one card with Approve all and Reject all', async () => {
    const body = await html(await t.request('GET', `/ui/builds/${buildId}`, { as: reviewer }));
    const groupId = (await getCheck(t.deps, ids.home as string)).groupId as string;
    expect(body).toContain(`id="group-${groupId}"`);
    expect(body).toContain('Same change on 3 screens');
    expect(body).toContain('Approve all 3');
    expect(body).toContain(`data-inplace="/builds/${buildId}/groups/${groupId}/approve"`);
    expect(body).toContain(`data-inplace-undo="/builds/${buildId}/groups/${groupId}/reset"`);
    // The members are in the card, not cards of their own.
    for (const id of Object.values(ids)) expect(body).not.toContain(`id="${id}"`);
    // Viewers see the group without the buttons.
    const seen = await html(await t.request('GET', `/ui/builds/${buildId}`, { as: viewer }));
    expect(seen).toContain('Same change on 3 screens');
    expect(seen).not.toContain('Approve all 3');
  });

  test('a filter that leaves one check of a group shows it as a card of its own', async () => {
    await rejectCheck(t.deps, ids.home as string, reviewer.id);
    await rejectCheck(t.deps, ids.cart as string, reviewer.id);
    const body = await html(await t.request('GET', `/ui/builds/${buildId}?filter=pending`, { as: reviewer }));
    expect(body).toContain(`id="${ids.account}"`);
    expect(body).not.toContain('Same change on');
  });

  test('without JavaScript, Approve all posts the form and comes back to the card', async () => {
    const groupId = (await getCheck(t.deps, ids.home as string)).groupId as string;
    const res = await postForm(
      t,
      `/ui/builds/${buildId}/groups/${groupId}/approve`,
      { filter: 'all', back: 'build', checkIds: [ids.home as string, ids.cart as string] },
      reviewer,
    );
    expect(res.status).toBe(303);
    expect(location(res)).toBe(`/ui/builds/${buildId}?filter=all&done=approved#group-${groupId}`);
    expect((await getCheck(t.deps, ids.home as string)).review).toBe('approved');
    expect((await getCheck(t.deps, ids.account as string)).review).toBe('pending');
    const denied = await postForm(t, `/ui/builds/${buildId}/groups/${groupId}/approve`, {}, viewer);
    expect(denied.status).toBe(403);
  });

  test('a check of a group says where else its change is, with Approve all', async () => {
    const body = await html(await t.request('GET', `/ui/checks/${ids.cart}`, { as: reviewer }));
    expect(body).toContain('Also on 2 other screens');
    expect(body).toContain('Approve all 3');
    const groupId = (await getCheck(t.deps, ids.home as string)).groupId as string;
    const res = await postForm(t, `/ui/builds/${buildId}/groups/${groupId}/approve`, { back: 'check' }, reviewer);
    expect(location(res)).toBe(`/ui/builds/${buildId}?done=approved`);
  });

  test('a flaky screen has a badge, its history and Ignore the area that keeps changing', async () => {
    // The account block jumps back and forth between two places, run after run.
    let last = '';
    for (const x of [100, 140, 100, 140]) {
      const build = await openBuild(t.deps);
      last = (await submit(t.deps, build, page(30, x), { name: 'account' })).check.id;
    }
    const check = await html(await t.request('GET', `/ui/checks/${last}?filter=all`, { as: reviewer }));
    expect(check).toContain('class="flaky-badge"');
    expect(check).toContain('Ignore noisy area');
    expect(check).toContain('class="history screen-history-strip"');
    expect(check).toContain('class="area-layer unstable-layer"');

    const build = await html(await t.request('GET', `/ui/builds/${buildId}`, { as: viewer }));
    expect(build).toContain('class="flaky-badge"');

    const noisy = await html(await t.request('GET', '/ui/p/web/noisy', { as: reviewer }));
    expect(noisy).toContain(`id="noisy-${last}"`);
    // Ignoring happens on the check, after its preview; the list only links there.
    expect(noisy).not.toContain('Ignore noisy area');
    await postForm(
      t,
      `/ui/checks/${last}/areas`,
      { kind: 'ignore', x: '96', y: '46', width: '68', height: '28' },
      reviewer,
    );
    const after = await html(await t.request('GET', '/ui/p/web/noisy', { as: reviewer }));
    expect(after).toContain('No noisy screens');
  });
});
