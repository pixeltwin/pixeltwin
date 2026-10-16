// Load test: many CI runs posting screenshots to one pixeltwin in parallel. See docs/load-testing.md.
//
//   BUN_CONFIG_MAX_HTTP_REQUESTS=8192 bun scripts/load.ts --spawn --runs 20 --checks 50
//   bun scripts/load.ts --spawn --ramp 10,20,40,80 --checks 20
//   bun scripts/load.ts --url http://localhost:18900 --token pt_… [--cookie pt_session=…] [--pid 1234]
//
// Each run opens a build, posts its checks concurrently and finalizes. The first run seeds the
// baselines and approves them; later runs compare against those. With --spawn the script starts a
// fresh server from this checkout (temporary DATA_DIR), sets it up, samples its RSS and CPU, scans
// its log, and stops it at the end.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import { PNG } from 'pngjs';

const { values: opt } = parseArgs({
  options: {
    url: { type: 'string' },
    token: { type: 'string' },
    cookie: { type: 'string' },
    pid: { type: 'string' },
    'setup-token': { type: 'string' },
    spawn: { type: 'boolean', default: false },
    port: { type: 'string', default: '18900' },
    'database-url': { type: 'string' },
    'diff-workers': { type: 'string' },
    'keep-data': { type: 'boolean', default: false },
    project: { type: 'string', default: 'load' },
    runs: { type: 'string', default: '5' },
    checks: { type: 'string', default: '50' },
    'check-concurrency': { type: 'string' },
    width: { type: 'string', default: '1280' },
    height: { type: 'string', default: '800' },
    changed: { type: 'string', default: '0.1' },
    reencoded: { type: 'string', default: '0' },
    json: { type: 'boolean', default: false },
    ramp: { type: 'string' },
    'stop-p95-ms': { type: 'string', default: '5000' },
    'stop-error-rate': { type: 'string', default: '0.01' },
    stagger: { type: 'string', default: '0' },
    readers: { type: 'string', default: '2' },
    'reader-interval': { type: 'string', default: '200' },
    'timeout-ms': { type: 'string', default: '300000' },
    out: { type: 'string' },
    help: { type: 'boolean', short: 'h', default: false },
  },
});

if (opt.help) {
  console.log(`Options (defaults in brackets):
  --spawn                  start a fresh server from this checkout on --port [18900]
  --database-url URL       with --spawn: use this Postgres database instead of SQLite
  --diff-workers N         with --spawn: DIFF_WORKERS for the server [CPU count]
  --keep-data              with --spawn: keep the temporary DATA_DIR
  --url URL --token T      target an already running server instead (token scopes read, write, review)
  --setup-token T          with --url: set up a fresh server first (creates admin, project, token)
  --cookie C               session cookie "pt_session=…" for UI reads (set automatically after setup)
  --pid N                  server process to sample with ps (found by port when omitted)
  --project SLUG           [load]
  --runs N                 parallel CI runs [5]
  --checks N               checks per run [50]
  --check-concurrency N    concurrent check uploads per run [all of them]
  --width W --height H     screenshot size [1280x800]
  --changed F              share of checks whose pixels differ from the baseline [0.1]
  --reencoded F            share whose pixels match but bytes differ (forces a full diff) [0]
  --json                   post checks as JSON with imageBase64 instead of multipart
  --ramp L1,L2,...         run one wave per level of parallel runs; stop at the knee
  --stop-p95-ms MS         ramp stops when check p95 exceeds this [5000]
  --stop-error-rate F      ramp stops when this share of requests fails [0.01]
  --stagger MS             spread run starts randomly over this many ms [0]
  --readers N              concurrent reviewer loops reading builds during load [2]
  --reader-interval MS     pause between a reader's requests [200]
  --timeout-ms MS          client timeout per request [300000]
  --out FILE               write the full results as JSON`);
  process.exit(0);
}

const int = (name: string, value: string | undefined): number => {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) throw new Error(`--${name} must be a non-negative number`);
  return n;
};

const CHECKS = int('checks', opt.checks);
const WIDTH = int('width', opt.width);
const HEIGHT = int('height', opt.height);
const CHANGED = int('changed', opt.changed);
const REENCODED = int('reencoded', opt.reencoded);
const CHECK_CONCURRENCY = opt['check-concurrency'] ? int('check-concurrency', opt['check-concurrency']) : CHECKS;
const LEVELS = (opt.ramp ?? opt.runs ?? '5').split(',').map((v) => int('runs', v.trim()));
const STOP_P95 = int('stop-p95-ms', opt['stop-p95-ms']);
const STOP_ERRORS = int('stop-error-rate', opt['stop-error-rate']);
const STAGGER = int('stagger', opt.stagger);
const READERS = int('readers', opt.readers);
const READER_INTERVAL = int('reader-interval', opt['reader-interval']);
const TIMEOUT = int('timeout-ms', opt['timeout-ms']);
const PROJECT = opt.project as string;

if (!process.env.BUN_CONFIG_MAX_HTTP_REQUESTS) {
  console.warn(
    'note: Bun fetch allows 256 requests in flight by default; set BUN_CONFIG_MAX_HTTP_REQUESTS=8192 so the ' +
      'client does not queue requests itself.',
  );
}

// ---------------------------------------------------------------------------------------------
// Screenshots

function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Rgb = [number, number, number];

/** A page-like screenshot: header, nav, hero, cards and lines of glyph-like "text". */
function drawPage(seed: number, width: number, height: number, changed: boolean): PNG {
  const png = new PNG({ width, height });
  const px = new Uint32Array(png.data.buffer, png.data.byteOffset, width * height);
  const pack = ([r, g, b]: Rgb) => ((255 << 24) | (b << 16) | (g << 8) | r) >>> 0;
  const fill = (x: number, y: number, w: number, h: number, c: Rgb) => {
    const v = pack(c);
    const x1 = Math.min(width, x + w);
    for (let yy = Math.max(0, y); yy < Math.min(height, y + h); yy++)
      px.fill(v, yy * width + Math.max(0, x), yy * width + x1);
  };
  const rnd = prng(seed * 7919 + 17);
  const accent: Rgb = [Math.floor(rnd() * 200), Math.floor(rnd() * 200), 180 + Math.floor(rnd() * 70)];
  fill(0, 0, width, height, [250, 250, 251]);
  fill(0, 0, width, 56, [24, 24, 27]);
  for (let i = 0; i < 6; i++) fill(220 + i * 110, 20, 70, 14, [200, 200, 205]);
  fill(24, 16, 120, 24, accent);
  fill(0, 56, 220, height - 56, [241, 241, 244]);
  for (let i = 0; i < 14; i++) fill(20, 84 + i * 34, 120 + Math.floor(rnd() * 60), 12, [120, 120, 130]);

  // Hero with a vertical gradient: realistic screenshots are rarely flat.
  for (let y = 80; y < 260 && y < height; y++) {
    const t = (y - 80) / 180;
    fill(244, y, width - 268, 1, [
      Math.round(accent[0] * (1 - t) + 255 * t),
      Math.round(accent[1] * (1 - t) + 255 * t),
      Math.round(accent[2] * (1 - t) + 255 * t),
    ]);
  }
  // A photo in the hero: noisy pixels compress poorly, like real imagery does.
  const photoX = width - 24 - 380;
  for (let y = 90; y < 250 && y < height; y++) {
    for (let x = Math.max(0, photoX); x < photoX + 360 && x < width; x++) {
      const n = Math.floor(rnd() * 24);
      px[y * width + x] = pack([
        Math.min(255, 90 + ((x * 3) % 120) + n),
        Math.min(255, 110 + ((y * 2) % 90) + n),
        Math.min(255, 140 + n),
      ]);
    }
  }
  // Text: words of glyphs with antialiased edges.
  const text = (x0: number, y0: number, maxW: number, lines: number, color: Rgb) => {
    for (let l = 0; l < lines; l++) {
      let x = x0;
      const y = y0 + l * 20;
      const lineEnd = x0 + maxW * (0.6 + rnd() * 0.4);
      while (x < lineEnd) {
        const word = 2 + Math.floor(rnd() * 8);
        for (let g = 0; g < word && x < lineEnd; g++) {
          const gw = 4 + Math.floor(rnd() * 5);
          const gh = 8 + Math.floor(rnd() * 4);
          fill(x, y + (12 - gh), gw, gh, [color[0] + 90, color[1] + 90, color[2] + 90]);
          fill(x + 1, y + (12 - gh) + 1, Math.max(1, gw - 2), gh - 2, color);
          x += gw + 1;
        }
        x += 5;
      }
    }
  };
  text(268, 120, width - 560, 3, [20, 20, 30]);
  // Cards
  const cardW = Math.floor((width - 268 - 3 * 24) / 3);
  for (let row = 0; row < 3; row++) {
    for (let col = 0; col < 3; col++) {
      const x = 244 + col * (cardW + 24);
      const y = 290 + row * 170;
      if (y + 150 > height) continue;
      fill(x, y, cardW, 150, [228, 228, 232]);
      fill(x + 1, y + 1, cardW - 2, 148, [255, 255, 255]);
      fill(x + 16, y + 16, 48, 48, accent);
      text(x + 76, y + 20, cardW - 96, 2, [40, 40, 50]);
      text(x + 16, y + 76, cardW - 32, 3, [90, 90, 100]);
    }
  }
  if (changed) {
    // A typical regression: a button grew and changed colour, a text line moved.
    fill(268, 200, 180, 40, [229, 72, 77]);
    text(268, 160, 420, 1, [200, 30, 30]);
  } else {
    fill(268, 200, 140, 40, [24, 24, 27]);
  }
  return png;
}

function encode(png: PNG, deflateLevel: number): Uint8Array {
  return new Uint8Array(PNG.sync.write(png, { deflateLevel }));
}

interface Shot {
  name: string;
  variant: Record<string, string>;
  baseline: Uint8Array;
  changed: Uint8Array;
  reencoded: Uint8Array;
}

function makeShots(count: number): Shot[] {
  const shots: Shot[] = [];
  for (let i = 0; i < count; i++) {
    const page = drawPage(i, WIDTH, HEIGHT, false);
    shots.push({
      name: `page-${String(i).padStart(3, '0')}`,
      variant: { browser: 'chromium', viewport: `${WIDTH}x${HEIGHT}` },
      baseline: encode(page, 6),
      changed: CHANGED > 0 ? encode(drawPage(i, WIDTH, HEIGHT, true), 6) : new Uint8Array(),
      // Same pixels, different deflate level: a different sha, so the server must decode and diff.
      reencoded: REENCODED > 0 ? encode(page, 1) : new Uint8Array(),
    });
  }
  return shots;
}

// ---------------------------------------------------------------------------------------------
// HTTP with measurement

interface Sample {
  endpoint: string;
  ms: number;
  status: number;
  code: string | null;
  at: number;
}

const samples: Sample[] = [];
const errorExamples = new Map<string, string>();
const checkResults = new Map<string, number>();

function recordError(key: string, detail: string) {
  if (!errorExamples.has(key)) errorExamples.set(key, detail.slice(0, 300));
}

interface Target {
  base: string;
  api: string;
  token: string;
  cookie: string | null;
}

async function request(
  endpoint: string,
  url: string,
  init: RequestInit,
): Promise<{ status: number; body: unknown; text: string } | null> {
  const started = performance.now();
  try {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT) });
    const text = await res.text();
    const ms = performance.now() - started;
    let body: unknown = null;
    if ((res.headers.get('content-type') ?? '').includes('json')) {
      try {
        body = JSON.parse(text);
      } catch {}
    }
    const code = res.ok ? null : (((body as { code?: string } | null)?.code ?? `http_${res.status}`) as string);
    samples.push({ endpoint, ms, status: res.status, code, at: Date.now() });
    if (code) recordError(`${endpoint} ${res.status} ${code}`, text);
    return { status: res.status, body, text };
  } catch (err) {
    const ms = performance.now() - started;
    const e = err as { name?: string; code?: string; message?: string };
    const code = e.name === 'TimeoutError' ? 'client_timeout' : (e.code ?? e.name ?? 'network_error');
    samples.push({ endpoint, ms, status: 0, code, at: Date.now() });
    recordError(`${endpoint} 0 ${code}`, String(e.message ?? err));
    return null;
  }
}

function ok<T extends { status: number }>(res: T | null): res is T {
  return !!res && res.status >= 200 && res.status < 300;
}

const hex40 = () => Array.from({ length: 40 }, () => Math.floor(Math.random() * 16).toString(16)).join('');

async function pool<T>(items: T[], limit: number, work: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const lanes = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) await work(items[next++] as T);
  });
  await Promise.all(lanes);
}

type Kind = 'baseline' | 'changed' | 'reencoded';

interface RunResult {
  buildId: string | null;
  ms: number;
  checksOk: number;
  checksFailed: number;
}

const liveBuilds: string[] = [];

/** One CI run: open a build, post the checks concurrently, finalize (approve first when seeding). */
async function ciRun(t: Target, shots: Shot[], pick: (i: number) => Kind, approve: boolean): Promise<RunResult> {
  const started = performance.now();
  const auth = { authorization: `Bearer ${t.token}` };
  const created = await request('POST /builds', `${t.api}/projects/${PROJECT}/builds`, {
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({ branch: 'main', commitSha: hex40(), externalId: `load-${crypto.randomUUID()}` }),
  });
  if (!ok(created)) return { buildId: null, ms: performance.now() - started, checksOk: 0, checksFailed: shots.length };
  const buildId = (created.body as { id: string }).id;
  liveBuilds.push(buildId);
  let checksOk = 0;
  let checksFailed = 0;
  await pool(
    shots.map((s, i) => [s, i] as const),
    CHECK_CONCURRENCY,
    async ([shot, i]) => {
      const kind = pick(i);
      const bytes = shot[kind];
      let body: BodyInit;
      const headers: Record<string, string> = { ...auth };
      if (opt.json) {
        headers['content-type'] = 'application/json';
        body = JSON.stringify({
          name: shot.name,
          variant: shot.variant,
          imageBase64: Buffer.from(bytes).toString('base64'),
        });
      } else {
        const form = new FormData();
        form.set('image', new File([bytes as Uint8Array<ArrayBuffer>], `${shot.name}.png`, { type: 'image/png' }));
        form.set('meta', JSON.stringify({ name: shot.name, variant: shot.variant }));
        body = form;
      }
      const res = await request('POST /checks', `${t.api}/builds/${buildId}/checks`, {
        method: 'POST',
        headers,
        body,
      });
      if (!ok(res)) {
        checksFailed++;
        return;
      }
      checksOk++;
      const check = res.body as { result: string; diff?: { error?: { code: string } } | null };
      const key = `${kind}→${check.result}${check.diff?.error ? `(${check.diff.error.code})` : ''}`;
      checkResults.set(key, (checkResults.get(key) ?? 0) + 1);
      if (check.diff?.error) recordError(`check result error ${check.diff.error.code}`, JSON.stringify(check.diff));
    },
  );
  if (approve) {
    const res = await request('POST /approve', `${t.api}/builds/${buildId}/approve`, { method: 'POST', headers: auth });
    if (ok(res)) console.log(`  seed: approved ${(res.body as { approved: number }).approved} checks`);
  }
  await request('POST /finalize', `${t.api}/builds/${buildId}/finalize`, { method: 'POST', headers: auth });
  return { buildId, ms: performance.now() - started, checksOk, checksFailed };
}

/** A reviewer clicking around while CI uploads: build JSON, its checks, and the build page. */
async function reader(t: Target, active: () => boolean): Promise<void> {
  const auth = { authorization: `Bearer ${t.token}` };
  while (active()) {
    const id = liveBuilds[Math.floor(Math.random() * liveBuilds.length)];
    if (id) {
      await request('GET /builds/{id}', `${t.api}/builds/${id}`, { headers: auth });
      await request('GET /builds/{id}/checks', `${t.api}/builds/${id}/checks?limit=50`, { headers: auth });
      if (t.cookie)
        await request('GET /ui/builds/{id}', `${t.base}/ui/builds/${id}`, { headers: { cookie: t.cookie } });
    }
    await Bun.sleep(READER_INTERVAL);
  }
}

// ---------------------------------------------------------------------------------------------
// Server process sampling

interface ProcSample {
  at: number;
  rssMb: number;
  cpuSec: number;
}

function parseCpuTime(value: string): number {
  // macOS: [[dd-]hh:]mm:ss.cc ; Linux: [[dd-]hh:]mm:ss
  const [days, rest] = value.includes('-') ? (value.split('-') as [string, string]) : ['0', value];
  const parts = rest.split(':').map(Number);
  while (parts.length < 3) parts.unshift(0);
  const [h, m, s] = parts as [number, number, number];
  return Number(days) * 86400 + h * 3600 + m * 60 + s;
}

function startSampler(pid: number | null, everyMs = 500) {
  const out: ProcSample[] = [];
  let stopped = false;
  const loop = (async () => {
    while (!stopped && pid) {
      const proc = Bun.spawn(['ps', '-o', 'rss=,time=', '-p', String(pid)], { stdout: 'pipe', stderr: 'ignore' });
      const text = (await new Response(proc.stdout).text()).trim();
      const [rss, time] = text.split(/\s+/);
      if (rss && time) out.push({ at: Date.now(), rssMb: Number(rss) / 1024, cpuSec: parseCpuTime(time) });
      await Bun.sleep(everyMs);
    }
  })();
  return {
    async stop() {
      stopped = true;
      await loop;
      if (out.length < 2) return null;
      let peakCpu = 0;
      for (let i = 1; i < out.length; i++) {
        const a = out[i - 1] as ProcSample;
        const b = out[i] as ProcSample;
        peakCpu = Math.max(peakCpu, ((b.cpuSec - a.cpuSec) / ((b.at - a.at) / 1000)) * 100);
      }
      const first = out[0] as ProcSample;
      const last = out[out.length - 1] as ProcSample;
      return {
        rssStartMb: Math.round(first.rssMb),
        rssPeakMb: Math.round(Math.max(...out.map((s) => s.rssMb))),
        rssEndMb: Math.round(last.rssMb),
        cpuAvgPct: Math.round(((last.cpuSec - first.cpuSec) / ((last.at - first.at) / 1000)) * 100),
        cpuPeakPct: Math.round(peakCpu),
      };
    },
  };
}

async function pidOnPort(port: string): Promise<number | null> {
  const proc = Bun.spawn(['lsof', '-ti', `tcp:${port}`, '-sTCP:LISTEN'], { stdout: 'pipe', stderr: 'ignore' });
  const text = (await new Response(proc.stdout).text()).trim().split('\n')[0];
  return text ? Number(text) : null;
}

// ---------------------------------------------------------------------------------------------
// Spawned server

interface Spawned {
  url: string;
  pid: number;
  setupToken: string;
  logLines: string[];
  stop(): Promise<void>;
}

async function spawnServer(): Promise<Spawned> {
  const root = join(dirname(new URL(import.meta.url).pathname), '..');
  const dataDir = mkdtempSync(join(tmpdir(), 'pixeltwin-load-'));
  const port = opt.port as string;
  const url = `http://localhost:${port}`;
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    DATA_DIR: dataDir,
    PORT: port,
    PUBLIC_URL: url,
    LOG_LEVEL: 'info',
  };
  delete env.BUN_CONFIG_MAX_HTTP_REQUESTS;
  if (opt['database-url']) env.DATABASE_URL = opt['database-url'];
  else delete env.DATABASE_URL;
  if (opt['diff-workers']) env.DIFF_WORKERS = opt['diff-workers'];
  const proc = Bun.spawn(['bun', 'src/main.ts', 'serve'], { cwd: root, env, stdout: 'pipe', stderr: 'pipe' });
  const logLines: string[] = [];
  let setupToken: string | null = null;
  let listening = false;
  const consume = async (stream: ReadableStream<Uint8Array>) => {
    let buffer = '';
    const decoder = new TextDecoder();
    for await (const chunk of stream) {
      buffer += decoder.decode(chunk, { stream: true });
      let nl = buffer.indexOf('\n');
      while (nl >= 0) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        logLines.push(line);
        if (line.includes('"setupToken"')) setupToken = (JSON.parse(line) as { setupToken: string }).setupToken;
        if (line.includes('"msg":"listening"')) listening = true;
        nl = buffer.indexOf('\n');
      }
    }
  };
  void consume(proc.stdout);
  void consume(proc.stderr);
  const deadline = Date.now() + 30_000;
  while (!(listening && setupToken) && Date.now() < deadline && proc.exitCode === null) await Bun.sleep(50);
  if (!listening || !setupToken) {
    proc.kill();
    rmSync(dataDir, { recursive: true, force: true });
    throw new Error(`Server did not start (a reused database has no setup token):\n${logLines.join('\n')}`);
  }
  console.log(`server pid ${proc.pid} on ${url}, data ${dataDir}${opt['database-url'] ? ', postgres' : ', sqlite'}`);
  return {
    url,
    pid: proc.pid,
    setupToken: setupToken as string,
    logLines,
    async stop() {
      proc.kill('SIGTERM');
      const timer = setTimeout(() => proc.kill('SIGKILL'), 10_000);
      await proc.exited;
      clearTimeout(timer);
      if (opt['keep-data']) console.log(`kept ${dataDir}`);
      else rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

async function setUp(base: string, setupToken: string): Promise<{ token: string; cookie: string }> {
  const api = `${base}/api/v1`;
  const json = { 'content-type': 'application/json' };
  const call = async (path: string, headers: Record<string, string>, body: unknown) => {
    const res = await fetch(`${api}${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
    if (!res.ok) throw new Error(`POST ${path} → ${res.status} ${await res.text()}`);
    return res;
  };
  const creds = { email: 'load@example.com', password: 'load-test-password' };
  await call('/setup', json, { token: setupToken, ...creds });
  const login = await call('/auth/login', json, creds);
  const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0] as string;
  const admin = { ...json, cookie, origin: new URL(base).origin };
  await call('/projects', admin, { slug: PROJECT, name: 'Load test' });
  const tok = await call(`/projects/${PROJECT}/tokens`, admin, { name: 'load', scopes: ['read', 'write', 'review'] });
  return { token: ((await tok.json()) as { token: string }).token, cookie };
}

// ---------------------------------------------------------------------------------------------
// Reporting

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] as number;
}

function stats(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    n: sorted.length,
    p50: Math.round(percentile(sorted, 50)),
    p95: Math.round(percentile(sorted, 95)),
    p99: Math.round(percentile(sorted, 99)),
    max: Math.round(sorted[sorted.length - 1] ?? 0),
  };
}

function table(rows: Array<Record<string, string | number>>): string {
  if (rows.length === 0) return '';
  const cols = Object.keys(rows[0] as object);
  const widths = cols.map((c) => Math.max(c.length, ...rows.map((r) => String(r[c]).length)));
  const line = (cells: string[]) => `| ${cells.map((c, i) => c.padEnd(widths[i] as number)).join(' | ')} |`;
  return [
    line(cols),
    line(widths.map((w) => '-'.repeat(w))),
    ...rows.map((r) => line(cols.map((c) => String(r[c])))),
  ].join('\n');
}

/** Server-side timing and problems from the request log (only with --spawn). */
function scanLog(lines: string[]) {
  const byRoute = new Map<string, number[]>();
  const statuses = new Map<string, number>();
  const notable: string[] = [];
  const counts: Record<string, number> = { SQLITE_BUSY: 0, 'database is locked': 0, diff_timeout: 0, diff_failed: 0 };
  for (const line of lines) {
    for (const k of Object.keys(counts)) if (line.includes(k)) counts[k] = (counts[k] ?? 0) + 1;
    let entry: { level?: string; msg?: string; method?: string; path?: string; status?: number; ms?: number };
    try {
      entry = JSON.parse(line);
    } catch {
      if (line.trim()) notable.push(line);
      continue;
    }
    if (entry.msg === 'request' && entry.path && entry.method) {
      const route = `${entry.method} ${entry.path.replace(/\/(bld|chk|prj|img)_[A-Za-z0-9]+/g, '/{id}')}`;
      if (!byRoute.has(route)) byRoute.set(route, []);
      byRoute.get(route)?.push(entry.ms ?? 0);
      if ((entry.status ?? 0) >= 400) {
        const k = `${route} ${entry.status}`;
        statuses.set(k, (statuses.get(k) ?? 0) + 1);
      }
    } else if (entry.level === 'warn' || entry.level === 'error') {
      if (!line.includes('setupToken')) notable.push(line);
    }
  }
  return {
    serverMs: [...byRoute].filter(([, v]) => v.length >= 5).map(([route, v]) => ({ route, ...stats(v) })),
    errorStatuses: Object.fromEntries(statuses),
    counts,
    notable: notable.slice(0, 20),
  };
}

// ---------------------------------------------------------------------------------------------
// Main

let server: Spawned | null = null;
const cleanup = async () => {
  if (server) {
    const s = server;
    server = null;
    await s.stop();
  }
};
process.once('SIGINT', async () => {
  await cleanup();
  process.exit(130);
});

try {
  let target: Target;
  if (opt.spawn) {
    server = await spawnServer();
    const { token, cookie } = await setUp(server.url, server.setupToken);
    target = { base: server.url, api: `${server.url}/api/v1`, token, cookie };
  } else {
    const base = (opt.url ?? 'http://localhost:18900').replace(/\/$/, '');
    let token = opt.token ?? null;
    let cookie = opt.cookie ?? null;
    if (opt['setup-token']) ({ token, cookie } = await setUp(base, opt['setup-token']));
    if (!token) throw new Error('Pass --token (or --setup-token for a fresh server, or --spawn).');
    target = { base, api: `${base}/api/v1`, token, cookie };
  }
  const pid = server ? server.pid : opt.pid ? Number(opt.pid) : await pidOnPort(new URL(target.base).port || '80');

  const t0 = performance.now();
  const shots = makeShots(CHECKS);
  const avgKb = Math.round(shots.reduce((sum, s) => sum + s.baseline.byteLength, 0) / shots.length / 1024);
  console.log(
    `generated ${CHECKS} screenshots ${WIDTH}x${HEIGHT}, ~${avgKb} KB each, in ${Math.round(performance.now() - t0)} ms`,
  );

  // Seed: one run creates and approves every baseline.
  const seed = await ciRun(target, shots, () => 'baseline', true);
  console.log(`seed run: ${seed.checksOk}/${CHECKS} checks in ${Math.round(seed.ms)} ms`);
  if (seed.checksFailed > 0) throw new Error(`Seeding failed: ${[...errorExamples].join('\n')}`);
  samples.length = 0;
  checkResults.clear();
  errorExamples.clear();

  const nChanged = Math.round(CHECKS * CHANGED);
  const nReencoded = Math.min(CHECKS - nChanged, Math.round(CHECKS * REENCODED));
  const levels: unknown[] = [];
  for (const parallel of LEVELS) {
    samples.length = 0;
    checkResults.clear();
    errorExamples.clear();
    const sampler = startSampler(pid);
    let active = true;
    const readers = Array.from({ length: READERS }, () => reader(target, () => active));
    const cpu0 = process.cpuUsage();
    const started = performance.now();
    const runs = await Promise.all(
      Array.from({ length: parallel }, async () => {
        if (STAGGER > 0) await Bun.sleep(Math.random() * STAGGER);
        // Each run changes a different random subset of checks.
        const order = shots.map((_, i) => i).sort(() => Math.random() - 0.5);
        const kinds = new Map<number, Kind>();
        for (const i of order.slice(0, nChanged)) kinds.set(i, 'changed');
        for (const i of order.slice(nChanged, nChanged + nReencoded)) kinds.set(i, 'reencoded');
        return ciRun(target, shots, (i) => kinds.get(i) ?? 'baseline', false);
      }),
    );
    const wallMs = performance.now() - started;
    active = false;
    await Promise.all(readers);
    const cpu = process.cpuUsage(cpu0);
    const proc = await sampler.stop();

    const endpoints = [...new Set(samples.map((s) => s.endpoint))];
    const latency = endpoints.map((endpoint) => {
      const of = samples.filter((s) => s.endpoint === endpoint);
      return { endpoint, ...stats(of.map((s) => s.ms)), errors: of.filter((s) => s.code).length };
    });
    const errors: Record<string, number> = {};
    for (const s of samples)
      if (s.code)
        errors[`${s.endpoint} ${s.status} ${s.code}`] = (errors[`${s.endpoint} ${s.status} ${s.code}`] ?? 0) + 1;
    // Client-side latency buckets for check uploads; TCP SYN retries show up near 1 s, 3 s and 7 s.
    const bounds = [100, 250, 500, 1000, 2000, 3000, 4000, 7000, 8000, 15000];
    const histogram: Record<string, number> = Object.fromEntries(
      [...bounds.map((b) => `<${b}`), '>=15000'].map((k) => [k, 0]),
    );
    for (const s of samples) {
      if (s.endpoint !== 'POST /checks') continue;
      const b = bounds.find((x) => s.ms < x);
      const key = b ? `<${b}` : `>=${bounds[bounds.length - 1]}`;
      histogram[key] = (histogram[key] ?? 0) + 1;
    }
    const checksOk = runs.reduce((n, r) => n + r.checksOk, 0);
    const checkLatency = latency.find((l) => l.endpoint === 'POST /checks');
    const errorRate = samples.length ? samples.filter((s) => s.code).length / samples.length : 0;
    const result = {
      parallelRuns: parallel,
      checksPerRun: CHECKS,
      changedPerRun: nChanged,
      reencodedPerRun: nReencoded,
      wallMs: Math.round(wallMs),
      checksOk,
      checksFailed: runs.reduce((n, r) => n + r.checksFailed, 0),
      checksPerSec: Math.round((checksOk / (wallMs / 1000)) * 10) / 10,
      runWallMs: stats(runs.map((r) => r.ms)),
      latency,
      checkLatencyHistogram: histogram,
      errors,
      errorExamples: Object.fromEntries(errorExamples),
      checkResults: Object.fromEntries(checkResults),
      server: proc,
      clientCpuPct: Math.round(((cpu.user + cpu.system) / 1000 / wallMs) * 100),
    };
    levels.push(result);

    console.log(
      `\n== ${parallel} parallel runs × ${CHECKS} checks (${nChanged} changed, ${nReencoded} re-encoded per run): ` +
        `${Math.round(wallMs)} ms, ${result.checksPerSec} checks/s, ${result.checksFailed} failed checks`,
    );
    console.log(table(latency.map((l) => ({ ...l }))));
    console.log(
      `run wall ms: p50 ${result.runWallMs.p50}, p95 ${result.runWallMs.p95}, max ${result.runWallMs.max}; ` +
        `server: ${proc ? `RSS ${proc.rssStartMb}→peak ${proc.rssPeakMb} MB, CPU avg ${proc.cpuAvgPct}% peak ${proc.cpuPeakPct}%` : 'not sampled'}; ` +
        `load client CPU ${result.clientCpuPct}%`,
    );
    console.log(`check results: ${JSON.stringify(result.checkResults)}`);
    console.log(`check latency histogram (ms): ${JSON.stringify(histogram)}`);
    if (Object.keys(errors).length) {
      console.log(`errors: ${JSON.stringify(errors)}`);
      for (const [k, v] of errorExamples) console.log(`  e.g. ${k}: ${v}`);
    }

    if (LEVELS.length > 1 && ((checkLatency?.p95 ?? 0) > STOP_P95 || errorRate > STOP_ERRORS)) {
      console.log(
        `\nknee: stopping the ramp at ${parallel} parallel runs (check p95 ${checkLatency?.p95} ms, error rate ${(errorRate * 100).toFixed(1)}%)`,
      );
      break;
    }
  }

  const log = server ? scanLog(server.logLines) : null;
  if (log) {
    console.log('\nserver-side request time (from the request log, all levels):');
    console.log(table(log.serverMs.map((r) => ({ ...r }))));
    console.log(`log counts: ${JSON.stringify(log.counts)}; 4xx/5xx: ${JSON.stringify(log.errorStatuses)}`);
    for (const line of log.notable) console.log(`  log: ${line.slice(0, 400)}`);
  }
  if (opt.out) {
    writeFileSync(
      opt.out,
      JSON.stringify(
        {
          options: { ...opt, token: undefined, cookie: undefined },
          database: opt['database-url'] ? 'postgres' : 'sqlite',
          levels,
          log,
        },
        null,
        2,
      ),
    );
    console.log(`results written to ${opt.out}`);
  }
} finally {
  await cleanup();
}
