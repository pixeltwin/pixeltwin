import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { Project } from '../../src/db/schema';
import { getCheck } from '../../src/domain/checks';
import { createProject } from '../../src/domain/projects';
import { createTestApp, type TestApp } from '../helpers/app';
import { BLACK, makePng, WHITE } from '../helpers/png';
import { openBuild, seedBaseline, submit } from '../helpers/scenario';
import { html, location, postForm } from '../helpers/ui';

const white = makePng(100, 100);
const withSquare = makePng(100, 100, WHITE, [{ x: 10, y: 10, width: 10, height: 10, color: BLACK }]);

describe('UI review flow', () => {
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

  /** A build with one changed, one new and one unchanged check. */
  async function seedBuild() {
    await seedBaseline(t.deps, project, white, { name: 'home' });
    await seedBaseline(t.deps, project, white, { name: 'footer' });
    const buildId = await openBuild(t.deps, 'web', { branch: 'feature/cart', externalId: 'ci-77' });
    const changed = (await submit(t.deps, buildId, withSquare, { name: 'home' })).check;
    const fresh = (await submit(t.deps, buildId, white, { name: 'cart' })).check;
    const same = (await submit(t.deps, buildId, white, { name: 'footer' })).check;
    return { buildId, changed, fresh, same };
  }

  test('the build page shows thumbnails, filters and Approve all only to reviewers', async () => {
    const { buildId, changed, same } = await seedBuild();
    const page = await html(await t.request('GET', `/ui/builds/${buildId}`, { as: reviewer }));
    expect(page).toContain(`src="/api/v1/images/${changed.diffImageSha}"`);
    expect(page).toContain(`src="/api/v1/images/${same.imageSha}"`);
    expect(page).toContain('Approve all 2');
    expect(await html(await t.request('GET', `/ui/builds/${buildId}`, { as: viewer }))).not.toContain('Approve all');

    const pending = await html(await t.request('GET', `/ui/builds/${buildId}?review=pending`, { as: viewer }));
    expect(pending).toContain('class="current"');
    expect(pending).not.toContain(`/ui/checks/${same.id}`);
  });

  test('the check page shows the diff with region boxes and keyboard actions', async () => {
    const { changed } = await seedBuild();
    const page = await html(await t.request('GET', `/ui/checks/${changed.id}`, { as: reviewer }));
    expect(page).toContain(`src="/api/v1/images/${changed.diffImageSha}"`);
    expect(page).toContain('viewBox="0 0 100 100"');
    expect(page).toContain('<rect x="10" y="10" width="10" height="10"');
    expect(page).toContain('1 changed region; largest 10×10 at (10,10) in top-left');
    expect(page).toContain('data-key="a"');
    expect(page).toContain('data-key="r"');
    expect(page).toContain('fallback from base branch');
    expect(page).toContain('100 px (1%), 1 region<');
    expect(page).not.toContain('style=');

    const side = await html(await t.request('GET', `/ui/checks/${changed.id}?view=side`, { as: reviewer }));
    expect(side).toContain(`src="/api/v1/images/${changed.baseline?.imageSha}"`);
    expect(side).toContain(`src="/api/v1/images/${changed.imageSha}"`);
  });

  test('approving moves on to the next check awaiting review, then back to the build', async () => {
    const { buildId, changed, fresh } = await seedBuild();
    const first = await postForm(t, `/ui/checks/${changed.id}/approve`, {}, reviewer);
    expect(location(first)).toBe(`/ui/checks/${fresh.id}?done=approved`);
    expect((await getCheck(t.deps, changed.id)).review).toBe('approved');

    const second = await postForm(t, `/ui/checks/${fresh.id}/reject`, { comment: 'cart icon missing' }, reviewer);
    expect(location(second)).toBe(`/ui/builds/${buildId}?done=rejected`);
    const rejected = await getCheck(t.deps, fresh.id);
    expect(rejected).toMatchObject({ review: 'rejected', reviewComment: 'cart icon missing', reviewedBy: reviewer.id });
    const again = await html(await t.request('GET', `/ui/checks/${fresh.id}`, { as: reviewer }));
    expect(again).toContain('data-key="a"');
    expect(again).not.toContain('data-key="r"');
    expect(await html(await t.request('GET', `/ui/builds/${buildId}?done=rejected`, { as: reviewer }))).toContain(
      'Rejected.',
    );
  });

  test('approve all from the build page', async () => {
    const { buildId } = await seedBuild();
    const res = await postForm(t, `/ui/builds/${buildId}/approve`, {}, reviewer);
    expect(location(res)).toBe(`/ui/builds/${buildId}?done=approved-all`);
    const page = await html(await t.request('GET', location(res), { as: reviewer }));
    expect(page).toContain('All pending checks approved.');
    expect(page).toContain('badge passed');
  });

  test('viewers see no review buttons and cannot post reviews', async () => {
    const { buildId, changed } = await seedBuild();
    const page = await html(await t.request('GET', `/ui/checks/${changed.id}`, { as: viewer }));
    expect(page).not.toContain('data-key="a"');
    const res = await postForm(t, `/ui/checks/${changed.id}/approve`, {}, viewer);
    expect(res.status).toBe(403);
    expect((await postForm(t, `/ui/builds/${buildId}/approve`, {}, viewer)).status).toBe(403);
    expect((await getCheck(t.deps, changed.id)).review).toBe('pending');
  });

  test('reviewing an already reviewed check shows a clear error page', async () => {
    const { same } = await seedBuild();
    const res = await postForm(t, `/ui/checks/${same.id}/approve`, {}, reviewer);
    expect(res.status).toBe(409);
    expect(await html(res)).toContain('Check not reviewable');
  });
});
