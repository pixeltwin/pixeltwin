// Runs the example projects in examples/ end to end against a fresh pixeltwin from this checkout.
//   bun scripts/examples.ts                 both examples
//   bun scripts/examples.ts playwright      one of them (playwright, wdio)
//
// For each example: pack the SDK into examples/<name>/vendor and `npm install`, then
//   run 1                                   every check `new`, the run passes (no gate);
//   approve the build                       with a token that has the `review` scope;
//   run 2   PIXELTWIN_GATE=1                every check `unchanged`, verdict passed, exit 0;
//   run 3   PIXELTWIN_GATE=1 DEMO_CHANGE=1  some checks `changed`, the gate fails the run, exit 1.
//
// The server gets an empty DATA_DIR and a free port in 19100–19179 (the demo sites use 19181 and
// 19182); both are gone at the end. Needs npm, Playwright's browsers (`npx playwright install`) and,
// for WebdriverIO, a network connection the first time (it downloads Chrome for Testing and its driver).
import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dir, '..');
const examples = ['playwright', 'wdio'] as const;
type Example = (typeof examples)[number];
const PASSWORD = 'pixeltwin-examples-password';

const chosen = (process.argv.slice(2).length ? process.argv.slice(2) : examples) as Example[];
for (const name of chosen) {
  if (!examples.includes(name)) throw new Error(`unknown example "${name}" (${examples.join(', ')})`);
}

function portFree(port: number): Promise<boolean> {
  return new Promise((done) => {
    const probe = createServer();
    probe.once('error', () => done(false));
    probe.listen(port, '127.0.0.1', () => probe.close(() => done(true)));
  });
}

async function freePort(): Promise<number> {
  for (let port = 19100; port < 19180; port++) if (await portFree(port)) return port;
  throw new Error('no free port in 19100–19179');
}

function run(command: string, args: string[], cwd: string, env: Record<string, string> = {}) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ...env },
    maxBuffer: 64 * 1024 * 1024,
  });
  return { status: result.status, output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

function must(command: string, args: string[], cwd: string) {
  const result = run(command, args, cwd);
  if (result.status !== 0) {
    console.error(result.output);
    throw new Error(`${command} ${args.join(' ')} failed (${result.status}) in ${cwd}`);
  }
}

async function startPixeltwin() {
  const port = await freePort();
  const url = `http://localhost:${port}`;
  const dataDir = mkdtempSync(join(tmpdir(), 'pixeltwin-examples-'));
  const server: ChildProcess = spawn(process.execPath, ['src/main.ts', 'serve'], {
    cwd: root,
    env: { ...process.env, DATA_DIR: dataDir, PORT: String(port), PUBLIC_URL: url, LOG_LEVEL: 'info' },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const exited = new Promise((done) => server.once('exit', done));
  const stop = async () => {
    if (server.exitCode === null) server.kill();
    await exited;
    rmSync(dataDir, { recursive: true, force: true });
  };
  const setupToken = await new Promise<string>((done, fail) => {
    let log = '';
    const timer = setTimeout(() => fail(new Error('pixeltwin did not start within 30 s')), 30_000);
    server.stdout?.on('data', (chunk: Buffer) => {
      log += chunk.toString();
      const token = /"setupToken":"([0-9A-Za-z]+)"/.exec(log)?.[1];
      if (token && log.includes('"msg":"listening"')) {
        clearTimeout(timer);
        done(token);
      }
    });
    server.once('exit', (code) => fail(new Error(`pixeltwin exited with code ${code}`)));
  }).catch(async (err) => {
    await stop();
    throw err;
  });

  const post = async <T>(path: string, body: unknown, headers: Record<string, string> = {}) => {
    const res = await fetch(`${url}/api/v1${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`POST ${path} → ${res.status}: ${text}`);
    return { json: (text ? JSON.parse(text) : {}) as T, res };
  };
  const email = 'admin@examples.test';
  await post('/setup', { token: setupToken, email, password: PASSWORD });
  const { res } = await post('/auth/login', { email, password: PASSWORD }, { origin: url });
  const admin = { cookie: (res.headers.get('set-cookie') ?? '').split(';')[0] ?? '', origin: url };
  const project = async (slug: string) => {
    await post('/projects', { slug, name: slug }, admin);
    const token = async (name: string, scopes: string[]) =>
      (await post<{ token: string }>(`/projects/${slug}/tokens`, { name, scopes }, admin)).json.token;
    return { slug, ci: await token('CI', ['read', 'write']), reviewer: await token('reviewer', ['read', 'review']) };
  };
  const api = async <T>(path: string, token: string, method = 'GET') => {
    const res = await fetch(`${url}/api/v1${path}`, { method, headers: { authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${await res.text()}`);
    return (await res.json()) as T;
  };
  return { url, project, api, stop };
}

interface Counts {
  total: number;
  result: { unchanged: number; changed: number; new: number; error: number };
}

function check(condition: boolean, message: string, output: string) {
  if (condition) return;
  console.error(output);
  throw new Error(message);
}

/** The lines worth reading: pixeltwin's own and the runner's summary. */
function interesting(output: string): string {
  return output
    .split('\n')
    .filter((line) => /pixeltwin|passed|failed|Spec Files|exit code|SevereServiceError/i.test(line))
    .filter((line) => !/"level"/.test(line))
    .join('\n');
}

const pixeltwin = await startPixeltwin();
let failed = false;
try {
  for (const name of chosen) {
    const dir = join(root, 'examples', name);
    console.log(`\n=== examples/${name}`);
    rmSync(join(dir, 'vendor'), { recursive: true, force: true });
    must(process.execPath, ['scripts/build-sdk.ts', 'pack', join(dir, 'vendor')], root);
    rmSync(join(dir, 'node_modules/@pixeltwin'), { recursive: true, force: true });
    rmSync(join(dir, 'package-lock.json'), { force: true });
    must('npm', ['install', '--no-audit', '--no-fund'], dir);

    const project = await pixeltwin.project(`example-${name}`);
    const env = {
      PIXELTWIN_URL: pixeltwin.url,
      PIXELTWIN_TOKEN: project.ci,
      PIXELTWIN_PROJECT: project.slug,
      PIXELTWIN_BRANCH: 'main',
      CI: '',
    };
    const test = (extra: Record<string, string>) => {
      const result = run('npm', ['test'], dir, { ...env, ...extra });
      const buildId = /\/ui\/builds\/(bld_[0-9A-Z]+)/.exec(result.output)?.[1] ?? '';
      return { ...result, buildId };
    };
    const countsOf = async (id: string) =>
      (await pixeltwin.api<{ counts: Counts; verdict: string }>(`/builds/${id}`, project.ci)).counts;

    const first = test({});
    console.log(`\n--- run 1: first run (exit ${first.status})\n${interesting(first.output)}`);
    const one = await countsOf(first.buildId);
    check(first.status === 0, 'run 1 should pass', first.output);
    check(one.total > 0 && one.result.new === one.total, `run 1 should be all new: ${JSON.stringify(one)}`, '');

    const approved = await pixeltwin.api<{ approved: number }>(
      `/builds/${first.buildId}/approve`,
      project.reviewer,
      'POST',
    );
    console.log(`\n--- approved build ${first.buildId}: ${JSON.stringify(approved)}`);

    const second = test({ PIXELTWIN_GATE: '1' });
    console.log(`\n--- run 2: PIXELTWIN_GATE=1 (exit ${second.status})\n${interesting(second.output)}`);
    const two = await countsOf(second.buildId);
    check(second.status === 0, 'run 2 should pass the gate', second.output);
    check(two.result.unchanged === one.total, `run 2 should be all unchanged: ${JSON.stringify(two)}`, '');

    const third = test({ PIXELTWIN_GATE: '1', DEMO_CHANGE: '1' });
    console.log(`\n--- run 3: PIXELTWIN_GATE=1 DEMO_CHANGE=1 (exit ${third.status})\n${interesting(third.output)}`);
    const three = await countsOf(third.buildId);
    check(third.status === 1, 'run 3 should fail the gate with exit code 1', third.output);
    check(three.result.changed > 0, `run 3 should have changed checks: ${JSON.stringify(three)}`, '');
    console.log(`\nexamples/${name}: ok (${one.total} checks: new → unchanged → ${three.result.changed} changed)`);
  }
} catch (err) {
  failed = true;
  console.error(err instanceof Error ? err.message : err);
} finally {
  await pixeltwin.stop();
}
process.exit(failed ? 1 : 0);
