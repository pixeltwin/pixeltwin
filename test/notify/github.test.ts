import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { GitHubError, postCommitStatus, upsertComment } from '../../src/notify/github';
import { addressKind, addressProblem, outboundUrlProblem } from '../../src/notify/outbound';
import { FAKE_TOKEN, type FakeGitHub, startFakeGitHub } from '../helpers/fake-github';

const noSleep = async () => {};

describe('GitHub client', () => {
  let gh: FakeGitHub;
  const auth = () => ({ apiUrl: gh.url, token: FAKE_TOKEN });

  beforeEach(() => {
    gh = startFakeGitHub();
  });

  afterEach(() => {
    gh.stop();
  });

  const status = {
    state: 'pending' as const,
    description: '2 screenshots to review',
    context: 'pixeltwin/web',
    target_url: 'http://pt/ui/builds/bld_1',
  };

  test('posts a commit status with the token', async () => {
    await postCommitStatus(auth(), 'acme/shop', 'abc123', status, { sleep: noSleep });
    expect(gh.statuses).toEqual([{ repo: 'acme/shop', sha: 'abc123', ...status }]);
    expect(gh.requests[0]?.authorization).toBe(`Bearer ${FAKE_TOKEN}`);
  });

  test('retries 5xx and 429, then succeeds', async () => {
    gh.failNext(502);
    gh.failNext(429, 1, { 'retry-after': '1' });
    const waits: number[] = [];
    await postCommitStatus(auth(), 'acme/shop', 'abc', status, { sleep: async (ms) => void waits.push(ms) });
    expect(gh.statuses).toHaveLength(1);
    expect(waits).toHaveLength(2);
    expect(waits[1]).toBe(1000);
  });

  test('gives up after three attempts; a retryable error says so', async () => {
    gh.failNext(503, 3);
    const err = await postCommitStatus(auth(), 'acme/shop', 'abc', status, { sleep: noSleep }).catch((e) => e);
    expect(err).toBeInstanceOf(GitHubError);
    expect(err.retryable).toBe(true);
    expect(gh.requests).toHaveLength(3);
  });

  test('a 4xx is not retried, and no error ever contains the token', async () => {
    const err = await postCommitStatus({ apiUrl: gh.url, token: 'ghp_wrong_token_9876' }, 'acme/shop', 'abc', status, {
      sleep: noSleep,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(GitHubError);
    expect(err.status).toBe(401);
    expect(err.retryable).toBe(false);
    expect(err.message).toContain('Bad credentials');
    expect(err.message).not.toContain('ghp_wrong_token_9876');
    expect(JSON.stringify(err)).not.toContain('ghp_wrong_token_9876');
    expect(gh.requests).toHaveLength(1);
  });

  test('a request that takes too long times out and is retried', async () => {
    gh.delay(300);
    const err = await postCommitStatus(auth(), 'acme/shop', 'abc', status, { sleep: noSleep, timeoutMs: 50 }).catch(
      (e) => e,
    );
    expect(err).toBeInstanceOf(GitHubError);
    expect(err.message).toContain('timed out');
    expect(err.retryable).toBe(true);
  });

  test('a comment is created once, then found by its marker or id and edited in place', async () => {
    const marker = '<!-- pixeltwin:build:bld_1 -->';
    const id = await upsertComment(auth(), 'acme/shop', 42, marker, `${marker}\nfirst`, null, { sleep: noSleep });
    expect([...gh.comments.values()]).toEqual([
      { id: Number(id), repo: 'acme/shop', pr: 42, body: `${marker}\nfirst` },
    ]);
    // Known id: edited directly.
    expect(await upsertComment(auth(), 'acme/shop', 42, marker, `${marker}\nsecond`, id, { sleep: noSleep })).toBe(id);
    // Id lost: found by the marker among the pull request's comments.
    expect(await upsertComment(auth(), 'acme/shop', 42, marker, `${marker}\nthird`, null, { sleep: noSleep })).toBe(id);
    // The stored id points at a deleted comment: found again (or created).
    gh.comments.delete(Number(id));
    const fresh = await upsertComment(auth(), 'acme/shop', 42, marker, `${marker}\nfourth`, id, { sleep: noSleep });
    expect(fresh).not.toBe(id);
    expect(gh.comments.size).toBe(1);
    expect(gh.comments.get(Number(fresh))?.body).toContain('fourth');
  });
});

describe('outbound URLs', () => {
  test('only http(s) without credentials', () => {
    expect(outboundUrlProblem('https://hooks.slack.com/services/x')).toBeNull();
    expect(outboundUrlProblem('http://10.0.0.5:8080/hook')).toBeNull();
    expect(outboundUrlProblem('ftp://example.com')).toContain('http');
    expect(outboundUrlProblem('file:///etc/passwd')).toContain('http');
    expect(outboundUrlProblem('javascript:alert(1)')).toContain('http');
    expect(outboundUrlProblem('https://user:pass@example.com')).toContain('password');
    expect(outboundUrlProblem('not a url')).toContain('URL');
  });

  test('link-local (cloud metadata) is always refused; private networks only when blocked', async () => {
    expect(addressKind('169.254.169.254')).toBe('link-local');
    expect(addressKind('fe80::1')).toBe('link-local');
    expect(addressKind('fd00:ec2::254')).toBe('link-local');
    for (const ip of [
      '127.0.0.1',
      '10.1.2.3',
      '172.20.0.1',
      '192.168.1.1',
      '100.64.0.1',
      '::1',
      'fd12::1',
      '0.0.0.0',
    ]) {
      expect(addressKind(ip)).toBe('private');
    }
    expect(addressKind('::ffff:10.0.0.1')).toBe('private');
    expect(addressKind('140.82.112.3')).toBe('public');
    expect(addressKind('172.32.0.1')).toBe('public');

    expect(await addressProblem(new URL('http://169.254.169.254/latest'), false)).toContain('link-local');
    expect(await addressProblem(new URL('http://127.0.0.1:9/hook'), false)).toBeNull();
    expect(await addressProblem(new URL('http://127.0.0.1:9/hook'), true)).toContain('OUTBOUND_BLOCK_PRIVATE');
    expect(await addressProblem(new URL('http://[::1]:9/hook'), true)).toContain('private');
    expect(await addressProblem(new URL('http://localhost:9/hook'), true)).toContain('private');
  });
});
