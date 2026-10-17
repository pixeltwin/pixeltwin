import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  type Check,
  cssBoxToPixels,
  PixeltwinClient,
  PixeltwinError,
  PixeltwinNetworkError,
  pngSize,
  postWithRetakes,
  toPixelRect,
} from '@pixeltwin/client';
import { makePng, WHITE } from '../helpers/png';
import { startServer, type TestServer } from './server';

let server: TestServer;
let client: PixeltwinClient;

beforeAll(async () => {
  server = await startServer('client');
  client = new PixeltwinClient({ url: server.url, token: server.token, retryDelayMs: 10 });
}, 60_000);

afterAll(async () => {
  await server?.stop();
});

const RED: [number, number, number, number] = [220, 30, 30, 255];
const page = (button = [0, 112, 243, 255] as [number, number, number, number]) =>
  makePng(200, 100, WHITE, [{ x: 20, y: 60, width: 60, height: 20, color: button }]);

describe('PixeltwinClient against a real server', () => {
  test('opening with the same externalId returns the same build', async () => {
    const first = await client.openBuild('client', { branch: 'main', externalId: 'ci-1' });
    const again = await client.openBuild('client', { branch: 'main', externalId: 'ci-1' });
    expect(first.created).toBe(true);
    expect(again.created).toBe(false);
    expect(again.id).toBe(first.id);
    expect(first.state).toBe('open');
    expect(first.verdict).toBe('empty');
  });

  test('without an externalId, one is generated so retries stay idempotent', async () => {
    const build = await client.openBuild('client', { branch: 'main' });
    expect(build.externalId).toMatch(/^sdk-/);
  });

  test('new → approve → unchanged → changed, and variants keep their own baselines', async () => {
    const one = await client.openBuild('client', { branch: 'main', commitSha: 'abc123' });
    expect(one.commitSha).toBe('abc123');
    const fresh = await client.postCheck(one.id, { name: 'home', variant: { browser: 'chromium' }, image: page() });
    expect(fresh.result).toBe('new');
    expect(fresh.review).toBe('pending');
    expect(client.checkUrl(fresh)).toBe(`${server.url}/ui/checks/${fresh.id}`);
    expect((await client.finalize(one.id)).verdict).toBe('pending');
    expect(await client.approveBuild(one.id)).toEqual({ approved: 1, suggested: 0 });
    expect((await client.getBuild(one.id)).verdict).toBe('passed');

    const two = await client.openBuild('client', { branch: 'main' });
    const same = await client.postCheck(two.id, { name: 'home', variant: { browser: 'chromium' }, image: page() });
    expect(same.result).toBe('unchanged');
    const changed = await client.postCheck(two.id, {
      name: 'home',
      variant: { browser: 'chromium' },
      image: page(RED),
    });
    expect(changed.result).toBe('changed'); // replaced the unchanged one in the same build
    expect(changed.diff && 'summary' in changed.diff ? changed.diff.summary : '').not.toBe('');
    const otherVariant = await client.postCheck(two.id, {
      name: 'home',
      variant: { browser: 'firefox' },
      image: page(),
    });
    expect(otherVariant.result).toBe('new');
    const build = await client.finalize(two.id);
    expect(build.counts.total).toBe(2);
    expect(build.counts.result.changed).toBe(1);
    expect(build.verdict).toBe('pending');
    const pending = await client.listChecks(two.id, { review: 'pending' });
    expect(pending.items.map((c) => c.variant.browser).sort()).toEqual(['chromium', 'firefox']);
  });

  test('ignore regions hide a change and are rounded to whole pixels', async () => {
    const base = await client.openBuild('client', { branch: 'main' });
    await client.postCheck(base.id, { name: 'clock', image: page() });
    await client.approveBuild(base.id);
    await client.finalize(base.id);

    const next = await client.openBuild('client', { branch: 'main' });
    const check = await client.postCheck(next.id, {
      name: 'clock',
      image: page(RED),
      ignoreRegions: [
        { x: 19.5, y: 59.2, width: 61, height: 21 },
        { x: 0, y: 0, width: 0.2, height: 0 },
      ],
    });
    expect(check.result).toBe('unchanged');
    expect(check.ignoreRegions).toEqual([{ x: 19, y: 59, width: 62, height: 22 }]);
  });

  test('finalize is idempotent; posting afterwards is a build_finalized PixeltwinError', async () => {
    const build = await client.openBuild('client', { branch: 'main' });
    await client.postCheck(build.id, { name: 'late', image: page() });
    const first = await client.finalize(build.id);
    const second = await client.finalize(build.id);
    expect(second.finalizedAt).toBe(first.finalizedAt);
    const err = await client.postCheck(build.id, { name: 'late', image: page() }).catch((e) => e);
    expect(err).toBeInstanceOf(PixeltwinError);
    expect(err.code).toBe('build_finalized');
    expect(err.status).toBe(409);
    expect(err.requestId).toBeString();
    expect(err.message).toContain('build_finalized');
  });

  test('field errors and a bad token come back typed', async () => {
    const build = await client.openBuild('client', { branch: 'main' });
    const invalid = await client
      .postCheck(build.id, { name: 'x'.repeat(201), image: page() })
      .catch((e: PixeltwinError) => e);
    expect(invalid).toBeInstanceOf(PixeltwinError);
    expect((invalid as PixeltwinError).code).toBe('validation_failed');
    expect((invalid as PixeltwinError).errors[0]?.path).toBe('name');

    const notPng = await client
      .postCheck(build.id, { name: 'garbage', image: new Uint8Array([1, 2, 3]) })
      .catch((e: PixeltwinError) => e);
    expect((notPng as PixeltwinError).code).toBe('invalid_image');

    const stranger = new PixeltwinClient({ url: server.url, token: 'pt_wrong', retries: 0 });
    const denied = await stranger.getBuild(build.id).catch((e: PixeltwinError) => e);
    expect((denied as PixeltwinError).status).toBe(401);
  });

  test('waitForVerdict returns once a review settles a pending build', async () => {
    const build = await client.openBuild('client', { branch: 'review-me' });
    await client.postCheck(build.id, { name: 'wait', image: page() });
    await client.finalize(build.id);
    setTimeout(() => void client.approveBuild(build.id), 150);
    const settled = await client.waitForVerdict(build.id, { timeoutMs: 5000, intervalMs: 50 });
    expect(settled.verdict).toBe('passed');
    const timedOut = await client.openBuild('client', { branch: 'review-me' });
    await client.postCheck(timedOut.id, { name: 'wait-2', image: page() });
    await client.finalize(timedOut.id);
    const start = Date.now();
    expect((await client.waitForVerdict(timedOut.id, { timeoutMs: 200, intervalMs: 50 })).verdict).toBe('pending');
    expect(Date.now() - start).toBeLessThan(2000);
  });

  test('a server that is down is a PixeltwinNetworkError after the retries', async () => {
    const down = new PixeltwinClient({ url: 'http://127.0.0.1:19', token: 'pt_x', retries: 2, retryDelayMs: 1 });
    const err = await down.getBuild('bld_x').catch((e) => e);
    expect(err).toBeInstanceOf(PixeltwinNetworkError);
    expect(err.message).toContain('3 attempt(s)');
  });
});

/** A fetch that answers from a script and records the calls. */
function scripted(responses: (() => Response | Promise<Response>)[]) {
  const calls: { url: string; init: RequestInit | undefined; at: number }[] = [];
  const fake = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init, at: Date.now() });
    const next = responses[Math.min(calls.length - 1, responses.length - 1)];
    if (!next) throw new Error('no response scripted');
    return next();
  }) as typeof fetch;
  return { fake, calls };
}

const problem =
  (status: number, code: string, headers: Record<string, string> = {}) =>
  () =>
    new Response(JSON.stringify({ type: 'about:blank', status, code, detail: `a ${code}`, requestId: 'req_1' }), {
      status,
      headers: { 'content-type': 'application/problem+json', ...headers },
    });
const ok = (body: unknown) => () => new Response(JSON.stringify(body), { status: 200 });

describe('retries', () => {
  test('5xx and network errors are retried; the body is sent again each time', async () => {
    const { fake, calls } = scripted([
      problem(503, 'unavailable'),
      () => {
        throw new TypeError('fetch failed');
      },
      ok({ id: 'bld_1', state: 'open' }),
    ]);
    const c = new PixeltwinClient({ url: 'http://x/', token: 'pt_t', fetch: fake, retryDelayMs: 1 });
    const build = await c.openBuild('web', { externalId: 'e1' });
    expect(build.id).toBe('bld_1');
    expect(calls).toHaveLength(3);
    expect(calls[0]?.url).toBe('http://x/api/v1/projects/web/builds');
    for (const call of calls) expect(JSON.parse(String(call.init?.body)).externalId).toBe('e1');
    const headers = (calls[0]?.init?.headers ?? {}) as Record<string, string>;
    expect(headers.authorization).toBe('Bearer pt_t');
    expect(headers['user-agent']).toStartWith('pixeltwin-js/');
  });

  test('429 waits for Retry-After', async () => {
    const { fake, calls } = scripted([problem(429, 'rate_limited', { 'retry-after': '1' }), ok({ id: 'bld_2' })]);
    const c = new PixeltwinClient({ url: 'http://x', token: 'pt_t', fetch: fake, retryDelayMs: 1 });
    await c.getBuild('bld_2');
    expect(calls).toHaveLength(2);
    expect((calls[1]?.at ?? 0) - (calls[0]?.at ?? 0)).toBeGreaterThanOrEqual(900);
  });

  test('other 4xx are not retried', async () => {
    const { fake, calls } = scripted([problem(404, 'build_not_found')]);
    const c = new PixeltwinClient({ url: 'http://x', token: 'pt_t', fetch: fake, retryDelayMs: 1 });
    const err = await c.getBuild('bld_404').catch((e) => e);
    expect(err).toBeInstanceOf(PixeltwinError);
    expect(err.code).toBe('build_not_found');
    expect(err.requestId).toBe('req_1');
    expect(calls).toHaveLength(1);
  });

  test('a 5xx that stays is the server error after every attempt', async () => {
    const { fake, calls } = scripted([() => new Response('<html>Bad gateway</html>', { status: 502 })]);
    const c = new PixeltwinClient({ url: 'http://x', token: 'pt_t', fetch: fake, retries: 2, retryDelayMs: 1 });
    const err = await c.finalize('bld_1').catch((e) => e);
    expect(err).toBeInstanceOf(PixeltwinError);
    expect(err.code).toBe('http_502');
    expect(err.detail).toContain('Bad gateway');
    expect(calls).toHaveLength(3);
  });

  test('a timeout counts as a network error', async () => {
    const hang = ((_: unknown, init?: RequestInit) =>
      new Promise((_, fail) =>
        init?.signal?.addEventListener('abort', () => fail(init.signal?.reason)),
      )) as typeof fetch;
    const c = new PixeltwinClient({
      url: 'http://x',
      token: 'pt_t',
      fetch: hang,
      retries: 1,
      timeoutMs: 20,
      retryDelayMs: 1,
    });
    const err = await c.getBuild('bld_1').catch((e) => e);
    expect(err).toBeInstanceOf(PixeltwinNetworkError);
    expect(err.message).toContain('2 attempt(s)');
  });
});

describe('postWithRetakes', () => {
  const check = (result: Check['result']) => ({ result }) as Check;
  const noWait = async () => {};

  test('retakes while changed, up to the count, and stops at the first other result', async () => {
    const results: Check['result'][] = ['changed', 'changed', 'unchanged', 'changed'];
    let posts = 0;
    const seen: number[] = [];
    const final = await postWithRetakes(async () => check(results[posts++] ?? 'changed'), {
      retakes: 5,
      intervalMs: 1,
      sleep: noWait,
      onRetake: (_c, n) => seen.push(n),
    });
    expect(final.result).toBe('unchanged');
    expect(posts).toBe(3);
    expect(seen).toEqual([1, 2]);
  });

  test('new and error are final; the count and the deadline end the retakes', async () => {
    for (const result of ['new', 'error'] as const) {
      let posts = 0;
      const once = async () => {
        posts++;
        return check(result);
      };
      await postWithRetakes(once, { retakes: 3, intervalMs: 1, sleep: noWait });
      expect(posts).toBe(1);
    }
    let posts = 0;
    const always = async () => {
      posts++;
      return check('changed');
    };
    expect((await postWithRetakes(always, { retakes: 2, intervalMs: 1, sleep: noWait })).result).toBe('changed');
    expect(posts).toBe(3);
    posts = 0;
    await postWithRetakes(always, { retakes: 5, intervalMs: 1000, deadline: Date.now() + 500, sleep: noWait });
    expect(posts).toBe(1);
  });
});

describe('helpers', () => {
  test('pngSize reads the header', () => {
    expect(pngSize(makePng(31, 17))).toEqual({ width: 31, height: 17 });
    expect(pngSize(new Uint8Array(30))).toBeNull();
  });

  test('toPixelRect rounds outwards and clips to the image', () => {
    expect(toPixelRect({ x: 1.5, y: 2.5, width: 3, height: 3 })).toEqual({ x: 1, y: 2, width: 4, height: 4 });
    expect(toPixelRect({ x: -10, y: 90, width: 30, height: 30 }, { width: 100, height: 100 })).toEqual({
      x: 0,
      y: 90,
      width: 20,
      height: 10,
    });
    expect(toPixelRect({ x: 120, y: 0, width: 10, height: 10 }, { width: 100, height: 100 })).toBeNull();
  });

  test('cssBoxToPixels snaps to whole CSS pixels before scaling, then rounds outwards', () => {
    // Measured in Chromium at a device pixel ratio of 2.625: a box at x 50.6875, 150 wide paints
    // device columns 133 to 527 (its edges snapped to CSS pixels 51 and 201: 527.625). Scaling the
    // exact box gives 133.05 to 526.8, i.e. columns 133–526, and column 527 was compared.
    const box = { x: 50.6875, y: 1392.796875, width: 150, height: 22.390625 };
    const region = cssBoxToPixels(box, { origin: { x: 0, y: 0 }, scale: 2.625 });
    expect(region).toEqual({ x: 131, y: 3654, width: 397, height: 63 });
    expect((region?.x ?? 0) + (region?.width ?? 0)).toBeGreaterThanOrEqual(Math.ceil(201 * 2.625));
    // Origin (scroll, element) and separate x/y scales; clipped to the image; empty boxes dropped.
    expect(cssBoxToPixels({ x: 10, y: -290, width: 20, height: 10 }, { origin: { x: 0, y: -300 }, scale: 2 })).toEqual({
      x: 20,
      y: 20,
      width: 40,
      height: 20,
    });
    expect(
      cssBoxToPixels({ x: 0, y: 0, width: 10, height: 10 }, { origin: { x: 0, y: 0 }, scale: { x: 1, y: 3 } }),
    ).toEqual({ x: 0, y: 0, width: 10, height: 30 });
    expect(cssBoxToPixels(box, { origin: { x: 0, y: 0 }, scale: 1 }, { width: 100, height: 2000 })).toEqual({
      x: 50,
      y: 1392,
      width: 50,
      height: 24,
    });
    expect(cssBoxToPixels({ x: 1, y: 1, width: 0, height: 5 }, { origin: { x: 0, y: 0 }, scale: 1 })).toBeNull();
  });

  test('the constructor wants a url and a token', () => {
    expect(() => new PixeltwinClient({ url: '', token: 'x' })).toThrow('url');
    expect(() => new PixeltwinClient({ url: 'http://x', token: '' })).toThrow('token');
  });
});
