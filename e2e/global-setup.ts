// Starts pixeltwin from source on E2E_PORT with an empty data dir, creates the users the tests
// log in as, and returns the teardown. Runs under Node (Playwright), so it spawns `bun`.
import { type ChildProcess, spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ADMIN, PASSWORD, REVIEWER } from './fixtures';
import { E2E_PORT } from './playwright.config';

function waitForSetupToken(server: ChildProcess): Promise<string> {
  return new Promise((resolve, reject) => {
    let buffer = '';
    let token = '';
    let listening = false;
    const timer = setTimeout(() => reject(new Error('pixeltwin did not start within 30 s')), 30_000);
    server.stdout?.on('data', (chunk: Buffer) => {
      buffer += chunk.toString();
      for (const line of buffer.split('\n').slice(0, -1)) {
        if (line.includes('"msg":"listening"')) listening = true;
        token ||= /"setupToken":"([0-9A-Za-z]+)"/.exec(line)?.[1] ?? '';
      }
      buffer = buffer.slice(buffer.lastIndexOf('\n') + 1);
      if (listening && token) {
        clearTimeout(timer);
        resolve(token);
      }
    });
    server.on('exit', (code) => reject(new Error(`pixeltwin exited with code ${code}`)));
  });
}

export default async function globalSetup(): Promise<() => Promise<void>> {
  const dataDir = mkdtempSync(join(tmpdir(), 'pixeltwin-e2e-'));
  const url = `http://localhost:${E2E_PORT}`;
  const server = spawn(process.env.BUN ?? 'bun', ['src/main.ts', 'serve'], {
    env: { ...process.env, DATA_DIR: dataDir, PORT: String(E2E_PORT), PUBLIC_URL: url, LOG_LEVEL: 'info' },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const token = await waitForSetupToken(server);

  const json = { 'content-type': 'application/json' };
  const setup = await fetch(`${url}/api/v1/setup`, {
    method: 'POST',
    headers: json,
    body: JSON.stringify({ token, email: ADMIN, password: PASSWORD }),
  });
  if (!setup.ok) throw new Error(`setup failed: ${setup.status} ${await setup.text()}`);
  const login = await fetch(`${url}/api/v1/auth/login`, {
    method: 'POST',
    headers: json,
    body: JSON.stringify({ email: ADMIN, password: PASSWORD }),
  });
  const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
  const reviewer = await fetch(`${url}/api/v1/users`, {
    method: 'POST',
    headers: { ...json, cookie, origin: url },
    body: JSON.stringify({ email: REVIEWER, password: PASSWORD, role: 'reviewer' }),
  });
  if (!reviewer.ok) throw new Error(`creating the reviewer failed: ${reviewer.status}`);

  return async () => {
    server.kill();
    await new Promise((resolve) => server.once('exit', resolve));
    rmSync(dataDir, { recursive: true, force: true });
  };
}
