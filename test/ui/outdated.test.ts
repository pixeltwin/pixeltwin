import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { Project } from '../../src/db/schema';
import { createProject } from '../../src/domain/projects';
import { approveCheck } from '../../src/domain/reviews';
import { createTestApp, type TestApp } from '../helpers/app';
import { BLACK, makePng, WHITE } from '../helpers/png';
import { openBuild, seedBaseline, submit } from '../helpers/scenario';
import { html, postForm } from '../helpers/ui';

const white = makePng(100, 100);
const square = (x: number) => makePng(100, 100, WHITE, [{ x, y: 10, width: 10, height: 10, color: BLACK }]);

describe('UI outdated checks', () => {
  let t: TestApp;
  let project: Project;
  let reviewer: { cookie: string; id: string };

  beforeEach(async () => {
    t = await createTestApp();
    project = await createProject(t.deps, { slug: 'web', name: 'Web shop' });
    reviewer = await t.userAs('reviewer');
    await seedBaseline(t.deps, project, white);
  });

  afterEach(async () => {
    await t.close();
  });

  async function twoBuilds() {
    const oldBuild = await openBuild(t.deps, 'web');
    const old = (await submit(t.deps, oldBuild, square(10))).check;
    const newBuild = await openBuild(t.deps, 'web');
    const newer = (await submit(t.deps, newBuild, square(30))).check;
    await approveCheck(t.deps, newer.id, reviewer.id);
    return { oldBuild, old, newer };
  }

  const page = async (path: string) => html(await t.request('GET', path, { as: reviewer }));

  test('an outdated check says which build decided it, links there, and offers no review', async () => {
    const { old, newer } = await twoBuilds();
    const body = await page(`/ui/checks/${old.id}?filter=all`);
    expect(body).toContain('<span class="pill tone-grey">outdated</span>');
    expect(body).toContain('Build #2 already approved this screen');
    expect(body).toContain(`href="/ui/checks/${newer.id}"`);
    expect(body).not.toContain('data-review-form');
    expect(body).not.toContain('data-key="a"');
  });

  test('the older build is outdated, not waiting for review', async () => {
    const { oldBuild } = await twoBuilds();
    const body = await page(`/ui/builds/${oldBuild}`);
    expect(body).toContain('outdated');
    expect(body).not.toContain('needs review');
  });

  test('a form post that tries to approve it gets the reason, not a review', async () => {
    const { old } = await twoBuilds();
    const res = await postForm(t, `/ui/checks/${old.id}/approve`, {}, reviewer);
    expect(res.status).toBe(409);
    expect(await res.text()).toContain('already approved this screen');
  });
});
