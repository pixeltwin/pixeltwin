import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config';
import { openDatabase } from '../src/db/database';
import { createUser } from '../src/domain/auth/users';
import { createLogger, silentLogger } from '../src/log';
import { main } from '../src/main';
import { type RunningServer, startServer } from '../src/server';
import { BLACK, makePng, WHITE } from './helpers/png';

const PASSWORD = 'correct horse battery';

describe('server end to end', () => {
  let dir: string;
  let server: RunningServer | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'pixeltwin-e2e-'));
  });

  afterEach(async () => {
    await server?.stop();
    server = undefined;
    rmSync(dir, { recursive: true, force: true });
  });

  test('setup → login → project → token → build → checks → finalize, with real workers and disk', async () => {
    const config = loadConfig({ DATA_DIR: dir, PORT: '0', PUBLIC_URL: 'http://pixeltwin.local', DIFF_WORKERS: '1' });
    server = await startServer(config, silentLogger);
    const api = `${server.url}/api/v1`;
    const origin = { origin: 'http://pixeltwin.local' };

    expect(await (await fetch(`${server.url}/healthz`)).json()).toMatchObject({ status: 'ok' });
    expect(server.setupToken).toMatch(/^[0-9A-Za-z]{32}$/);

    const setup = await fetch(`${api}/setup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: server.setupToken, email: 'root@example.com', password: PASSWORD }),
    });
    expect(setup.status).toBe(201);

    const login = await fetch(`${api}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'root@example.com', password: PASSWORD }),
    });
    const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
    const asAdmin = { cookie, ...origin, 'content-type': 'application/json' };
    await fetch(`${api}/projects`, {
      method: 'POST',
      headers: asAdmin,
      body: JSON.stringify({ slug: 'web', name: 'Web' }),
    });
    const tokenRes = await fetch(`${api}/projects/web/tokens`, {
      method: 'POST',
      headers: asAdmin,
      body: JSON.stringify({ name: 'CI', scopes: ['read', 'write', 'review'] }),
    });
    const { token } = (await tokenRes.json()) as { token: string };
    const auth = { authorization: `Bearer ${token}` };

    const post = async (buildId: string, png: Uint8Array<ArrayBuffer>) => {
      const form = new FormData();
      form.set('image', new File([png], 'home.png', { type: 'image/png' }));
      form.set('meta', JSON.stringify({ name: 'home', variant: { browser: 'chromium' } }));
      return (await (
        await fetch(`${api}/builds/${buildId}/checks`, { method: 'POST', headers: auth, body: form })
      ).json()) as {
        id: string;
        result: string;
        diff: { regions: unknown[] } | null;
      };
    };
    const openBuild = async () =>
      (
        (await (
          await fetch(`${api}/projects/web/builds`, {
            method: 'POST',
            headers: { ...auth, 'content-type': 'application/json' },
            body: '{}',
          })
        ).json()) as { id: string }
      ).id;

    const first = await openBuild();
    const created = await post(first, makePng(64, 64));
    expect(created.result).toBe('new');
    await fetch(`${api}/checks/${created.id}/approve`, { method: 'POST', headers: auth });

    const second = await openBuild();
    const changed = await post(second, makePng(64, 64, WHITE, [{ x: 8, y: 8, width: 8, height: 8, color: BLACK }]));
    expect(changed.result).toBe('changed');
    expect(changed.diff?.regions).toEqual([
      { x: 8, y: 8, width: 8, height: 8, pixels: 64, fingerprint: expect.any(String) },
    ]);

    const finalized = await fetch(`${api}/builds/${second}/finalize`, { method: 'POST', headers: auth });
    expect(await finalized.json()).toMatchObject({ state: 'finalized', verdict: 'pending' });
    expect(existsSync(join(dir, 'pixeltwin.db'))).toBe(true);
    expect(readdirSync(join(dir, 'images')).length).toBeGreaterThan(0);
  });

  test('stopping lets requests in flight finish instead of cutting them off', async () => {
    const config = loadConfig({ DATA_DIR: dir, PORT: '0', DIFF_WORKERS: '1' });
    const running = await startServer(config, silentLogger);
    const encoder = new TextEncoder();
    let send: ((chunk: string) => void) | undefined;
    let finish: (() => void) | undefined;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        send = (chunk) => controller.enqueue(encoder.encode(chunk));
        finish = () => controller.close();
      },
    });
    const pending = fetch(`${running.url}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: running.url },
      body,
      duplex: 'half',
    } as RequestInit);
    send?.('{"email":"nobody@example.com",');
    await Bun.sleep(100);
    const stopped = running.stop();
    await Bun.sleep(200);
    send?.('"password":"wrong-password-1"}');
    finish?.();
    const res = await pending;
    expect(res.status).toBe(401);
    await stopped;
  });

  test('the startup log says where images live and how many diff workers run', async () => {
    const lines: string[] = [];
    const logger = createLogger('info', (line) => lines.push(line));
    const config = loadConfig({ DATA_DIR: dir, PORT: '0', DIFF_WORKERS: '2' });
    server = await startServer(config, logger);
    const listening = JSON.parse(lines.find((l) => l.includes('"listening"')) ?? '{}');
    expect(listening).toMatchObject({ storage: 'local', diffWorkers: 2, database: 'sqlite' });
  });

  test('a restarted server keeps its data and asks for no setup', async () => {
    const config = loadConfig({ DATA_DIR: dir, PORT: '0', DIFF_WORKERS: '1' });
    server = await startServer(config, silentLogger);
    await fetch(`${server.url}/api/v1/setup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: server.setupToken, email: 'root@example.com', password: PASSWORD }),
    });
    await server.stop();
    server = await startServer(config, silentLogger);
    expect(server.setupToken).toBeNull();
  });
});

describe('command line', () => {
  let dir: string;
  const lines: string[] = [];
  const out = { log: (l: string) => lines.push(l), error: (l: string) => lines.push(`ERR ${l}`) };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'pixeltwin-cli-'));
    lines.length = 0;
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test('migrate applies migrations once', async () => {
    expect(await main(['migrate'], { DATA_DIR: dir }, out)).toBe(0);
    expect(await main(['migrate'], { DATA_DIR: dir }, out)).toBe(0);
    expect(lines).toEqual([
      'Applied: 0001_init, 0002_retention_indexes, 0003_build_numbers, 0004_review_events, 0005_snapshot_areas, 0006_outdated_checks, 0007_stored_objects, 0008_parallel_builds, 0009_auto_approve_new, 0010_timings',
      'Database is up to date.',
    ]);
  });

  test('admin reset-password prints a working password', async () => {
    await main(['migrate'], { DATA_DIR: dir }, out);
    const handle = openDatabase(`sqlite:${join(dir, 'pixeltwin.db')}`);
    await createUser({ db: handle.db }, { email: 'ada@example.com', password: PASSWORD });
    await handle.close();

    expect(await main(['admin', 'reset-password', 'ADA@example.com'], { DATA_DIR: dir }, out)).toBe(0);
    expect(lines.at(-1)).toMatch(/^New password for ada@example\.com: [0-9A-Za-z]{20}$/);
    expect(await main(['admin', 'reset-password', 'nobody@example.com'], { DATA_DIR: dir }, out)).toBe(1);
    expect(lines.at(-1)).toBe('ERR User nobody@example.com not found.');
  });

  test('bad usage and bad configuration exit with 2', async () => {
    expect(await main(['frobnicate'], { DATA_DIR: dir }, out)).toBe(2);
    expect(await main(['admin', 'reset-password'], { DATA_DIR: dir }, out)).toBe(2);
    expect(await main(['migrate'], { DATA_DIR: dir, PORT: 'eighty' }, out)).toBe(2);
    expect(lines.at(-1)).toContain('PORT');
    expect(await main(['--help'], {}, out)).toBe(0);
  });

  test('healthcheck exits 0 for a running server and 1 when nothing answers', async () => {
    const server = await startServer(loadConfig({ DATA_DIR: dir, PORT: '0', DIFF_WORKERS: '1' }), silentLogger);
    try {
      const port = new URL(server.url).port;
      expect(await main(['healthcheck'], { DATA_DIR: dir, PORT: port }, out)).toBe(0);
      expect(lines.at(-1)).toBe('ok');
    } finally {
      await server.stop();
    }
    const unused = Bun.serve({ port: 0, fetch: () => new Response() });
    const port = String(unused.port);
    await unused.stop(true);
    expect(await main(['healthcheck'], { DATA_DIR: dir, PORT: port }, out)).toBe(1);
  });

  test('a port that is already taken is a one-line error, not a crash', async () => {
    const blocker = Bun.serve({ port: 0, fetch: () => new Response() });
    try {
      expect(await main(['serve'], { DATA_DIR: dir, PORT: String(blocker.port) }, out)).toBe(1);
      expect(lines.at(-1)).toBe(`ERR Port ${blocker.port} is already in use. Stop the other process or set PORT.`);
    } finally {
      await blocker.stop(true);
    }
  });
});
