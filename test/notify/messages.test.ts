import { describe, expect, test } from 'bun:test';
import type { BuildView } from '../../src/domain/builds';
import { emptyCounts, type Verdict } from '../../src/domain/verdict';
import {
  buildPayload,
  type CommentCheck,
  commentMarker,
  commitStatusFor,
  prComment,
  slackMessage,
  type WebhookPayload,
} from '../../src/notify/messages';

const project = { id: 'prj_1', slug: 'web', name: 'Web shop' };
const URL = 'https://pt.example.com';

function build(
  verdict: Verdict,
  counts: Partial<{
    unchanged: number;
    changed: number;
    new: number;
    error: number;
    pending: number;
    approved: number;
    rejected: number;
    auto: number;
  }> = {},
): BuildView {
  const c = emptyCounts();
  c.result.unchanged = counts.unchanged ?? 0;
  c.result.changed = counts.changed ?? 0;
  c.result.new = counts.new ?? 0;
  c.result.error = counts.error ?? 0;
  c.review.pending = counts.pending ?? 0;
  c.review.approved = counts.approved ?? 0;
  c.review.rejected = counts.rejected ?? 0;
  c.autoApproved = counts.auto ?? 0;
  c.total = c.result.unchanged + c.result.changed + c.result.new + c.result.error;
  return {
    id: 'bld_1',
    projectId: 'prj_1',
    number: 12,
    branch: 'feature/login',
    baseBranch: 'main',
    externalId: null,
    commitSha: 'abcdef1234567',
    repository: 'acme/shop',
    pullRequest: 42,
    state: 'finalized',
    createdAt: 0,
    finalizedAt: 1,
    parallelTotal: null,
    partsFinished: 0,
    timing: { checks: 0, screenshotMs: 0, uploadMs: 0, retakes: 0, compareMs: 0 },
    verdict,
    counts: c,
  };
}

describe('commit status', () => {
  test('pending while screenshots wait, success when passed, failure on rejected or error', () => {
    expect(commitStatusFor(build('pending', { changed: 2, new: 1, unchanged: 5, pending: 3 }), project, URL)).toEqual({
      state: 'pending',
      description: '3 screenshots to review',
      context: 'pixeltwin/web',
      targetUrl: 'https://pt.example.com/ui/builds/bld_1',
    });
    expect(commitStatusFor(build('pending', { changed: 1, pending: 1 }), project, URL).description).toBe(
      '1 screenshot to review',
    );
    expect(commitStatusFor(build('passed', { unchanged: 40, changed: 1, approved: 1 }), project, URL)).toMatchObject({
      state: 'success',
      description: '41 screenshots passed (1 approved)',
    });
    expect(commitStatusFor(build('passed', { unchanged: 3 }), project, URL).description).toBe('3 screenshots passed');
    expect(commitStatusFor(build('rejected', { changed: 2, rejected: 2 }), project, URL)).toMatchObject({
      state: 'failure',
      description: '2 screenshots rejected',
    });
    expect(commitStatusFor(build('error', { error: 1 }), project, URL)).toMatchObject({
      state: 'failure',
      description: '1 screenshot could not be compared',
    });
    expect(commitStatusFor(build('outdated'), project, URL)).toMatchObject({ state: 'success' });
    expect(commitStatusFor(build('empty'), project, URL)).toMatchObject({
      state: 'success',
      description: 'No screenshots in this build',
    });
  });
});

describe('pull request comment', () => {
  const checks: CommentCheck[] = [
    {
      id: 'chk_1',
      name: 'login',
      variant: { browser: 'chromium', viewport: '1280x720' },
      result: 'changed' as const,
      review: 'pending' as const,
    },
    {
      id: 'chk_2',
      name: 'cart | <b>evil</b> [x](y)',
      variant: {},
      result: 'new' as const,
      review: 'approved' as const,
    },
  ];

  test('starts with the hidden marker, links the build and each screen, escapes names', () => {
    const body = prComment(
      build('pending', { changed: 1, new: 1, unchanged: 38, pending: 1, approved: 1 }),
      project,
      URL,
      {
        items: checks,
        total: 8,
      },
    );
    expect(body.startsWith(commentMarker('bld_1'))).toBe(true);
    expect(commentMarker('bld_1')).toBe('<!-- pixeltwin:build:bld_1 -->');
    expect(body).toContain('[build #12](https://pt.example.com/ui/builds/bld_1)');
    expect(body).toContain('1 screenshot waits for review');
    expect(body).toContain('[login](https://pt.example.com/ui/checks/chk_1)');
    expect(body).toContain('chromium, 1280x720');
    expect(body).toContain('changed · waiting for review');
    expect(body).not.toContain('<b>');
    expect(body).toContain('cart \\| &lt;b&gt;evil&lt;/b&gt; \\[x\\]\\(y\\)');
    expect(body).toContain('…and 6 more');
  });

  test('says when everything passed and lists nothing then', () => {
    const body = prComment(build('passed', { unchanged: 10 }), project, URL, { items: [], total: 0 });
    expect(body).toContain('Passed');
    expect(body).not.toContain('| Screen |');
  });
});

describe('webhook payloads', () => {
  test('a stable JSON shape with links', () => {
    expect(buildPayload(build('pending', { changed: 1, pending: 1 }), URL)).toEqual({
      id: 'bld_1',
      number: 12,
      branch: 'feature/login',
      baseBranch: 'main',
      commitSha: 'abcdef1234567',
      repository: 'acme/shop',
      pullRequest: 42,
      state: 'finalized',
      verdict: 'pending',
      counts: {
        total: 1,
        unchanged: 0,
        changed: 1,
        new: 0,
        error: 0,
        pending: 1,
        approved: 0,
        rejected: 0,
        outdated: 0,
      },
      url: 'https://pt.example.com/ui/builds/bld_1',
    });
  });

  test('Slack: a text fallback and blocks, with Slack escaping', () => {
    const payload: WebhookPayload = {
      id: 'dlv_1',
      event: 'build.verdict_changed',
      createdAt: 0,
      project: { ...project, name: 'Web <shop> & co' },
      build: { ...buildPayload(build('passed', { unchanged: 3 }), URL), previousVerdict: 'pending' },
    };
    const message = slackMessage(payload);
    expect(message.text).toContain('Web &lt;shop&gt; &amp; co');
    expect(message.text).toContain('build #12');
    expect(message.text).toContain('passed');
    expect(JSON.stringify(message.blocks)).toContain('<https://pt.example.com/ui/builds/bld_1|Build #12>');
    const reviewed = slackMessage({
      id: 'dlv_2',
      event: 'check.reviewed',
      createdAt: 0,
      project,
      build: buildPayload(build('pending', { changed: 1, pending: 1 }), URL),
      check: {
        id: 'chk_1',
        name: 'login',
        variant: { browser: 'chromium' },
        result: 'changed',
        review: 'approved',
        url: `${URL}/ui/checks/chk_1`,
      },
      review: {
        action: 'approved',
        reason: 'The new <Sign in> button is intended',
        reasonCode: null,
        actor: { id: 'usr_1', kind: 'user', name: 'alice@example.com' },
      },
    });
    expect(reviewed.text).toContain('login (chromium) approved by alice@example.com');
    expect(JSON.stringify(reviewed.blocks)).toContain('\\n>The new &lt;Sign in&gt; button is intended');
    expect(slackMessage({ id: 'dlv_3', event: 'ping', createdAt: 0, project }).text).toContain('test');
  });
});
