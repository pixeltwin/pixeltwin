// End-to-end smoke test of a running pixeltwin (spec §11).
//   bun scripts/smoke.ts dist/pixeltwin-0.1.0-linux-x64       start a binary on a free port and test it
//   bun scripts/smoke.ts bun src/main.ts                      the same, from source
//   bun scripts/smoke.ts --url http://localhost:18080 --token <setup token>   an already running server
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PNG } from 'pngjs';

export interface SmokeTarget {
  url: string;
  setupToken: string;
}

function png(width: number, height: number, square?: { x: number; y: number; size: number }): Uint8Array {
  const image = new PNG({ width, height });
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const inSquare =
        square && x >= square.x && x < square.x + square.size && y >= square.y && y < square.y + square.size;
      image.data.set(inSquare ? [0, 0, 0, 255] : [255, 255, 255, 255], (y * width + x) * 4);
    }
  }
  return new Uint8Array(PNG.sync.write(image));
}

function expectEqual(what: string, actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${what}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

/** Runs setup → login → project → token → build → checks → review → finalize, plus docs and UI pages. */
export async function smoke(target: SmokeTarget, log: (line: string) => void = console.log): Promise<void> {
  const base = target.url.replace(/\/$/, '');
  const api = `${base}/api/v1`;
  const call = async (
    method: string,
    path: string,
    init: { headers?: Record<string, string>; body?: string | FormData } = {},
  ) => {
    const res = await fetch(`${path.startsWith('http') ? '' : api}${path}`, { method, ...init });
    const text = await res.text();
    if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${text.slice(0, 300)}`);
    return { res, body: text ? (JSON.parse(text) as Record<string, unknown>) : {} };
  };

  expectEqual('healthz', (await call('GET', `${base}/healthz`)).body.status, 'ok');
  log('✓ healthz');

  const password = 'smoke test password';
  await call('POST', '/setup', {
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: target.setupToken, email: 'smoke@example.com', password }),
  });
  const login = await call('POST', '/auth/login', {
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'smoke@example.com', password }),
  });
  const cookie = (login.res.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
  const asAdmin = { cookie, origin: new URL(base).origin, 'content-type': 'application/json' };
  log('✓ setup and login');

  await call('POST', '/projects', { headers: asAdmin, body: JSON.stringify({ slug: 'smoke', name: 'Smoke' }) });
  const created = await call('POST', '/projects/smoke/tokens', {
    headers: asAdmin,
    body: JSON.stringify({ name: 'smoke', scopes: ['read', 'write', 'review'] }),
  });
  const auth = { authorization: `Bearer ${created.body.token as string}` };
  log('✓ project and token');

  const openBuild = async () =>
    (
      await call('POST', '/projects/smoke/builds', {
        headers: { ...auth, 'content-type': 'application/json' },
        body: '{}',
      })
    ).body.id as string;
  const post = async (buildId: string, image: Uint8Array) => {
    const form = new FormData();
    form.set('image', new File([image], 'home.png', { type: 'image/png' }));
    form.set('meta', JSON.stringify({ name: 'home', variant: { browser: 'smoke' } }));
    return (await call('POST', `/builds/${buildId}/checks`, { headers: auth, body: form })).body;
  };

  const first = await openBuild();
  const fresh = await post(first, png(64, 64));
  expectEqual('first check', fresh.result, 'new');
  await call('POST', `/checks/${fresh.id as string}/approve`, { headers: auth });
  expectEqual(
    'first verdict',
    (await call('POST', `/builds/${first}/finalize`, { headers: auth })).body.verdict,
    'passed',
  );
  log('✓ first build: new → approved → passed');

  const second = await openBuild();
  const changed = await post(second, png(64, 64, { x: 8, y: 8, size: 8 }));
  expectEqual('second check', changed.result, 'changed');
  expectEqual('regions', (changed.diff as { regions: unknown[] }).regions, [
    { x: 8, y: 8, width: 8, height: 8, pixels: 64 },
  ]);
  expectEqual(
    'second verdict',
    (await call('POST', `/builds/${second}/finalize`, { headers: auth })).body.verdict,
    'pending',
  );
  log('✓ second build: changed (diff computed in a worker) → pending');

  for (const path of ['/docs', '/docs/scalar.js', '/openapi.json', '/llms.txt', '/ui/login']) {
    const res = await fetch(`${base}${path}`, { redirect: 'manual' });
    if (res.status !== 200 && !(path === '/ui/login' && res.status === 303)) {
      throw new Error(`GET ${path} → ${res.status}`);
    }
  }
  log('✓ docs, contract, llms.txt and UI served');
}

async function freePort(): Promise<number> {
  const probe = Bun.serve({ port: 0, fetch: () => new Response() });
  const port = probe.port as number;
  await probe.stop(true);
  return port;
}

/** Starts `command serve` with an empty data dir on a free port, runs the smoke test, stops it. */
export async function smokeCommand(command: string[], log: (line: string) => void = console.log): Promise<void> {
  const dataDir = mkdtempSync(join(tmpdir(), 'pixeltwin-smoke-'));
  const port = await freePort();
  const proc = Bun.spawn([...command, 'serve'], {
    env: {
      ...process.env,
      DATA_DIR: dataDir,
      PORT: String(port),
      PUBLIC_URL: '',
      DIFF_WORKERS: '1',
      LOG_LEVEL: 'info',
    },
    stdout: 'pipe',
    stderr: 'inherit',
  });
  try {
    let setupToken = '';
    let listening = false;
    const reader = proc.stdout.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const deadline = Date.now() + 20_000;
    while (!(listening && setupToken)) {
      if (Date.now() > deadline) throw new Error('the server did not start within 20 s');
      const { value, done } = await reader.read();
      if (done) throw new Error(`the server exited with code ${await proc.exited}`);
      buffer += decoder.decode(value, { stream: true });
      for (const line of buffer.split('\n').slice(0, -1)) {
        if (line.includes('"msg":"listening"')) listening = true;
        const token = /"setupToken":"([0-9A-Za-z]+)"/.exec(line)?.[1];
        if (token) setupToken = token;
      }
      buffer = buffer.slice(buffer.lastIndexOf('\n') + 1);
    }
    reader.releaseLock();
    await smoke({ url: `http://localhost:${port}`, setupToken }, log);
  } finally {
    proc.kill();
    await proc.exited;
    rmSync(dataDir, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const args = Bun.argv.slice(2);
  try {
    const urlAt = args.indexOf('--url');
    if (urlAt >= 0) {
      const tokenAt = args.indexOf('--token');
      await smoke({ url: args[urlAt + 1] ?? '', setupToken: args[tokenAt + 1] ?? '' });
    } else if (args.length > 0) {
      await smokeCommand(args);
    } else {
      throw new Error('usage: bun scripts/smoke.ts <command…> | --url <url> --token <setup token>');
    }
    console.log('smoke: ok');
  } catch (err) {
    console.error(`smoke: FAILED: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
