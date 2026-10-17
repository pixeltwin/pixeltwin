import { describe, expect, test } from 'bun:test';
import { hmacSha256Hex, PLAIN_SECRETS, SecretBox, signatureMatches } from '../../src/domain/secrets';
import { appError } from '../helpers/errors';

const KEY = 'k'.repeat(32);

describe('secrets at rest', () => {
  test('with SECRET_KEY a secret is sealed with AES-GCM and opens again', () => {
    const box = new SecretBox(KEY);
    expect(box.encrypts).toBe(true);
    const sealed = box.seal('ghp_supersecret');
    expect(sealed).toStartWith('v1:');
    expect(sealed).not.toContain('supersecret');
    // A fresh IV each time: equal secrets do not look equal at rest.
    expect(box.seal('ghp_supersecret')).not.toBe(sealed);
    expect(box.open(sealed)).toBe('ghp_supersecret');
  });

  test('without SECRET_KEY secrets are kept as they are, and still open after a key is set', () => {
    expect(PLAIN_SECRETS.encrypts).toBe(false);
    const stored = PLAIN_SECRETS.seal('ghp_plain');
    expect(stored).toBe('plain:ghp_plain');
    expect(new SecretBox(KEY).open(stored)).toBe('ghp_plain');
  });

  test('a sealed secret does not open with another key, without a key, or when tampered with', async () => {
    const sealed = new SecretBox(KEY).seal('ghp_x');
    for (const attempt of [
      () => new SecretBox('o'.repeat(32)).open(sealed),
      () => PLAIN_SECRETS.open(sealed),
      () => new SecretBox(KEY).open(`${sealed.slice(0, -2)}AA`),
      () => new SecretBox(KEY).open('nonsense'),
    ]) {
      const err = await appError(Promise.resolve().then(attempt));
      expect(err.code).toBe('secret_unreadable');
      expect(err.detail).not.toContain('ghp_x');
    }
  });

  test('signatures: sha256=<hex HMAC>, compared in constant time', () => {
    const body = new TextEncoder().encode('{"a":1}');
    const hex = hmacSha256Hex('s3cret', body);
    expect(hex).toMatch(/^[0-9a-f]{64}$/);
    expect(signatureMatches('s3cret', body, `sha256=${hex}`)).toBe(true);
    expect(signatureMatches('s3cret', body, `sha256=${hex.toUpperCase()}`)).toBe(false);
    expect(signatureMatches('other', body, `sha256=${hex}`)).toBe(false);
    expect(signatureMatches('s3cret', body, hex)).toBe(false);
    expect(signatureMatches('s3cret', body, 'sha256=abc')).toBe(false);
    expect(signatureMatches('s3cret', body, undefined)).toBe(false);
  });
});

describe('shared secret tokens', () => {
  test('GitLab-style tokens compare in constant time, any length', async () => {
    const { secretMatches } = await import('../../src/domain/secrets');
    expect(secretMatches('a-long-secret-token', 'a-long-secret-token')).toBe(true);
    expect(secretMatches('a-long-secret-token', 'a-long-secret-tokeN')).toBe(false);
    expect(secretMatches('a-long-secret-token', 'short')).toBe(false);
    expect(secretMatches('a-long-secret-token', undefined)).toBe(false);
  });
});
