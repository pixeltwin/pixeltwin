import { describe, expect, test } from 'bun:test';
import { ConcurrencyGate } from '../../../src/domain/auth/password';
import { AppError } from '../../../src/errors';

describe('ConcurrencyGate', () => {
  test('runs up to `max` jobs, queues `queue` more, and refuses the rest with 429', async () => {
    const gate = new ConcurrencyGate(1, 1);
    let release!: () => void;
    const blocker = new Promise<void>((resolve) => {
      release = resolve;
    });
    const order: string[] = [];
    const first = gate.run(async () => {
      await blocker;
      order.push('first');
    });
    const second = gate.run(async () => {
      order.push('second');
    });
    const third = gate.run(async () => {
      order.push('third');
    });
    const refused = await third.then(
      () => null,
      (e: unknown) => e,
    );
    expect(refused).toBeInstanceOf(AppError);
    expect((refused as AppError).code).toBe('rate_limited');
    expect((refused as AppError).status).toBe(429);
    release();
    await Promise.all([first, second]);
    expect(order).toEqual(['first', 'second']);
  });

  test('frees its slot when a job throws', async () => {
    const gate = new ConcurrencyGate(1, 0);
    await expect(gate.run(async () => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    expect(await gate.run(async () => 'ok')).toBe('ok');
  });
});
