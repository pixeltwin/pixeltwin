import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { Project } from '../../src/db/schema';
import { getCheck } from '../../src/domain/checks';
import { createProject } from '../../src/domain/projects';
import { listReviews, rejectCheck } from '../../src/domain/reviews';
import type * as Reasons from '../../src/ui/client/reasons';
import type { PopoverKey } from '../../src/ui/client/reasons';
import { createTestApp, type TestApp } from '../helpers/app';
import { clientModule } from '../helpers/client';
import { BLACK, makePng, WHITE } from '../helpers/png';
import { openBuild, seedBaseline, submit } from '../helpers/scenario';
import { html, location, postForm } from '../helpers/ui';

const { popoverAction } = await clientModule<typeof Reasons>('reasons');

const page = (logo: number, x: number) =>
  makePng(160, 100, WHITE, [
    { x: 8, y: 4, width: logo, height: 8, color: BLACK },
    { x, y: 50, width: 20, height: 20, color: BLACK },
  ]);
const NAMES = ['home', 'cart', 'account'];

describe('reject popover keys', () => {
  const key = (k: string, extra: Partial<PopoverKey> = {}): PopoverKey => ({
    key: k,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    inComment: false,
    onButton: false,
    ...extra,
  });

  test('1–7 pick a category, Enter rejects, Esc cancels', () => {
    for (let i = 1; i <= 7; i++) expect(popoverAction(key(String(i)))).toEqual({ kind: 'pick', index: i - 1 });
    expect(popoverAction(key('8'))).toEqual({ kind: 'keep' });
    expect(popoverAction(key('Enter'))).toEqual({ kind: 'submit' });
    expect(popoverAction(key('Enter', { inComment: true }))).toEqual({ kind: 'submit' });
    expect(popoverAction(key('Escape'))).toEqual({ kind: 'cancel' });
    expect(popoverAction(key('Escape', { inComment: true }))).toEqual({ kind: 'cancel' });
  });

  test('in the comment digits are text; a letter outside it starts the comment; buttons keep Enter', () => {
    expect(popoverAction(key('3', { inComment: true }))).toEqual({ kind: 'keep' });
    expect(popoverAction(key('b'))).toEqual({ kind: 'comment' });
    expect(popoverAction(key('R'))).toEqual({ kind: 'comment' });
    expect(popoverAction(key('Enter', { onButton: true }))).toEqual({ kind: 'keep' });
    expect(popoverAction(key('Tab'))).toEqual({ kind: 'keep' });
    expect(popoverAction(key('1', { metaKey: true }))).toEqual({ kind: 'keep' });
  });
});

describe('UI reject reasons', () => {
  let t: TestApp;
  let project: Project;
  let reviewer: { cookie: string; id: string };
  let buildId: string;
  const ids: Record<string, string> = {};

  beforeEach(async () => {
    t = await createTestApp();
    project = await createProject(t.deps, { slug: 'web', name: 'Web shop' });
    reviewer = await t.userAs('reviewer');
    for (const [i, name] of NAMES.entries()) await seedBaseline(t.deps, project, page(30, 20 + i * 40), { name });
    buildId = await openBuild(t.deps);
    for (const [i, name] of NAMES.entries())
      ids[name] = (await submit(t.deps, buildId, page(50, 20 + i * 40), { name })).check.id;
  });

  afterEach(async () => {
    await t.close();
  });

  const get = async (path: string) => html(await t.request('GET', path, { as: reviewer }));

  test('Reject opens a popover with the seven categories, their keys and a comment', async () => {
    const body = await get(`/ui/checks/${ids.home}?filter=pending`);
    expect(body).toContain('<details class="reject-menu up" data-reject-menu="true">');
    expect(body).toMatch(/<summary class="button reject"[^>]*data-key="r"/);
    expect(body).toContain(`<form class="reject-popover" method="post" action="/ui/checks/${ids.home}/reject"`);
    const chips = [...body.matchAll(/<input type="radio" name="reasonCode" value="([a-z_]+)"\/><kbd>(\d)<\/kbd>/g)];
    expect(chips.map((m) => [m[1], m[2]])).toEqual([
      ['not_loaded', '1'],
      ['late_asset', '2'],
      ['animation', '3'],
      ['dynamic_data', '4'],
      ['environment', '5'],
      ['real_bug', '6'],
      ['other', '7'],
    ]);
    expect(body).toContain('name="reason"');
    expect(body).toContain('data-key-label="Reject, with a reason (Shift+R: without)"');
  });

  test('without JavaScript the form posts the category and the comment', async () => {
    const res = await postForm(
      t,
      `/ui/checks/${ids.home}/reject`,
      { filter: 'pending', reasonCode: 'late_asset', reason: 'The hero banner was blank' },
      reviewer,
    );
    expect(res.status).toBe(303);
    expect(location(res)).toContain('done=rejected');
    expect(await getCheck(t.deps, ids.home as string)).toMatchObject({
      review: 'rejected',
      reviewReasonCode: 'late_asset',
      reviewComment: 'The hero banner was blank',
    });
    // Nothing picked: a rejection without a reason, as before.
    await postForm(t, `/ui/checks/${ids.cart}/reject`, { filter: 'pending', reason: '' }, reviewer);
    expect((await getCheck(t.deps, ids.cart as string)).reviewReasonCode).toBeNull();
  });

  test('the history shows the category as a tag beside the comment', async () => {
    await rejectCheck(t.deps, ids.home as string, reviewer.id, { reasonCode: 'not_loaded', reason: 'Spinner' });
    const body = await get(`/ui/checks/${ids.home}`);
    expect(body).toContain(
      '<span class="reason-tag reason-not_loaded" title="The page or its content had not finished loading">Not loaded</span>',
    );
    expect(body).toContain('<span class="comment">“Spinner”</span>');
  });

  test('Reject all on a group card asks why too, and the reason goes on every member', async () => {
    const body = await get(`/ui/builds/${buildId}`);
    const groupId = (await getCheck(t.deps, ids.home as string)).groupId as string;
    expect(body).toMatch(
      new RegExp(
        `<form class="reject-popover group-action" method="post" action="/ui/builds/${buildId}/groups/${groupId}/reject"[^>]*data-inplace="/builds/${buildId}/groups/${groupId}/reject"`,
      ),
    );
    const res = await postForm(
      t,
      `/ui/builds/${buildId}/groups/${groupId}/reject`,
      { filter: 'all', back: 'build', reasonCode: 'animation', reason: 'Logo mid-fade', checkIds: Object.values(ids) },
      reviewer,
    );
    expect(res.status).toBe(303);
    for (const id of Object.values(ids)) {
      expect((await listReviews(t.deps, id))[0]).toMatchObject({ reasonCode: 'animation', comment: 'Logo mid-fade' });
    }
  });

  test("a rejected check's card tells why on hover", async () => {
    // A check on its own: cart gets a change of its own.
    const other = await openBuild(t.deps);
    const lone = (await submit(t.deps, other, page(30, 100), { name: 'cart' })).check;
    await rejectCheck(t.deps, lone.id, reviewer.id, { reasonCode: 'dynamic_data', reason: 'Price changed' });
    const body = await get(`/ui/builds/${other}?filter=all`);
    expect(body).toContain('title="changed · rejected: Dates, prices or random content · “Price changed”"');
    expect(body).toContain('<span class="card-reason"');
    expect(body).toContain('dynamic data</span>');
  });
});
