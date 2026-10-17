// `pixeltwin mcp` spawned as an agent would, spoken to in JSON-RPC over stdio, against a real server.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { type ChildProcess, spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { type PageElement, PixeltwinClient } from '@pixeltwin/client';
import { decodePng } from '../../packages/client/src/png-image';
import { makePng, WHITE } from '../helpers/png';
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

const tool = async (name: string, args: Record<string, unknown>) => {
  const { result, error } = await mcp.call('tools/call', { name, arguments: args });
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
    const [item] = lastJson(listed);
    expect(item).toMatchObject({ checkId: changed.id, name: 'login', result: 'changed', review: 'pending' });
    expect(item.summary).toContain('`button[data-testid=submit]` moved 8 px down');
    expect(item.changes.map((c: { description: string }) => c.description)).toEqual([
      'heading text changed from "Sign in" to "Log in"',
      '`button[data-testid=submit]` moved 8 px down',
    ]);

    const detail = lastJson(await tool('get_check', { checkId: changed.id }));
    expect(detail).toMatchObject({ checkId: changed.id, elementCount: 2, review: 'pending' });
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
