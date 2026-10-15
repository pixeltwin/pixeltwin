import { describe, expect, test } from 'bun:test';
import { cpus } from 'node:os';
import { resolve } from 'node:path';
import { ConfigError, loadConfig } from '../src/config';

describe('loadConfig', () => {
  test('works with no variables set', () => {
    const config = loadConfig({});
    expect(config.dataDir).toBe(resolve('./data'));
    expect(config.databaseUrl).toBe(`sqlite:${resolve('./data/pixeltwin.db')}`);
    expect(config.diffWorkers).toBe(Math.max(1, cpus().length));
    expect(config.diffTimeoutMs).toBe(30_000);
    expect(config.maxImageBytes).toBe(10 * 1024 * 1024);
    expect(config.maxImagePixels).toBe(40_000_000);
  });

  test('reads overrides', () => {
    const config = loadConfig({
      DATA_DIR: '/srv/pt',
      DATABASE_URL: 'postgres://u:p@db:5432/pt',
      DIFF_WORKERS: '3',
      DIFF_TIMEOUT_MS: '5000',
    });
    expect(config.dataDir).toBe('/srv/pt');
    expect(config.databaseUrl).toBe('postgres://u:p@db:5432/pt');
    expect(config.diffWorkers).toBe(3);
    expect(config.diffTimeoutMs).toBe(5000);
  });

  test('treats empty strings as unset', () => {
    const config = loadConfig({ DATABASE_URL: '', DIFF_WORKERS: '' });
    expect(config.databaseUrl.startsWith('sqlite:')).toBe(true);
    expect(config.diffWorkers).toBeGreaterThanOrEqual(1);
  });

  test('reports every invalid variable', () => {
    try {
      loadConfig({ DATABASE_URL: 'mysql://x', DIFF_WORKERS: 'many' });
      throw new Error('expected ConfigError');
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      const problems = (err as ConfigError).problems.join('\n');
      expect(problems).toContain('DATABASE_URL');
      expect(problems).toContain('DIFF_WORKERS');
    }
  });
});
