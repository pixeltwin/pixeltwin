import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { githubHost } from '../../src/notify/github';
import { gitlabHost } from '../../src/notify/gitlab';
import { CodeHostError } from '../../src/notify/http';
import { addressKind, addressProblem, outboundUrlProblem } from '../../src/notify/outbound';
import {
  FAKE_GITLAB_TOKEN,
  FAKE_TOKEN,
  type FakeGitHub,
  type FakeGitLab,
  startFakeGitHub,
  startFakeGitLab,
} from '../helpers/fake-hosts';

const noSleep = async () => {};
const status = {
  state: 'pending' as const,
  description: '2 screenshots to review',
  context: 'pixeltwin/web',
  targetUrl: 'http://pt/ui/builds/bld_1',
};

describe('GitHub adapter', () => {
  let gh: FakeGitHub;
  const host = (token = FAKE_TOKEN, options = {}) =>
    githubHost({ apiUrl: gh.url, token }, { sleep: noSleep, ...options });

  beforeEach(() => {
    gh = startFakeGitHub();
  });

  afterEach(() => {
    gh.stop();
  });

  test('posts a commit status with the token', async () => {
    await host().postStatus('acme/shop', 'abc123', status);
    expect(gh.statuses).toEqual([
      {
        repo: 'acme/shop',
        sha: 'abc123',
        state: 'pending',
        description: '2 screenshots to review',
        context: 'pixeltwin/web',
        target_url: 'http://pt/ui/builds/bld_1',
      },
    ]);
    expect(gh.requests[0]?.authorization).toBe(`Bearer ${FAKE_TOKEN}`);
  });

  test('retries 5xx and 429 (honouring Retry-After), then succeeds', async () => {
    gh.failNext(502);
    gh.failNext(429, 1, { 'retry-after': '1' });
    const waits: number[] = [];
    await host(FAKE_TOKEN, { sleep: async (ms: number) => void waits.push(ms) }).postStatus('acme/shop', 'abc', status);
    expect(gh.statuses).toHaveLength(1);
    expect(waits).toHaveLength(2);
    expect(waits[1]).toBe(1000);
  });

  test('gives up after three attempts; a retryable error says so', async () => {
    gh.failNext(503, 3);
    const err = await host()
      .postStatus('acme/shop', 'abc', status)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CodeHostError);
    expect((err as CodeHostError).retryable).toBe(true);
    expect(gh.requests).toHaveLength(3);
  });

  test('a 4xx is not retried, and no error ever contains the token', async () => {
    const err = (await host('ghp_wrong_token_9876')
      .postStatus('acme/shop', 'abc', status)
      .catch((e: unknown) => e)) as CodeHostError;
    expect(err).toBeInstanceOf(CodeHostError);
    expect(err.status).toBe(401);
    expect(err.retryable).toBe(false);
    expect(err.message).toContain('Bad credentials');
    expect(err.message).not.toContain('ghp_wrong_token_9876');
    expect(JSON.stringify(err)).not.toContain('ghp_wrong_token_9876');
    expect(gh.requests).toHaveLength(1);
  });

  test('a request that takes too long times out and is retried', async () => {
    gh.delay(300);
    const err = (await host(FAKE_TOKEN, { timeoutMs: 50 })
      .postStatus('acme/shop', 'abc', status)
      .catch((e: unknown) => e)) as CodeHostError;
    expect(err).toBeInstanceOf(CodeHostError);
    expect(err.message).toContain('timed out');
    expect(err.retryable).toBe(true);
  });

  test('a comment is created once, then found by its marker or id and edited in place', async () => {
    const marker = '<!-- pixeltwin:build:bld_1 -->';
    const id = await host().upsertComment('acme/shop', 42, marker, `${marker}\nfirst`, null);
    expect([...gh.comments.values()]).toEqual([
      { id: Number(id), repo: 'acme/shop', pr: 42, body: `${marker}\nfirst` },
    ]);
    // Known id: edited directly.
    expect(await host().upsertComment('acme/shop', 42, marker, `${marker}\nsecond`, id)).toBe(id);
    // Id lost: found by the marker among the pull request's comments.
    expect(await host().upsertComment('acme/shop', 42, marker, `${marker}\nthird`, null)).toBe(id);
    // The stored id points at a deleted comment: a new one is made.
    gh.comments.delete(Number(id));
    const fresh = await host().upsertComment('acme/shop', 42, marker, `${marker}\nfourth`, id);
    expect(fresh).not.toBe(id);
    expect(gh.comments.size).toBe(1);
    expect(gh.comments.get(Number(fresh))?.body).toContain('fourth');
  });
});

describe('GitLab adapter', () => {
  let gl: FakeGitLab;
  const host = (token = FAKE_GITLAB_TOKEN) => gitlabHost({ baseUrl: gl.url, token }, { sleep: noSleep });

  beforeEach(() => {
    gl = startFakeGitLab();
  });

  afterEach(() => {
    gl.stop();
  });

  test('posts a commit status to the URL-encoded project path; failure is "failed"', async () => {
    await host().postStatus('group/sub/shop', 'abc123', status);
    await host().postStatus('group/sub/shop', 'abc123', { ...status, state: 'failure', description: '1 rejected' });
    expect(gl.statuses).toEqual([
      {
        repo: 'group/sub/shop',
        sha: 'abc123',
        state: 'pending',
        name: 'pixeltwin/web',
        description: '2 screenshots to review',
        target_url: 'http://pt/ui/builds/bld_1',
      },
      expect.objectContaining({ state: 'failed', description: '1 rejected' }),
    ]);
    expect(gl.requests[0]?.path).toBe('/api/v4/projects/group%2Fsub%2Fshop/statuses/abc123');
    expect(gl.requests[0]?.token).toBe(FAKE_GITLAB_TOKEN);
  });

  test('the same state again is not an error (GitLab refuses that transition)', async () => {
    await host().postStatus('group/shop', 'abc', status);
    await host().postStatus('group/shop', 'abc', { ...status, description: '1 screenshot to review' });
    expect(gl.statuses).toHaveLength(1);
  });

  test('a merge request note is created once and edited in place; the token never leaks', async () => {
    const marker = '<!-- pixeltwin:build:bld_9 -->';
    const id = await host().upsertComment('group/shop', 7, marker, `${marker}\none`, null);
    expect(await host().upsertComment('group/shop', 7, marker, `${marker}\ntwo`, null)).toBe(id);
    expect(await host().upsertComment('group/shop', 7, marker, `${marker}\nthree`, id)).toBe(id);
    expect([...gl.notes.values()]).toEqual([{ id: Number(id), repo: 'group/shop', pr: 7, body: `${marker}\nthree` }]);

    const err = (await host('glpat-wrong-0000')
      .postStatus('group/shop', 'abc', status)
      .catch((e: unknown) => e)) as CodeHostError;
    expect(err.status).toBe(401);
    expect(err.message).toContain('GitLab answered 401');
    expect(err.message).not.toContain('glpat-wrong-0000');
  });

  test('retries a 5xx', async () => {
    gl.failNext(500, 2);
    await host().postStatus('group/shop', 'def', status);
    expect(gl.statuses).toHaveLength(1);
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
