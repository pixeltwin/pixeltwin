import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { Project } from '../../src/db/schema';
import { getCheck } from '../../src/domain/checks';
import { createProject } from '../../src/domain/projects';
import { approveCheck, rejectCheck, resetReview } from '../../src/domain/reviews';
import { createTestApp, type TestApp } from '../helpers/app';
import { BLACK, makePng, WHITE } from '../helpers/png';
import { openBuild, seedBaseline, submit } from '../helpers/scenario';
import { html, location, postForm } from '../helpers/ui';

const white = makePng(100, 100);
const withSquare = makePng(100, 100, WHITE, [{ x: 10, y: 10, width: 10, height: 10, color: BLACK }]);

describe('UI focus mode', () => {
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

  /** Build #1 on feature/cart: changed (pending), new (pending) and unchanged checks. */
  async function seedBuild() {
    await seedBaseline(t.deps, project, white, { name: 'home' });
    await seedBaseline(t.deps, project, white, { name: 'footer' });
    const buildId = await openBuild(t.deps, 'web', { branch: 'feature/cart', externalId: 'ci-77' });
    const changed = (await submit(t.deps, buildId, withSquare, { name: 'home' })).check;
    const fresh = (await submit(t.deps, buildId, white, { name: 'cart' })).check;
    const same = (await submit(t.deps, buildId, white, { name: 'footer' })).check;
    return { buildId, changed, fresh, same };
  }

  const page = async (path: string, as = reviewer) => html(await t.request('GET', path, { as }));

  test('the header leads back to the build and shows where this check sits in the filter', async () => {
    const { buildId, changed } = await seedBuild();
    const body = await page(`/ui/checks/${changed.id}?filter=pending`);
    expect(body).toContain('data-islands="review"');
    expect(body).toContain('data-build-number="1"');
    expect(body).toContain('data-project-href="/ui/p/web"');
    expect(body).toContain(`href="/ui/builds/${buildId}?filter=pending"`);
    expect(body).toContain('<a href="/ui/p/web">Web shop</a>');
    expect(body).toContain('>#1</a>');
    // Newest first: the changed check was posted before the new one, so it comes second.
    expect(body).toContain('<span class="review-position">2 / 2</span>');
    expect(body).toContain('tone-amber">changed</span>');
  });

  test('the filmstrip lists the checks of the filter and marks the current one', async () => {
    const { changed, fresh, same } = await seedBuild();
    const body = await page(`/ui/checks/${changed.id}?filter=pending`);
    expect(body).toContain(`href="/ui/checks/${changed.id}?filter=pending" aria-current="true"`);
    expect(body).toContain(`href="/ui/checks/${fresh.id}?filter=pending"`);
    expect(body).not.toContain(`/ui/checks/${same.id}`);
    // The review island reads each frame's state to find the next waiting check.
    expect(body).toContain(`data-frame="${changed.id}" data-review="pending"`);
    // Without a filter the strip holds what waits for review.
    expect(await page(`/ui/checks/${changed.id}`)).toContain('<span class="review-position">2 / 2</span>');
    expect(await page(`/ui/checks/${changed.id}?filter=all`)).toContain('<span class="review-position">3 / 3</span>');
  });

  test('previous and next follow the filter, newest first, with j and k', async () => {
    const { changed, fresh } = await seedBuild();
    const first = await page(`/ui/checks/${fresh.id}?filter=pending`);
    expect(first).toContain(`href="/ui/checks/${changed.id}?filter=pending" data-key="j"`);
    expect(first).not.toContain('data-key="k"');
    const second = await page(`/ui/checks/${changed.id}?filter=pending`);
    expect(second).toContain(`href="/ui/checks/${fresh.id}?filter=pending" data-key="k"`);
  });

  test('the stage holds the baseline, the new screenshot and the diff with region boxes', async () => {
    const { changed } = await seedBuild();
    const body = await page(`/ui/checks/${changed.id}`);
    expect(body).toContain(`src="/api/v1/images/${changed.baseline?.imageSha}"`);
    expect(body).toContain(`src="/api/v1/images/${changed.imageSha}"`);
    expect(body).toContain(`src="/api/v1/images/${changed.diffImageSha}"`);
    expect(body).toContain('viewBox="0 0 100 100"');
    expect(body).toContain('<rect x="10" y="10" width="10" height="10"');
    // Side by side marks the changed regions on both images too.
    expect(body.split('<rect x="10" y="10" width="10" height="10"').length - 1).toBe(3);
    // Images never start a native drag, which would fight the slider and panning.
    expect(body).not.toMatch(/<img (?![^>]*draggable="false")[^>]*src="\/api\/v1\/images/);
    expect(body).toContain('data-mode="all"');
    for (const mode of ['side', 'slider', 'onion', 'diff']) expect(body).toContain(`data-mode-button="${mode}"`);
    expect(body).not.toContain('style=');
  });

  test('the info strip lists regions and names the baseline branch, without the summary sentence', async () => {
    const { changed, fresh } = await seedBuild();
    const body = await page(`/ui/checks/${changed.id}`);
    expect(body).not.toContain('1 changed region; largest 10×10 at (10,10) in top-left');
    expect(body).not.toContain('class="summary"');
    expect(body).toContain('data-change="0"');
    expect(await page(`/ui/checks/${fresh.id}`)).not.toContain('New snapshot.</p>');
  });

  test('the info strip shows Diff, Tolerance and Branch', async () => {
    const { changed, fresh } = await seedBuild();
    const body = await page(`/ui/checks/${changed.id}`);
    expect(body).toContain('<dt>Diff</dt><dd>1%</dd>');
    expect(body).toContain('<dt>Tolerance</dt><dd>0%</dd>');
    expect(body).toContain(
      '<dt>Branch</dt><dd><span class="mono">main</span><span class="muted"> (fallback: feature/cart has none yet)</span></dd>',
    );
    expect(body).not.toContain('% changed');
    const forNew = await page(`/ui/checks/${fresh.id}`);
    expect(forNew).not.toContain('<dt>Diff</dt>');
    expect(forNew).not.toContain('<dt>Branch</dt>');
  });

  test('changed areas are named by where they are, and each lights itself up on the screenshots', async () => {
    const { changed } = await seedBuild();
    const body = await page(`/ui/checks/${changed.id}`);
    expect(body).toContain('<dt>Changes</dt><dd>1</dd>');
    expect(body).toContain(
      '<button type="button" class="small ghost" data-change="0" aria-pressed="false" title="Highlight this change on the screenshots"><span>Change 1</span><span class="muted">top left · 10×10 px</span></button>',
    );
    expect(body).toContain('<rect x="10" y="10" width="10" height="10" data-change="0"></rect>');
    expect(body).not.toContain('data-region=');
    expect(body).not.toContain('at (10,10)');
  });

  test('an error check still says what went wrong', async () => {
    const { changed } = await seedBuild();
    await t.deps.db
      .updateTable('checks')
      .set({
        result: 'error',
        diff: JSON.stringify({ error: { code: 'diff_timeout', message: 'The diff took too long.' } }),
      })
      .where('id', '=', changed.id)
      .execute();
    const body = await page(`/ui/checks/${changed.id}`);
    expect(body).toContain('<p class="diff-error">The diff took too long.</p>');
  });

  test('reviewers get Approve, Reject and Skip, without a comment field; viewers get none of them', async () => {
    const { changed, fresh } = await seedBuild();
    const body = await page(`/ui/checks/${changed.id}?filter=pending`);
    expect(body).toContain(`action="/ui/checks/${changed.id}/approve"`);
    expect(body).toContain(`formaction="/ui/checks/${changed.id}/reject"`);
    expect(body).toContain('data-key="a"');
    expect(body).toContain('data-key="r"');
    expect(body).not.toContain('<textarea');
    expect(body).toContain('<input type="hidden" name="filter" value="pending"/>');
    // Skip goes to the next (older) check; the changed check is the oldest waiting, so the new one skips to it.
    expect(await page(`/ui/checks/${fresh.id}?filter=pending`)).toContain(
      `class="button ghost" href="/ui/checks/${changed.id}?filter=pending"`,
    );
    const forViewer = await page(`/ui/checks/${changed.id}`, viewer);
    expect(forViewer).not.toContain('data-key="a"');
    expect(forViewer).not.toContain('/approve"');
  });

  test('a new snapshot shows only the screenshot and says it has no baseline', async () => {
    const { fresh } = await seedBuild();
    const body = await page(`/ui/checks/${fresh.id}`);
    expect(body).toContain('New snapshot — no baseline yet');
    expect(body).toContain('data-mode="new"');
    expect(body).not.toContain('data-mode-button=');
    expect(body).toContain('data-key="a"');
  });

  test('a reviewed check says who reviewed it and offers Undo review to reviewers', async () => {
    const { changed } = await seedBuild();
    await approveCheck(t.deps, changed.id, reviewer.id);
    const body = await page(`/ui/checks/${changed.id}`);
    expect(body).toContain('<strong>Approved</strong> by rev@example.com');
    expect(body).toContain('data-reviewed-by="rev@example.com"');
    expect(body).toContain(`action="/ui/checks/${changed.id}/reset"`);
    expect(body).not.toContain(`action="/ui/checks/${changed.id}/approve"`);
    expect(await page(`/ui/checks/${changed.id}`, viewer)).not.toContain('/reset"');
  });

  test('the history lists every review of the check, newest first, undone ones included', async () => {
    const { changed, fresh } = await seedBuild();
    const token = await t.tokenAs('web', ['read', 'review']);
    await approveCheck(t.deps, changed.id, reviewer.id, { comment: 'fine' });
    await resetReview(t.deps, changed.id, reviewer.id);
    await rejectCheck(t.deps, changed.id, token.id, { comment: 'too wide' });
    const body = await page(`/ui/checks/${changed.id}`);
    expect(body).toContain('<section class="review-history" aria-label="Review history"><h3>History</h3>');
    const rejected = body.indexOf('<strong>Rejected</strong> by token “test”');
    const undone = body.indexOf('<strong>Undone</strong> by rev@example.com');
    const approved = body.indexOf('<strong>Approved</strong> by rev@example.com');
    expect(rejected).toBeGreaterThan(-1);
    expect(undone).toBeGreaterThan(rejected);
    expect(approved).toBeGreaterThan(undone);
    expect(body).toContain('<span class="comment">“too wide”</span>');
    expect(body).toContain('<span class="comment">“fine”</span>');
    expect(body).toContain('data-reviewed-by="token “test”"');
    expect(await page(`/ui/checks/${fresh.id}`)).not.toContain('class="review-history"');
  });

  test('approving moves on to the next check waiting for review, keeping the filter', async () => {
    const { buildId, changed, fresh } = await seedBuild();
    const first = await postForm(t, `/ui/checks/${changed.id}/approve`, { filter: 'pending' }, reviewer);
    expect(location(first)).toBe(`/ui/checks/${fresh.id}?filter=pending&done=approved`);
    expect((await getCheck(t.deps, changed.id)).review).toBe('approved');

    const second = await postForm(t, `/ui/checks/${fresh.id}/reject`, { comment: 'cart icon missing' }, reviewer);
    expect(location(second)).toBe(`/ui/builds/${buildId}?done=rejected`);
    expect(await getCheck(t.deps, fresh.id)).toMatchObject({
      review: 'rejected',
      reviewComment: 'cart icon missing',
      reviewedBy: reviewer.id,
    });
    // A rejected check can still be approved, not rejected again.
    const again = await page(`/ui/checks/${fresh.id}`);
    expect(again).toContain('data-key="a"');
    expect(again).not.toContain('data-key="r"');
  });

  test('a review can be undone without JavaScript', async () => {
    const { changed } = await seedBuild();
    await postForm(t, `/ui/checks/${changed.id}/approve`, {}, reviewer);
    const res = await postForm(t, `/ui/checks/${changed.id}/reset`, {}, reviewer);
    expect(res.status).toBe(303);
    expect(location(res)).toBe(`/ui/checks/${changed.id}?done=reset`);
    expect((await getCheck(t.deps, changed.id)).review).toBe('pending');
    expect(await page(location(res))).toContain('Review undone.');
    expect((await postForm(t, `/ui/checks/${changed.id}/reset`, {}, viewer)).status).toBe(403);
  });

  test('viewers cannot post reviews', async () => {
    const { buildId, changed } = await seedBuild();
    expect((await postForm(t, `/ui/checks/${changed.id}/approve`, {}, viewer)).status).toBe(403);
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
