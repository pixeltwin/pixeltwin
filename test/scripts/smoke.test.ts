import { expect, test } from 'bun:test';
import { smokeCommand } from '../../scripts/smoke';

test('the smoke test passes against the server started from source', async () => {
  const lines: string[] = [];
  await smokeCommand([process.execPath, 'src/main.ts'], (line) => lines.push(line));
  expect(lines).toEqual([
    '✓ healthz',
    '✓ setup and login',
    '✓ project and token',
    '✓ first build: new → approved → passed',
    '✓ second build: changed (diff computed in a worker) → pending',
    '✓ docs, contract, llms.txt and UI served',
  ]);
}, 60_000);

test('a server that never prints its startup lines fails the smoke test at the deadline', async () => {
  const started = Date.now();
  await expect(smokeCommand(['sh', '-c', 'sleep 30'], () => {}, { startupTimeoutMs: 500 })).rejects.toThrow(
    'the server did not start within 0.5 s',
  );
  expect(Date.now() - started).toBeLessThan(5_000);
}, 10_000);
