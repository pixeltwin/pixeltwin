import { describe, expect, test } from 'bun:test';
import { LoginLimiter } from '../../src/http/rate-limit';

describe('LoginLimiter', () => {
  test('allows 10 attempts per minute for one IP and email', () => {
    let now = 0;
    const limiter = new LoginLimiter({ now: () => now });
    for (let i = 0; i < 10; i++) expect(limiter.hit('1.2.3.4', 'ada@example.com')).toBe(true);
    expect(limiter.hit('1.2.3.4', 'ada@example.com')).toBe(false);
    expect(limiter.hit('5.6.7.8', 'ada@example.com')).toBe(true);
    now += 60_000;
    expect(limiter.hit('1.2.3.4', 'ada@example.com')).toBe(true);
  });

  test('caps one IP across many emails', () => {
    const limiter = new LoginLimiter({ perIp: 60 });
    for (let i = 0; i < 60; i++) expect(limiter.hit('1.2.3.4', `user${i}@example.com`)).toBe(true);
    expect(limiter.hit('1.2.3.4', 'fresh@example.com')).toBe(false);
    expect(limiter.hit('9.9.9.9', 'fresh@example.com')).toBe(true);
  });
});
