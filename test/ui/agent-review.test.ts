import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { SnapshotElement } from '../../src/diff/types';
import { getCheck } from '../../src/domain/checks';
import { createProject, getProjectBySlug, updateProject } from '../../src/domain/projects';
import { approveCheck, type ReviewActor, reviewCheck } from '../../src/domain/reviews';
import { createTestApp, type TestApp } from '../helpers/app';
import { makePng, WHITE } from '../helpers/png';
import { openBuild, submit } from '../helpers/scenario';
import { html, location, postForm } from '../helpers/ui';

const BLUE = [0, 112, 243, 255] as [number, number, number, number];
const page = (y: number, extra = false) =>
  makePng(200, 100, WHITE, [
    { x: 20, y, width: 60, height: 20, color: BLUE },
    ...(extra ? [{ x: 150, y: 70, width: 10, height: 10, color: BLUE }] : []),
  ]);
const button = (y: number): SnapshotElement => ({
  key: '[data-testid=submit]',
  tag: 'button',
  x: 20,
  y,
  width: 60,
  height: 20,
});
const agent: ReviewActor = { kind: 'token', id: 'tok_agent', name: 'claude' };

describe('UI: element changes and agent reviews', () => {
  let t: TestApp;
  let reviewer: { cookie: string; id: string };
  let admin: { cookie: string; id: string };

  beforeEach(async () => {
    t = await createTestApp();
    await createProject(t.deps, { slug: 'web', name: 'Web' });
    reviewer = await t.userAs('reviewer');
    admin = await t.userAs('admin');
  });

  afterEach(async () => {
    await t.close();
  });

  async function changedCheck() {
    const first = (await submit(t.deps, await openBuild(t.deps), page(20), { elements: [button(20)] })).check;
    await approveCheck(t.deps, first.id, reviewer.id);
    const buildId = await openBuild(t.deps);
    return (await submit(t.deps, buildId, page(28, true), { elements: [button(28)] })).check;
  }

  const get = async (path: string, as: { cookie: string } = reviewer) => html(await t.request('GET', path, { as }));

  test('the list of changes names elements first, then the regions they do not explain', async () => {
    const check = await changedCheck();
    const body = await get(`/ui/checks/${check.id}`);
    expect(body).toContain('<span class="region-name"><code>button[data-testid=submit]</code> moved 8 px down</span>');
    expect(body).toContain('data-change="e0"');
    // Where it is now, and dashed where it was, light up with the entry.
    expect(body).toContain('<rect x="20" y="28" width="60" height="20" data-change="e0"></rect>');
    expect(body).toContain('<rect x="20" y="20" width="60" height="20" data-change="e0" class="was"></rect>');
    expect(body).toContain('<span class="region-name">Other change 1</span>');
    expect(body).toContain('aria-label="Ignore button[data-testid=submit]"');
  });

  test('an agent suggestion shows with Accept and Dismiss; accepting approves with its reason', async () => {
    await updateProject(t.deps, 'web', { agentReview: 'suggest' });
    const check = await changedCheck();
    await reviewCheck(t.deps, check.id, 'approve', agent, { reason: 'The button moved on purpose' });
    const body = await get(`/ui/checks/${check.id}`);
    expect(body).toContain('<strong>Agent suggests approving</strong>: The button moved on purpose');
    expect(body).toContain(`action="/ui/checks/${check.id}/suggestion/accept"`);
    expect(body).toContain(`action="/ui/checks/${check.id}/suggestion/dismiss"`);
    expect(body).toContain('<span class="badge-agent" title="A project token: an agent or CI">agent</span>');
    expect(body).toContain('Suggested approving</strong> by token “claude”');

    const build = await get(`/ui/builds/${check.buildId}?filter=all`);
    expect(build).toContain('agent: approve');

    const res = await postForm(t, `/ui/checks/${check.id}/suggestion/accept`, { filter: 'pending' }, reviewer);
    expect(res.status).toBe(303);
    expect(location(res)).toContain('done=approved');
    expect(await getCheck(t.deps, check.id)).toMatchObject({
      review: 'approved',
      reviewComment: 'The button moved on purpose',
      suggestion: null,
    });
  });

  test('dismissing a suggestion keeps the check waiting', async () => {
    await updateProject(t.deps, 'web', { agentReview: 'suggest' });
    const check = await changedCheck();
    await reviewCheck(t.deps, check.id, 'reject', agent, { reason: 'Looks broken' });
    expect(await get(`/ui/checks/${check.id}`)).toContain('<strong>Agent suggests rejecting</strong>: Looks broken');
    const res = await postForm(t, `/ui/checks/${check.id}/suggestion/dismiss`, { filter: 'pending' }, reviewer);
    expect(location(res)).toContain('done=suggestion-dismissed');
    expect(await getCheck(t.deps, check.id)).toMatchObject({ review: 'pending', suggestion: null });
    expect(await get(`/ui/checks/${check.id}`)).toContain('Dismissed the suggestion</strong> by');
  });

  test('Settings sets the agent review policy', async () => {
    const body = await get('/ui/p/web/settings', admin);
    expect(body).toContain('name="agentReview" value="off" checked');
    const res = await postForm(
      t,
      '/ui/p/web/settings',
      { name: 'Web', mainBranch: 'main', agentReview: 'auto-below', agentMaxDiffPercent: '2.5' },
      admin,
    );
    expect(location(res)).toContain('done=project-saved');
    expect(await getProjectBySlug(t.deps, 'web')).toMatchObject({
      agentReview: 'auto-below',
      agentMaxDiffPercent: 2.5,
    });
  });
});
