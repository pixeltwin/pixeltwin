import { describe, expect, test } from 'bun:test';
import { cpus } from 'node:os';
import { resolve } from 'node:path';
import { ConfigError, cpuLimitFrom, loadConfig } from '../src/config';

describe('loadConfig', () => {
  test('works with no variables set', () => {
    const config = loadConfig({});
    expect(config.port).toBe(8080);
    expect(config.publicUrl).toBe('http://localhost:8080');
    expect(config.logLevel).toBe('info');
    expect(config.dataDir).toBe(resolve('./data'));
    expect(config.databaseUrl).toBe(`sqlite:${resolve('./data/pixeltwin.db')}`);
    // One core stays free for the main thread, which takes every request.
    expect(config.diffWorkers).toBe(Math.max(1, cpus().length - 1));
    expect(config.diffTimeoutMs).toBe(30_000);
    expect(config.diffQueueMax).toBe(config.diffWorkers * 20);
    expect(config.databasePoolMax).toBe(20);
    expect(config.storage).toBe('local');
    expect(config.setupToken).toBeNull();
    expect(config.maxImageBytes).toBe(10 * 1024 * 1024);
    expect(config.maxImagePixels).toBe(40_000_000);
  });

  test('reads overrides', () => {
    const config = loadConfig({
      DATA_DIR: '/srv/pt',
      DATABASE_URL: 'postgres://u:p@db:5432/pt',
      DIFF_WORKERS: '3',
      DIFF_TIMEOUT_MS: '5000',
      DIFF_QUEUE_MAX: '0',
      DATABASE_POOL_MAX: '40',
    });
    expect(config.diffQueueMax).toBe(0);
    expect(config.databasePoolMax).toBe(40);
    expect(config.dataDir).toBe('/srv/pt');
    expect(config.databaseUrl).toBe('postgres://u:p@db:5432/pt');
    expect(config.diffWorkers).toBe(3);
    expect(config.diffTimeoutMs).toBe(5000);
  });

  test('STORAGE=postgres keeps images in the database, which must then be Postgres', () => {
    const pg = loadConfig({ STORAGE: 'postgres', DATABASE_URL: 'postgres://u:p@db:5432/pt' });
    expect(pg.storage).toBe('postgres');
    expect(() => loadConfig({ STORAGE: 'postgres' })).toThrow('STORAGE=postgres needs DATABASE_URL');
    expect(() => loadConfig({ STORAGE: 's3' })).toThrow(ConfigError);
  });

  test('SETUP_TOKEN fixes the first-run token (for a Kubernetes Secret); it must be long', () => {
    expect(loadConfig({ SETUP_TOKEN: 'a'.repeat(24) }).setupToken).toBe('a'.repeat(24));
    expect(() => loadConfig({ SETUP_TOKEN: 'short' })).toThrow(ConfigError);
  });

  test('SECRET_KEY encrypts integration secrets (at least 32 characters); private networks are allowed by default', () => {
    expect(loadConfig({}).secretKey).toBeNull();
    expect(loadConfig({ SECRET_KEY: 's'.repeat(32) }).secretKey).toBe('s'.repeat(32));
    expect(() => loadConfig({ SECRET_KEY: 'short' })).toThrow(ConfigError);
    expect(loadConfig({}).outboundBlockPrivate).toBe(false);
    expect(loadConfig({ OUTBOUND_BLOCK_PRIVATE: '1' }).outboundBlockPrivate).toBe(true);
    expect(loadConfig({ OUTBOUND_BLOCK_PRIVATE: 'false' }).outboundBlockPrivate).toBe(false);
  });

  test('METRICS=1 serves Prometheus metrics on a port of its own (9464 by default)', () => {
    expect(loadConfig({}).metricsPort).toBeNull();
    expect(loadConfig({ METRICS_PORT: '9100' }).metricsPort).toBeNull();
    expect(loadConfig({ METRICS: '1' }).metricsPort).toBe(9464);
    expect(loadConfig({ METRICS: 'true', METRICS_PORT: '9100' }).metricsPort).toBe(9100);
    expect(() => loadConfig({ METRICS: '1', PORT: '9464' })).toThrow('METRICS_PORT must differ from PORT');
    expect(() => loadConfig({ METRICS: 'maybe' })).toThrow(ConfigError);
  });

  test('diff workers follow the container CPU limit, not the machine', () => {
    expect(cpuLimitFrom({ 'cpu.max': 'max 100000' })).toBeNull();
    expect(cpuLimitFrom({ 'cpu.max': '200000 100000' })).toBe(2);
    expect(cpuLimitFrom({ 'cpu.max': '150000 100000' })).toBe(2);
    expect(cpuLimitFrom({ 'cpu.cfs_quota_us': '50000', 'cpu.cfs_period_us': '100000' })).toBe(1);
    expect(cpuLimitFrom({ 'cpu.cfs_quota_us': '-1', 'cpu.cfs_period_us': '100000' })).toBeNull();
    expect(cpuLimitFrom({})).toBeNull();
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

  test('derives PUBLIC_URL from PORT and strips a trailing slash', () => {
    expect(loadConfig({ PORT: '9000' }).publicUrl).toBe('http://localhost:9000');
    expect(loadConfig({ PUBLIC_URL: 'https://pixeltwin.example.com/' }).publicUrl).toBe(
      'https://pixeltwin.example.com',
    );
    expect(loadConfig({ PUBLIC_URL: 'https://example.com/pixeltwin/' }).publicUrl).toBe(
      'https://example.com/pixeltwin',
    );
  });

  test('rejects a PUBLIC_URL that is not http(s) and an unknown LOG_LEVEL', () => {
    expect(() => loadConfig({ PUBLIC_URL: 'ftp://example.com' })).toThrow('PUBLIC_URL');
    expect(() => loadConfig({ LOG_LEVEL: 'loud' })).toThrow('LOG_LEVEL');
  });
});
