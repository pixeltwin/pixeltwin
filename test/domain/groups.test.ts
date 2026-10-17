import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { Project } from '../../src/db/schema';
import { getCheck, listChecks } from '../../src/domain/checks';
import { getGroup, listGroups, resetGroup, reviewGroup } from '../../src/domain/groups';
import { approveCheck, listReviews } from '../../src/domain/reviews';
import { createTestDeps, type TestDeps } from '../helpers/deps';
import { appError } from '../helpers/errors';
import { BLACK, type FilledRect, makePng, type Rgba, WHITE } from '../helpers/png';
import { openBuild, seedBaseline, seedProject, submit } from '../helpers/scenario';

const GREY: Rgba = [120, 120, 120, 255];
const RED: Rgba = [229, 72, 77, 255];

/** A screen: its own content and a header whose logo is `logo` wide. */
const screen = (body: FilledRect[], logo = 40, extra: FilledRect[] = []) =>
  makePng(200, 160, WHITE, [
    { x: 0, y: 0, width: 200, height: 20, color: GREY },
    { x: 10, y: 4, width: logo, height: 12, color: BLACK },
    ...body,
    ...extra,
  ]);

const BODIES: Record<string, FilledRect[]> = {
  home: [{ x: 20, y: 60, width: 80, height: 40, color: RED }],
  cart: [{ x: 120, y: 90, width: 50, height: 50, color: BLACK }],
  account: [{ x: 30, y: 120, width: 140, height: 10, color: GREY }],
  pricing: [{ x: 60, y: 40, width: 20, height: 100, color: RED }],
};
const EXTRA: FilledRect = { x: 150, y: 140, width: 20, height: 10, color: RED };

describe('change groups', () => {
  let deps: TestDeps;
  let project: Project;
  let buildId: string;
  const ids: Record<string, string> = {};

  beforeEach(async () => {
    deps = await createTestDeps();
    project = await seedProject(deps);
    for (const [name, body] of Object.entries(BODIES)) {
      for (const browser of ['chromium', 'firefox'])
        await seedBaseline(deps, project, screen(body), { name, variant: { browser } });
    }
    // The logo got wider on every screen; pricing on firefox also changed something else.
    buildId = await openBuild(deps);
    for (const [name, body] of Object.entries(BODIES)) {
      for (const browser of ['chromium', 'firefox']) {
        const extra = name === 'pricing' && browser === 'firefox' ? [EXTRA] : [];
        const { check } = await submit(deps, buildId, screen(body, 60, extra), { name, variant: { browser } });
        ids[`${name}/${browser}`] = check.id;
      }
    }
  });

  afterEach(async () => {
    await deps.handle.close();
  });

  test('checks with exactly the same changes form a group; a check with one more change is not in it', async () => {
    const groups = await listGroups(deps, buildId);
    expect(groups).toHaveLength(1);
    const [group] = groups;
    expect(group?.size).toBe(7);
    expect(group?.counts).toEqual({ pending: 7, approved: 0, rejected: 0, outdated: 0 });
    expect(group?.checks.map((c) => c.id)).not.toContain(ids['pricing/firefox']);
    expect(group?.regions).toHaveLength(1);
    // Newest first, like the build page.
    expect(group?.checks[0]?.id).toBe(ids['pricing/chromium'] as string);

    const home = await getCheck(deps, ids['home/chromium'] as string);
    expect(home.groupId).toBe(group?.id as string);
    expect((await getCheck(deps, ids['pricing/firefox'] as string)).groupId).toBeNull();
    const page = await listChecks(deps, buildId);
    expect(page.items.filter((c) => c.groupId === group?.id)).toHaveLength(7);
  });

  test('a single check with a change of its own is no group', async () => {
    const other = await openBuild(deps);
    const { check } = await submit(deps, other, screen(BODIES.home as FilledRect[], 60), {
      name: 'home',
      variant: { browser: 'chromium' },
    });
    expect(check.groupId).toBeNull();
    expect(await listGroups(deps, other)).toEqual([]);
    expect((await appError(getGroup(deps, other, 'nope'))).code).toBe('group_not_found');
  });

  test('approving a group approves what waits, one review event each, and reports the rest', async () => {
    const [group] = await listGroups(deps, buildId);
    const groupId = group?.id as string;
    await approveCheck(deps, ids['home/chromium'] as string, 'usr_1');

    const result = await reviewGroup(deps, buildId, groupId, 'approve', 'usr_2', { comment: 'new logo' });
    expect(result.changed).toHaveLength(6);
    expect(result.skipped).toEqual([{ checkId: ids['home/chromium'] as string, review: 'approved' }]);
    expect(result.group.counts.approved).toBe(7);
    // pricing/firefox (header and one more change) still waits.
    expect(result.verdict).toBe('pending');
    for (const id of result.changed) {
      const events = await listReviews(deps, id);
      expect(events.map((e) => [e.action, e.actor, e.comment])).toEqual([['approved', 'usr_2', 'new logo']]);
      expect((await getCheck(deps, id)).review).toBe('approved');
    }
    expect((await getCheck(deps, ids['pricing/firefox'] as string)).review).toBe('pending');

    // Again: nothing waits, nothing changes.
    expect((await reviewGroup(deps, buildId, groupId, 'approve', 'usr_2')).changed).toEqual([]);
  });

  test('a group review can be limited to some of its checks (what a filtered page shows)', async () => {
    const [group] = await listGroups(deps, buildId);
    const chromium = Object.entries(ids)
      .filter(([key]) => key.endsWith('/chromium'))
      .map(([, id]) => id);
    const result = await reviewGroup(deps, buildId, group?.id as string, 'approve', 'usr_1', { checkIds: chromium });
    expect(result.changed.sort()).toEqual([...chromium].sort());
    expect(result.group.counts).toEqual({ pending: 3, approved: 4, rejected: 0, outdated: 0 });
    const stranger = await appError(
      reviewGroup(deps, buildId, group?.id as string, 'reject', 'usr_1', {
        checkIds: [ids['pricing/firefox'] as string],
      }),
    );
    expect(stranger).toMatchObject({ status: 422, code: 'check_not_in_group' });
  });

  test('undo takes back exactly what the group review changed, all or nothing', async () => {
    const [group] = await listGroups(deps, buildId);
    const groupId = group?.id as string;
    await approveCheck(deps, ids['home/chromium'] as string, 'usr_1');
    const { changed } = await reviewGroup(deps, buildId, groupId, 'reject', 'usr_2');
    expect(changed).toHaveLength(6);

    const undone = await resetGroup(deps, buildId, groupId, 'usr_2', { checkIds: changed });
    expect(undone.changed.sort()).toEqual([...changed].sort());
    expect(undone.group.counts).toEqual({ pending: 6, approved: 1, rejected: 0, outdated: 0 });
    for (const id of changed) expect((await listReviews(deps, id))[0]?.action).toBe('reset');

    const stranger = await appError(
      resetGroup(deps, buildId, groupId, 'usr_2', { checkIds: [ids['pricing/firefox'] as string] }),
    );
    expect(stranger).toMatchObject({ status: 422, code: 'check_not_in_group' });

    // A later build compared with home/chromium's new baseline: its approval cannot be undone, and
    // so the group's undo changes nothing.
    await reviewGroup(deps, buildId, groupId, 'approve', 'usr_2');
    const later = await openBuild(deps);
    await submit(deps, later, screen(BODIES.home as FilledRect[], 60), {
      name: 'home',
      variant: { browser: 'chromium' },
    });
    const blocked = await appError(resetGroup(deps, buildId, groupId, 'usr_2'));
    expect(blocked.code).toBe('review_not_resettable');
    expect((await getGroup(deps, buildId, groupId)).counts.approved).toBe(7);
  });

  test('outdated checks of a group are skipped: a newer build already approved their screen', async () => {
    const [group] = await listGroups(deps, buildId);
    const newer = await openBuild(deps);
    const { check } = await submit(deps, newer, screen(BODIES.cart as FilledRect[], 60), {
      name: 'cart',
      variant: { browser: 'chromium' },
    });
    await approveCheck(deps, check.id, 'usr_1');

    const result = await reviewGroup(deps, buildId, group?.id as string, 'approve', 'usr_2');
    expect(result.changed).toHaveLength(6);
    expect(result.skipped).toEqual([{ checkId: ids['cart/chromium'] as string, review: 'outdated' }]);
  });
});
