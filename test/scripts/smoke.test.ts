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
