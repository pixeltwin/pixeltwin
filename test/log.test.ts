import { describe, expect, test } from 'bun:test';
import { createLogger } from '../src/log';

describe('createLogger', () => {
  test('writes JSON lines at or above the level', () => {
    const lines: string[] = [];
    const log = createLogger('info', (line) => lines.push(line));
    log.debug('hidden');
    log.info('started', { port: 8080 });
    log.error('failed', { requestId: 'req_1' });
    expect(lines.map((l) => JSON.parse(l))).toMatchObject([
      { level: 'info', msg: 'started', port: 8080 },
      { level: 'error', msg: 'failed', requestId: 'req_1' },
    ]);
    expect(JSON.parse(lines[0] ?? '{}').time).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});
