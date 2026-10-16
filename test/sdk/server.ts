// A real pixeltwin for the SDK tests: started from this checkout with an empty DATA_DIR on a free
// port in 19000–19099, set up with an admin, a project and a token (read, write, review).
import { type ChildProcess, spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

export const REPO = resolve(import.meta.dir, '../..');
const PASSWORD = 'pixeltwin-sdk-password';

export interface TestServer {
  url: string;
  port: number;
  /** Admin session cookie (`pt_session=…`), for creating more projects. */
  cookie: string;
  project: string;
  token: string;
  /** Another project and token, so a test can start from no baselines. */
  newProject(slug: string): Promise<string>;
  stop(): Promise<void>;
}

function portFree(port: number): Promise<boolean> {
  return new Promise((done) => {
    const probe = createServer();
    probe.once('error', () => done(false));
    probe.listen(port, '127.0.0.1', () => probe.close(() => done(true)));
  });
}

async function freePort(): Promise<number> {
  const start = Math.floor(Math.random() * 100);
  for (let i = 0; i < 100; i++) {
    const port = 19000 + ((start + i) % 100);
    if (await portFree(port)) return port;
  }
  throw new Error('no free port in 19000–19099');
}

function waitForSetupToken(server: ChildProcess): Promise<string> {
  return new Promise((done, fail) => {
    let buffer = '';
    let token = '';
    let listening = false;
    const timer = setTimeout(() => fail(new Error('pixeltwin did not start within 30 s')), 30_000);
    server.stdout?.on('data', (chunk: Buffer) => {
      buffer += chunk.toString();
      for (const line of buffer.split('\n').slice(0, -1)) {
        if (line.includes('"msg":"listening"')) listening = true;
        token ||= /"setupToken":"([0-9A-Za-z]+)"/.exec(line)?.[1] ?? '';
      }
      buffer = buffer.slice(buffer.lastIndexOf('\n') + 1);
      if (listening && token) {
        clearTimeout(timer);
        done(token);
      }
    });
    server.once('exit', (code) => fail(new Error(`pixeltwin exited with code ${code}`)));
  });
}

async function call<T>(url: string, path: string, body: unknown, headers: Record<string, string> = {}): Promise<T> {
  const res = await fetch(`${url}/api/v1${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`POST ${path} → ${res.status}: ${text}`);
  return (text ? JSON.parse(text) : {}) as T;
}

export async function startServer(project = 'web'): Promise<TestServer> {
  const port = await freePort();
  const url = `http://localhost:${port}`;
  const dataDir = mkdtempSync(join(tmpdir(), 'pixeltwin-sdk-'));
  const server = spawn(process.execPath, ['src/main.ts', 'serve'], {
    cwd: REPO,
    env: { ...process.env, DATA_DIR: dataDir, PORT: String(port), PUBLIC_URL: url, LOG_LEVEL: 'info' },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const exited = new Promise((done) => server.once('exit', done));
  const stop = async () => {
    if (server.exitCode === null) server.kill();
    await exited;
    rmSync(dataDir, { recursive: true, force: true });
  };
  try {
    const setupToken = await waitForSetupToken(server);
    const email = 'admin@sdk.test';
    await call(url, '/setup', { token: setupToken, email, password: PASSWORD });
    const login = await fetch(`${url}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: url },
      body: JSON.stringify({ email, password: PASSWORD }),
    });
    if (!login.ok) throw new Error(`login → ${login.status}`);
    const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
    const admin = { cookie, origin: url };
    const newProject = async (slug: string) => {
      await call(url, '/projects', { slug, name: slug }, admin);
      const { token } = await call<{ token: string }>(
        url,
        `/projects/${slug}/tokens`,
        { name: 'sdk', scopes: ['read', 'write', 'review'] },
        admin,
      );
      return token;
    };
    const token = await newProject(project);
    return { url, port, cookie, project, token, newProject, stop };
  } catch (err) {
    await stop();
    throw err;
  }
}
