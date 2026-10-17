// `pixeltwin mcp` spawned as an agent would, spoken to in JSON-RPC over stdio, against a real server.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { type ChildProcess, spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { type PageElement, PixeltwinClient } from '@pixeltwin/client';
import { decodePng } from '../../packages/client/src/png-image';
import { BLACK, makePng, WHITE } from '../helpers/png';
import { REPO, startServer, type TestServer } from './server';

const BLUE = [0, 112, 243, 255] as [number, number, number, number];
const page = (y: number, title = BLUE) =>
  makePng(400, 300, WHITE, [
    { x: 40, y, width: 120, height: 40, color: BLUE },
    { x: 40, y: 200, width: 200, height: 30, color: title },
  ]);
const elements = (y: number, title: string): PageElement[] => [
  { key: '[data-testid=submit]', tag: 'button', role: 'button', x: 40, y, width: 120, height: 40 },
  {
    key: `role=heading[name="${title}"]`,
    path: 'main > h1',
    tag: 'h1',
    role: 'heading',
    text: title,
    x: 40,
    y: 200,
    width: 200,
    height: 30,
  },
];

// biome-ignore lint/suspicious/noExplicitAny: JSON-RPC answers from the child process; the assertions check them.
type Answer = any;

interface Rpc {
  call(method: string, params?: unknown): Promise<{ result?: Answer; error?: { code: number; message: string } }>;
  send(raw: string): void;
  next(): Promise<Answer>;
  stop(): Promise<void>;
}

function startMcp(env: Record<string, string>): Rpc {
  const child: ChildProcess = spawn(process.execPath, ['packages/client/src/bin.ts', 'mcp'], {
    cwd: REPO,
    env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const waiting = new Map<number | string, (message: Answer) => void>();
  const unnamed: Answer[] = [];
  const unnamedWaiters: Array<(m: Answer) => void> = [];
  if (!child.stdout) throw new Error('no stdout');
  createInterface({ input: child.stdout }).on('line', (line) => {
    const message = JSON.parse(line);
    const done = message.id !== null && message.id !== undefined ? waiting.get(message.id) : undefined;
    if (done) {
      waiting.delete(message.id);
      done(message);
    } else {
      const waiter = unnamedWaiters.shift();
      if (waiter) waiter(message);
      else unnamed.push(message);
    }
  });
  let id = 0;
  const exited = new Promise((resolve) => child.once('exit', resolve));
  return {
    call(method, params) {
      id += 1;
      const current = id;
      child.stdin?.write(`${JSON.stringify({ jsonrpc: '2.0', id: current, method, params })}\n`);
      return new Promise((resolve) => waiting.set(current, resolve));
    },
    send(raw) {
      child.stdin?.write(`${raw}\n`);
    },
    next() {
      const ready = unnamed.shift();
      return ready ? Promise.resolve(ready) : new Promise((resolve) => unnamedWaiters.push(resolve));
    },
    async stop() {
      child.stdin?.end();
      await exited;
    },
  };
}

let server: TestServer;
let client: PixeltwinClient;
let mcp: Rpc;

const tool = async (name: string, args: Record<string, unknown>, rpc: Rpc = mcp) => {
  const { result, error } = await rpc.call('tools/call', { name, arguments: args });
  if (error) throw new Error(error.message);
  return result as {
    content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
    isError?: boolean;
  };
};
const texts = (r: Awaited<ReturnType<typeof tool>>) =>
  r.content.filter((c) => c.type === 'text').map((c) => c.text ?? '');
const lastJson = (r: Awaited<ReturnType<typeof tool>>) => JSON.parse(texts(r).at(-1) ?? 'null');

async function changedBuild(name: string) {
  const one = await client.openBuild('mcp', { branch: 'main' });
  const base = await client.postCheck(one.id, { name, image: page(40), elements: elements(40, 'Sign in') });
  // A person approves the baseline (under an agent review policy a token would only suggest it).
  const approved = await fetch(`${server.url}/api/v1/builds/${one.id}/approve`, {
    method: 'POST',
    headers: { cookie: server.cookie, origin: server.url },
  });
  expect(approved.status).toBe(200);
  const two = await client.openBuild('mcp', { branch: 'main' });
  const changed = await client.postCheck(two.id, {
    name,
    image: page(48, [34, 34, 34, 255]),
    elements: elements(48, 'Log in'),
  });
  return { base, changed, buildId: two.id };
}

const GRAY = [120, 120, 120, 255] as [number, number, number, number];
/** A page with a header (a gray bar and a logo `logo` px wide); pages differ in height only. */
const headerPage = (logo: number, height: number) =>
  makePng(120, height, WHITE, [
    { x: 0, y: 0, width: 120, height: 16, color: GRAY },
    { x: 8, y: 4, width: logo, height: 8, color: BLACK },
  ]);
const headerElements = (logo: number): PageElement[] => [
  { key: '[data-testid=logo]', tag: 'img', role: 'img', x: 8, y: 4, width: logo, height: 8 },
];
/** Three screens of 120×100, 120×200 and 120×400: the same header change is 1.33 %, 0.67 % and 0.33 % of each. */
const SCREENS = [
  ['home', 100],
  ['pricing', 200],
  ['docs', 400],
] as const;
const clock = (ticked: boolean) =>
  makePng(120, 80, WHITE, ticked ? [{ x: 90, y: 4, width: 20, height: 8, color: BLACK }] : []);

beforeAll(async () => {
  server = await startServer('mcp');
  client = new PixeltwinClient({ url: server.url, token: server.token });
  mcp = startMcp({ PIXELTWIN_URL: server.url, PIXELTWIN_TOKEN: server.token, PIXELTWIN_PROJECT: 'mcp' });
}, 60_000);

afterAll(async () => {
  await mcp?.stop();
  await server?.stop();
});

describe('pixeltwin mcp', () => {
  test('initialize, list the tools, and answer what it does not know', async () => {
    const init = await mcp.call('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'test', version: '1' },
    });
    expect(init.result).toMatchObject({
      protocolVersion: '2025-06-18',
      capabilities: { tools: {} },
      serverInfo: { name: 'pixeltwin' },
    });
    expect(init.result.instructions).toContain('approve_check');
    expect(init.result.instructions).toContain('review_group');
    expect(init.result.instructions).toContain('rejection_patterns');
    expect(init.result.instructions).toContain('not_loaded or late_asset');
    mcp.send(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }));
    expect((await mcp.call('ping')).result).toEqual({});

    const { result } = await mcp.call('tools/list');
    const names = result.tools.map((t: { name: string }) => t.name);
    expect(names).toEqual([
      'latest_build',
      'list_changes',
      'get_check',
      'get_check_images',
      'approve_check',
      'reject_check',
      'review_group',
      'rejection_patterns',
      'add_ignore_area',
    ]);
    for (const t of result.tools) {
      expect(t.description.length).toBeGreaterThan(80);
      expect(t.inputSchema.type).toBe('object');
    }

    expect((await mcp.call('resources/list')).error?.code).toBe(-32601);
    mcp.send('{not json');
    expect((await mcp.next()).error?.code).toBe(-32700);
    const older = await mcp.call('initialize', { protocolVersion: '1999-01-01', capabilities: {} });
    expect(older.result.protocolVersion).toBe('2025-06-18');
  });

  test('read the changes element by element, look at a cropped image, approve with a reason', async () => {
    const { changed, buildId } = await changedBuild('login');

    const latest = await tool('latest_build', { branch: 'main' });
    expect(lastJson(latest)).toMatchObject({ id: buildId, verdict: 'pending', counts: { changed: 1 } });

    const listed = await tool('list_changes', { branch: 'main' });
    expect(texts(listed)[0]).toContain('verdict pending; 1 changed or new check.');
    const { groups, checks } = lastJson(listed);
    expect(groups).toEqual([]);
    const [item] = checks;
    expect(item).toMatchObject({ checkId: changed.id, name: 'login', result: 'changed', review: 'pending' });
    expect(item.summary).toContain('`button[data-testid=submit]` moved 8 px down');
    expect(item.changes.map((c: { description: string }) => c.description)).toEqual([
      'heading text changed from "Sign in" to "Log in"',
      '`button[data-testid=submit]` moved 8 px down',
    ]);

    const detail = lastJson(await tool('get_check', { checkId: changed.id }));
    expect(detail).toMatchObject({ checkId: changed.id, elementCount: 2, review: 'pending', group: null, flaky: null });
    expect(detail.links.review).toBe(`${server.url}/ui/checks/${changed.id}`);
    expect(detail.history).toEqual([]);

    const images = await tool('get_check_images', { checkId: changed.id, change: 1, padding: 10 });
    const pictures = images.content.filter((c) => c.type === 'image');
    expect(pictures).toHaveLength(3);
    expect(texts(images)[0]).toBe('baseline (cropped to x 30, y 30, 140×68):');
    const crop = decodePng(new Uint8Array(Buffer.from(pictures[0]?.data ?? '', 'base64')));
    expect([crop?.width, crop?.height]).toEqual([140, 68]);
    const onlyDiff = await tool('get_check_images', { checkId: changed.id, images: ['diff'] });
    expect(texts(onlyDiff)).toEqual(['diff:']);

    const approved = await tool('approve_check', {
      checkId: changed.id,
      reason: 'I moved the button down and renamed the heading on purpose.',
    });
    expect(texts(approved)[0]).toStartWith('Applied: the check is approved.');
    const history = await client.listReviews(changed.id);
    expect(history[0]).toMatchObject({
      action: 'approved',
      actorKind: 'token',
      actorName: 'sdk',
      comment: 'I moved the button down and renamed the heading on purpose.',
    });
  }, 60_000);

  test("under a policy the approval is a suggestion, and areas are a person's call", async () => {
    const res = await fetch(`${server.url}/api/v1/projects/mcp`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', cookie: server.cookie, origin: server.url },
      body: JSON.stringify({ agentReview: 'suggest' }),
    });
    expect(res.status).toBe(200);
    const { changed } = await changedBuild('signup');
    const suggested = await tool('approve_check', { checkId: changed.id, reason: 'Intended.' });
    expect(texts(suggested)[0]).toStartWith('Recorded as a suggestion to approve');
    expect(lastJson(suggested)).toMatchObject({ outcome: 'suggested', review: 'pending' });
    expect((await client.getCheck(changed.id)).suggestion?.reason).toBe('Intended.');

    const refused = await tool('add_ignore_area', { checkId: changed.id, change: 0 });
    expect(refused.isError).toBe(true);
    expect(texts(refused)[0]).toContain('cannot change areas');
    const missing = await tool('get_check', { checkId: 'chk_nope' });
    expect(missing.isError).toBe(true);
    expect(texts(missing)[0]).toContain('404');
  }, 60_000);

  test('without configuration the tools say what is missing', async () => {
    const bare = startMcp({});
    try {
      const r = await bare.call('tools/call', { name: 'latest_build', arguments: {} });
      expect(r.result.isError).toBe(true);
      expect(r.result.content[0].text).toContain('PIXELTWIN_TOKEN');
    } finally {
      await bare.stop();
    }
  });
});

describe('pixeltwin mcp with change groups and flaky screens', () => {
  let groups: Rpc;
  let gc: PixeltwinClient;
  let mainBuild: string;
  let clockCheck: string;

  const policy = async (agentReview: string, agentMaxDiffPercent = 1) => {
    const res = await fetch(`${server.url}/api/v1/projects/groups`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', cookie: server.cookie, origin: server.url },
      body: JSON.stringify({ agentReview, agentMaxDiffPercent }),
    });
    expect(res.status).toBe(200);
  };
  /** A build of `branch` where all three screens got a wider logo: one group of three. */
  const headerBuild = async (branch: string) => {
    const build = await gc.openBuild('groups', { branch });
    const ids: Record<string, string> = {};
    for (const [name, height] of SCREENS) {
      ids[name] = (
        await gc.postCheck(build.id, { name, image: headerPage(50, height), elements: headerElements(50) })
      ).id;
    }
    const listed = lastJson(await tool('list_changes', { buildId: build.id }, groups));
    expect(listed.groups).toHaveLength(1);
    return { buildId: build.id, groupId: listed.groups[0].groupId as string, ids };
  };

  beforeAll(async () => {
    const token = await server.newProject('groups');
    gc = new PixeltwinClient({ url: server.url, token });
    groups = startMcp({ PIXELTWIN_URL: server.url, PIXELTWIN_TOKEN: token, PIXELTWIN_PROJECT: 'groups' });
    // Baselines: three screens with a narrow logo and a clock; a person approves them.
    const first = await gc.openBuild('groups', { branch: 'main' });
    for (const [name, height] of SCREENS) {
      await gc.postCheck(first.id, { name, image: headerPage(30, height), elements: headerElements(30) });
    }
    await gc.postCheck(first.id, { name: 'clock', image: clock(false) });
    const approved = await fetch(`${server.url}/api/v1/builds/${first.id}/approve`, {
      method: 'POST',
      headers: { cookie: server.cookie, origin: server.url },
    });
    expect(approved.status).toBe(200);
    // The clock ticks every other run and nobody approves it: a flaky screen.
    for (const ticked of [true, false]) {
      const build = await gc.openBuild('groups', { branch: 'main' });
      await gc.postCheck(build.id, { name: 'clock', image: clock(ticked) });
    }
    const build = await gc.openBuild('groups', { branch: 'main' });
    for (const [name, height] of SCREENS) {
      await gc.postCheck(build.id, { name, image: headerPage(50, height), elements: headerElements(50) });
    }
    clockCheck = (await gc.postCheck(build.id, { name: 'clock', image: clock(true) })).id;
    mainBuild = build.id;
  }, 60_000);

  afterAll(async () => {
    await groups?.stop();
  });

  test('list_changes shows the group once with a representative, and marks the flaky screen', async () => {
    const listed = await tool('list_changes', { buildId: mainBuild }, groups);
    const head = texts(listed)[0];
    expect(head).toContain('4 changed or new checks: 1 change group of 3 checks');
    expect(head).toContain('review_group');
    expect(head).toContain('and 1 on its own. 1 check on flaky screens (flakyScore): likely noise.');
    const { groups: found, checks } = lastJson(listed);
    expect(found).toHaveLength(1);
    const [group] = found;
    expect(group).toMatchObject({ size: 3, review: { pending: 3 } });
    expect(group.members.map((m: { name: string }) => m.name).sort()).toEqual(['docs', 'home', 'pricing']);
    expect(group.moreMembers).toBeUndefined();
    expect(group.representative).toMatchObject({ result: 'changed', review: 'pending' });
    expect(group.representative.summary).toContain('[data-testid=logo]');
    expect(group.representative.changes[0]).toMatchObject({ kind: 'resized', key: '[data-testid=logo]' });
    expect(checks).toHaveLength(1);
    expect(checks[0]).toMatchObject({ checkId: clockCheck, name: 'clock', flakyScore: 0.67 });
    expect(group.members.every((m: { flakyScore?: number }) => m.flakyScore === undefined)).toBe(true);

    const member = lastJson(await tool('get_check', { checkId: group.representative.checkId }, groups));
    expect(member.group).toEqual({ groupId: group.groupId, size: 3 });
    expect(member.flaky).toBeNull();
    const flaky = lastJson(await tool('get_check', { checkId: clockCheck }, groups));
    expect(flaky.group).toBeNull();
    expect(flaky.flaky).toEqual({ score: 0.67, flips: 2, unstableArea: { x: 90, y: 4, width: 20, height: 8 } });
  }, 60_000);

  test('review_group needs a reason, and a reasonCode to reject', async () => {
    const { buildId, groupId } = await headerBuild('no-reason');
    const refused = await tool('review_group', { buildId, groupId, action: 'approve' }, groups);
    expect(refused.isError).toBe(true);
    expect(texts(refused)[0]).toBe('"reason" is required.');
    const blank = await tool('review_group', { buildId, groupId, action: 'approve', reason: '  ' }, groups);
    expect(blank.isError).toBe(true);
    const noCode = await tool('review_group', { buildId, groupId, action: 'reject', reason: 'Broken' }, groups);
    expect(noCode.isError).toBe(true);
    expect(texts(noCode)[0]).toStartWith('"reasonCode" is required to reject');
  }, 60_000);

  test('under "suggest" the group review is a suggestion for every member', async () => {
    await policy('suggest');
    try {
      const { buildId, groupId, ids } = await headerBuild('suggest');
      const r = await tool('review_group', { buildId, groupId, action: 'approve', reason: 'New logo.' }, groups);
      expect(texts(r)[0]).toStartWith(
        "Recorded as a suggestion to approve for 3 checks: this project has a person decide on agents' reviews.",
      );
      expect(texts(r)[0]).toContain("The build's verdict is now pending.");
      expect(lastJson(r)).toMatchObject({ applied: [], skipped: [], verdict: 'pending' });
      expect(lastJson(r).suggested.sort()).toEqual(Object.values(ids).sort());
      expect((await gc.getCheck(ids.home as string)).suggestion?.reason).toBe('New logo.');
    } finally {
      await policy('off');
    }
  }, 60_000);

  test('under "auto-below" small diffs apply and the larger one becomes a suggestion', async () => {
    await policy('auto-below', 1);
    try {
      const { buildId, groupId, ids } = await headerBuild('auto');
      const r = await tool('review_group', { buildId, groupId, action: 'approve', reason: 'New logo.' }, groups);
      expect(texts(r)[0]).toStartWith('Applied: 2 checks approved. Recorded as a suggestion to approve for 1 check');
      expect(texts(r)[0]).toContain('It stays pending until someone accepts or dismisses it at');
      // home: 1.33 % of its pixels, above the limit; pricing and docs below it.
      expect(lastJson(r).suggested).toEqual([ids.home]);
      expect(lastJson(r).applied.sort()).toEqual([ids.pricing, ids.docs].sort());
    } finally {
      await policy('off');
    }
  }, 60_000);

  test('with the policy off the review applies; a subset first, then the rest', async () => {
    const listed = lastJson(await tool('list_changes', { buildId: mainBuild }, groups));
    const { groupId, members } = listed.groups[0];
    const first = members[0].checkId as string;
    const one = await tool(
      'review_group',
      { buildId: mainBuild, groupId, action: 'approve', reason: 'The wider logo is the new brand.', checkIds: [first] },
      groups,
    );
    expect(texts(one)[0]).toBe(
      "Applied: 1 check approved. 2 other members not in checkIds left as they were. The build's verdict is now pending.",
    );
    expect(lastJson(one)).toMatchObject({ groupId, applied: [first], suggested: [], skipped: [] });
    const after = lastJson(await tool('list_changes', { buildId: mainBuild }, groups)).groups[0];
    expect(after.review).toEqual({ pending: 2, approved: 1 });
    expect(after.members.find((m: { checkId: string }) => m.checkId === first).review).toBe('approved');
    expect(after.members.filter((m: { review?: string }) => m.review === undefined)).toHaveLength(2);

    const rest = await tool(
      'review_group',
      { buildId: mainBuild, groupId, action: 'approve', reason: 'The wider logo is the new brand.' },
      groups,
    );
    expect(texts(rest)[0]).toStartWith('Applied: 2 checks approved. Skipped 1 check, left as it was (1 approved).');
    expect(lastJson(rest).skipped).toEqual([{ checkId: first, review: 'approved' }]);
    // The flaky clock still waits.
    expect(lastJson(rest).verdict).toBe('pending');
    expect((await gc.listReviews(first))[0]).toMatchObject({
      action: 'approved',
      actorKind: 'token',
      comment: 'The wider logo is the new brand.',
    });
  }, 60_000);
});

describe('pixeltwin mcp and the reasons screens were rejected', () => {
  let rpc: Rpc;
  let rc: PixeltwinClient;

  /** A build on `branch` where `name` changed again (its logo grows by `step` each time). */
  let step = 0;
  const changedAgain = async (name: string, branch = 'main') => {
    step += 1;
    const build = await rc.openBuild('learn', { branch });
    const check = await rc.postCheck(build.id, { name, image: headerPage(30 + step * 4, 100) });
    return { buildId: build.id, checkId: check.id };
  };
  const reject = (checkId: string, reasonCode: string, reason: string) =>
    fetch(`${server.url}/api/v1/checks/${checkId}/reject`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: server.cookie, origin: server.url },
      body: JSON.stringify({ reasonCode, reason }),
    });

  beforeAll(async () => {
    const token = await server.newProject('learn');
    rc = new PixeltwinClient({ url: server.url, token });
    rpc = startMcp({ PIXELTWIN_URL: server.url, PIXELTWIN_TOKEN: token, PIXELTWIN_PROJECT: 'learn' });
    const first = await rc.openBuild('learn', { branch: 'main' });
    for (const name of ['home', 'pricing']) await rc.postCheck(first.id, { name, image: headerPage(30, 100) });
    const approved = await fetch(`${server.url}/api/v1/builds/${first.id}/approve`, {
      method: 'POST',
      headers: { cookie: server.cookie, origin: server.url },
    });
    expect(approved.status).toBe(200);
    // A person rejected "home" three times as not loaded, and "pricing" once for its random prices.
    for (const reason of ['Spinner still showing', 'Hero image blank', 'Still loading']) {
      const { checkId } = await changedAgain('home');
      expect((await reject(checkId, 'not_loaded', reason)).status).toBe(200);
    }
    const prices = await changedAgain('pricing');
    expect((await reject(prices.checkId, 'dynamic_data', 'Prices are random')).status).toBe(200);
  }, 60_000);

  afterAll(async () => {
    await rpc?.stop();
  });

  test("list_changes and get_check carry the screen's recent rejections and a hint", async () => {
    const { buildId, checkId } = await changedAgain('home');
    const listed = await tool('list_changes', { buildId }, rpc);
    expect(texts(listed)[0]).toContain('1 check on screens rejected before');
    const [item] = lastJson(listed).checks;
    expect(item.rejections).toMatchObject({
      count: 3,
      byCategory: { not_loaded: 3 },
      hint: 'Rejected 3× as not_loaded: likely captured before the page finished loading — wait for network idle or for the element before the screenshot.',
    });
    expect(item.rejections.recent).toHaveLength(3);
    expect(item.rejections.recent[0]).toMatchObject({
      reasonCode: 'not_loaded',
      reason: 'Still loading',
      by: expect.stringMatching(/^person \(usr_/),
      build: expect.stringMatching(/^#\d+ on main$/),
    });

    const detail = lastJson(await tool('get_check', { checkId }, rpc));
    expect(detail.rejections.count).toBe(3);
    expect(detail.rejections.recent.map((r: { reason: string }) => r.reason)).toEqual([
      'Still loading',
      'Hero image blank',
      'Spinner still showing',
    ]);
  }, 60_000);

  test('rejection_patterns sums the reasons up by category and by screen', async () => {
    const all = await tool('rejection_patterns', {}, rpc);
    expect(texts(all)[0]).toStartWith(
      '4 rejections on every branch on 2 screens; most often 3× not_loaded, 1× dynamic_data.',
    );
    expect(texts(all)[0]).toContain('home: Rejected 3× as not_loaded');
    expect(texts(all)[0]).toContain('pricing: Rejected 1× as dynamic_data');
    const data = lastJson(all);
    expect(data.categories[0]).toMatchObject({
      code: 'not_loaded',
      count: 3,
      screens: 1,
      act: 'wait for network idle or for the element before the screenshot',
    });
    expect(data.screens.map((sc: { name: string; count: number }) => [sc.name, sc.count])).toEqual([
      ['pricing', 1],
      ['home', 3],
    ]);
    const { checkId } = await changedAgain('pricing');
    const one = lastJson(await tool('rejection_patterns', { checkId }, rpc));
    expect(one.screens.map((sc: { name: string }) => sc.name)).toEqual(['pricing']);
    const none = await tool('rejection_patterns', { branch: 'feature/none' }, rpc);
    expect(texts(none)).toEqual(['No rejections on feature/none.']);
  }, 60_000);

  test('rejecting needs a reasonCode; approving a screen rejected as not loaded warns', async () => {
    const { checkId } = await changedAgain('home');
    const missing = await tool('reject_check', { checkId, reason: 'Looks wrong' }, rpc);
    expect(missing.isError).toBe(true);
    expect(texts(missing)[0]).toStartWith('"reasonCode" is required to reject');
    const wrong = await tool('reject_check', { checkId, reason: 'Looks wrong', reasonCode: 'slow' }, rpc);
    expect(wrong.isError).toBe(true);
    expect((await rc.getCheck(checkId)).review).toBe('pending');

    const approved = await tool('approve_check', { checkId, reason: 'The wider logo is intended.' }, rpc);
    expect(texts(approved)[0]).toStartWith('Applied: the check is approved.');
    expect(texts(approved)[0]).toContain(
      'Careful: this screen was rejected before as captured too early (3× not_loaded); make sure the change is not a loading artefact',
    );

    const next = await changedAgain('pricing');
    const rejected = await tool(
      'reject_check',
      { checkId: next.checkId, reason: 'The price changed again', reasonCode: 'dynamic_data' },
      rpc,
    );
    expect(texts(rejected)[0]).toStartWith('Applied: the check is rejected.');
    expect((await rc.listReviews(next.checkId))[0]).toMatchObject({
      action: 'rejected',
      actorKind: 'token',
      reasonCode: 'dynamic_data',
      comment: 'The price changed again',
    });
  }, 60_000);
});
