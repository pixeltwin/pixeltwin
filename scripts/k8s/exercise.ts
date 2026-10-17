// Exercises pixeltwin running in Kubernetes with several replicas (scripts/k8s/kind-smoke.sh runs it):
//   1. the smoke test (setup, login, project, token, checks, diff, finalize, docs);
//   2. a webhook to an in-cluster receiver: one delivery per finalized build, never two, although
//      every replica polls the outbox;
//   3. a rolling restart in the middle of uploads: every check posted with the SDK succeeds (its
//      retries cover a connection the old pod closed), and the build has all of them.
//
//   bun scripts/k8s/exercise.ts --url http://localhost:18680 --token <setup token> \
//     --echo http://localhost:18681 --hook-url http://pixeltwin-echo.pixeltwin.svc/hook \
//     --namespace pixeltwin --deployment pixeltwin
import { PNG } from 'pngjs';
import { PixeltwinClient } from '../../packages/client/src/client';
import { smoke } from '../smoke';

interface Received {
  delivery: string;
  event: string;
  buildId: string | null;
}

function arg(name: string, fallback?: string): string {
  const at = Bun.argv.indexOf(`--${name}`);
  const value = at >= 0 ? Bun.argv[at + 1] : fallback;
  if (value === undefined) throw new Error(`--${name} is required`);
  return value;
}

const base = arg('url').replace(/\/$/, '');
const setupToken = arg('token');
const echo = arg('echo').replace(/\/$/, '');
const hookUrl = arg('hook-url');
const namespace = arg('namespace', 'pixeltwin');
const deployment = arg('deployment', 'pixeltwin');
const minChecks = Number(arg('checks', '60'));
const api = `${base}/api/v1`;

const started = performance.now();
const elapsed = () => `${((performance.now() - started) / 1000).toFixed(1)} s`;
const log = (line: string) => console.log(`[${elapsed()}] ${line}`);

function png(seed: number, size = 192): Uint8Array {
  const image = new PNG({ width: size, height: size });
  for (let i = 0; i < size * size; i++) {
    const v = (i * 7 + seed * 31) % 251;
    image.data.set([v, (v + seed) % 256, 255 - v, 255], i * 4);
  }
  return new Uint8Array(PNG.sync.write(image));
}

async function call(method: string, path: string, headers: Record<string, string>, body?: unknown) {
  const res = await fetch(`${api}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${text.slice(0, 300)}`);
  return (text ? JSON.parse(text) : {}) as Record<string, unknown>;
}

async function received(): Promise<Received[]> {
  return (await (await fetch(`${echo}/deliveries`)).json()) as Received[];
}

/** Waits until the receiver has a build.finalized delivery for `buildId`, then a while longer for a duplicate. */
async function expectOneDelivery(buildId: string, settleMs = 15_000): Promise<void> {
  const deadline = Date.now() + 60_000;
  let mine: Received[] = [];
  while (Date.now() < deadline) {
    mine = (await received()).filter((r) => r.event === 'build.finalized' && r.buildId === buildId);
    if (mine.length > 0) break;
    await Bun.sleep(500);
  }
  if (mine.length === 0) throw new Error(`no build.finalized delivery for ${buildId} within 60 s`);
  // Three replicas poll the outbox every 2 s: give them several rounds to send it again.
  await Bun.sleep(settleMs);
  mine = (await received()).filter((r) => r.event === 'build.finalized' && r.buildId === buildId);
  if (mine.length !== 1) {
    throw new Error(`build ${buildId}: ${mine.length} deliveries, expected exactly 1: ${JSON.stringify(mine)}`);
  }
}

function kubectl(...args: string[]) {
  return Bun.spawn(['kubectl', '-n', namespace, ...args], { stdout: 'pipe', stderr: 'pipe' });
}

// 1. The smoke test, as against a single binary.
await smoke({ url: base, setupToken }, log);

// 2. A project with a webhook to the in-cluster receiver.
const login = await fetch(`${api}/auth/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: 'smoke@example.com', password: 'smoke test password' }),
});
if (!login.ok) throw new Error(`login → ${login.status}`);
const asAdmin = {
  cookie: (login.headers.get('set-cookie') ?? '').split(';')[0] ?? '',
  origin: new URL(base).origin,
};
await call('POST', '/projects', asAdmin, { slug: 'k8s', name: 'Kubernetes smoke' });
const { token } = (await call('POST', '/projects/k8s/tokens', asAdmin, {
  name: 'smoke',
  scopes: ['read', 'write', 'review'],
})) as { token: string };
await call('POST', '/projects/k8s/webhooks', asAdmin, { url: hookUrl, events: ['build.finalized'] });
log('✓ project k8s with a webhook to the in-cluster receiver');

const client = new PixeltwinClient({ url: base, token });
const first = await client.openBuild('k8s', { branch: 'main' });
await client.postCheck(first.id, { name: 'home', image: png(1) });
await client.finalize(first.id);
await expectOneDelivery(first.id);
log('✓ webhook delivered exactly once with 3 replicas polling the outbox');

// 3. A rolling restart while a CI run uploads.
const build = await client.openBuild('k8s', { branch: 'main' });
let rolloutDone = false;
let posted = 0;
const failures: string[] = [];
const restarted = (async () => {
  await Bun.sleep(1500);
  const restart = kubectl('rollout', 'restart', `deployment/${deployment}`);
  if ((await restart.exited) !== 0) throw new Error(await new Response(restart.stderr).text());
  log('… rollout restart started');
  const status = kubectl('rollout', 'status', `deployment/${deployment}`, '--timeout=5m');
  if ((await status.exited) !== 0) throw new Error(await new Response(status.stderr).text());
  rolloutDone = true;
  log('… rollout finished');
})();
const uploadStarted = performance.now();
let next = 0;
const uploader = async () => {
  while (!rolloutDone || next < minChecks) {
    const n = next++;
    try {
      await client.postCheck(build.id, { name: `screen-${n}`, image: png(n), variant: { browser: 'chromium' } });
      posted++;
    } catch (err) {
      failures.push(`screen-${n}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
};
await Promise.all([restarted, ...Array.from({ length: 4 }, uploader)]);
const uploadSeconds = (performance.now() - uploadStarted) / 1000;
if (failures.length > 0)
  throw new Error(`${failures.length} checks failed during the rollout:\n${failures.join('\n')}`);
const finalized = await client.finalize(build.id);
const { counts } = finalized;
if (counts.total !== posted) throw new Error(`the build has ${counts.total} checks, ${posted} were posted`);
log(`✓ rolling restart mid-upload: ${posted} checks in ${uploadSeconds.toFixed(1)} s, none failed, all in the build`);
await expectOneDelivery(build.id);
log('✓ webhook for the build finalized after the rollout delivered exactly once');

const all = await received();
const ids = new Set(all.map((r) => r.delivery));
if (ids.size !== all.length) throw new Error(`a delivery id arrived twice: ${JSON.stringify(all)}`);
log(`k8s exercise: ok (${all.length} deliveries, all distinct)`);
