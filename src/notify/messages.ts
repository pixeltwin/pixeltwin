import type { CheckResult, CheckReview, Project } from '../db/schema';
import type { BuildView } from '../domain/builds';
import type { Verdict } from '../domain/verdict';
import type { StatusUpdate } from './http';

// What pixeltwin says outside itself: the commit status, the pull (merge) request comment, the
// webhook JSON and its Slack form. Pure functions of a build's state, so they are easy to test and the
// same state always reads the same.

type ProjectRef = Pick<Project, 'id' | 'slug' | 'name'>;

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

export function buildUrl(publicUrl: string, buildId: string): string {
  return `${publicUrl}/ui/builds/${buildId}`;
}

export function checkUrl(publicUrl: string, checkId: string): string {
  return `${publicUrl}/ui/checks/${checkId}`;
}

/** Approvals by a person or token, not by the project's auto-approve-new setting. */
function approvedByPeople(build: BuildView): number {
  return build.counts.review.approved - build.counts.autoApproved;
}

/**
 * The `pixeltwin/<slug>` commit status (GitHub and GitLab alike): pending while screenshots wait for review, success when
 * passed (also when a newer build decided the screens, or there were none), failure when rejected
 * or a comparison failed.
 */
export function commitStatusFor(build: BuildView, project: Pick<Project, 'slug'>, publicUrl: string): StatusUpdate {
  const { counts } = build;
  const status = (state: StatusUpdate['state'], description: string): StatusUpdate => ({
    state,
    description: description.slice(0, 140),
    context: `pixeltwin/${project.slug}`,
    targetUrl: buildUrl(publicUrl, build.id),
  });
  switch (build.verdict) {
    case 'pending':
      return status('pending', `${plural(counts.review.pending, 'screenshot')} to review`);
    case 'passed': {
      const approved = approvedByPeople(build);
      return status(
        'success',
        `${plural(counts.total, 'screenshot')} passed${approved > 0 ? ` (${approved} approved)` : ''}`,
      );
    }
    case 'rejected':
      return status('failure', `${plural(counts.review.rejected, 'screenshot')} rejected`);
    case 'error':
      return status('failure', `${plural(counts.result.error, 'screenshot')} could not be compared`);
    case 'outdated':
      return status('success', 'A newer build decided these screens');
    case 'empty':
      return status('success', 'No screenshots in this build');
  }
}

/** One comment per build: found again by this hidden marker. */
export function commentMarker(buildId: string): string {
  return `<!-- pixeltwin:build:${buildId} -->`;
}

/** Markdown and HTML that a check name must not inject into the comment. */
function md(text: string): string {
  return text
    .replace(/[\\`*_[\]()#|~!]/g, (c) => `\\${c}`)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\r?\n/g, ' ');
}

export interface CommentCheck {
  id: string;
  name: string;
  variant: Record<string, string>;
  result: CheckResult;
  review: CheckReview;
}

const REVIEW_WORDS: Record<CheckReview, string> = {
  none: '',
  pending: 'waiting for review',
  approved: 'approved',
  rejected: 'rejected',
  outdated: 'outdated',
};

function verdictLine(build: BuildView): string {
  const { counts } = build;
  switch (build.verdict) {
    case 'pending': {
      const n = counts.review.pending;
      return `**${plural(n, 'screenshot waits', 'screenshots wait')} for review.** Approve or reject ${n === 1 ? 'it' : 'them'} in pixeltwin; this status follows.`;
    }
    case 'passed':
      return '**Passed.** Every screenshot matches its baseline or was approved.';
    case 'rejected':
      return `**Rejected.** ${plural(counts.review.rejected, 'screenshot was', 'screenshots were')} rejected.`;
    case 'error':
      return `**Error.** ${plural(counts.result.error, 'screenshot', 'screenshots')} could not be compared.`;
    case 'outdated':
      return '**Outdated.** A newer build decided these screens.';
    case 'empty':
      return '**No screenshots** were posted to this build.';
  }
}

function countsLine(build: BuildView): string {
  const { counts } = build;
  const parts: string[] = [];
  const add = (n: number, word: string) => n > 0 && parts.push(`${n} ${word}`);
  add(counts.result.changed, 'changed');
  add(counts.result.new, 'new');
  add(counts.result.error, counts.result.error === 1 ? 'error' : 'errors');
  add(counts.review.approved, 'approved');
  add(counts.review.rejected, 'rejected');
  add(counts.result.unchanged, 'unchanged');
  return parts.join(' · ');
}

/**
 * The pull request comment of a build: verdict, counts, and the screens that needed a person (at
 * most `checks.items`, the rest counted), each linked to its review page. No thumbnails: images
 * need a login, so GitHub could not show them.
 */
export function prComment(
  build: BuildView,
  project: Pick<Project, 'name'>,
  publicUrl: string,
  checks: { items: CommentCheck[]; total: number },
): string {
  const url = buildUrl(publicUrl, build.id);
  const lines = [
    commentMarker(build.id),
    `**pixeltwin · ${md(project.name)}** · [build #${build.number}](${url}) on \`${build.branch.replace(/`/g, "'")}\``,
    '',
    verdictLine(build),
  ];
  const counts = countsLine(build);
  if (counts) lines.push('', counts);
  if (checks.items.length > 0) {
    lines.push('', '| Screen | Variant | Status |', '| --- | --- | --- |');
    for (const check of checks.items) {
      const variant = Object.keys(check.variant)
        .sort()
        .map((k) => check.variant[k])
        .join(', ');
      const status = [check.result, REVIEW_WORDS[check.review]].filter(Boolean).join(' · ');
      lines.push(`| [${md(check.name)}](${checkUrl(publicUrl, check.id)}) | ${md(variant) || '—'} | ${status} |`);
    }
    const more = checks.total - checks.items.length;
    if (more > 0) lines.push('', `…and ${more} more.`);
  }
  lines.push('', `[Review in pixeltwin →](${url})`);
  return lines.join('\n');
}

export interface BuildPayload {
  id: string;
  number: number;
  branch: string;
  baseBranch: string;
  commitSha: string | null;
  repository: string | null;
  pullRequest: number | null;
  state: BuildView['state'];
  verdict: Verdict;
  /** Only in build.verdict_changed: the verdict announced before. */
  previousVerdict?: Verdict | null;
  counts: {
    total: number;
    unchanged: number;
    changed: number;
    new: number;
    error: number;
    pending: number;
    approved: number;
    rejected: number;
    outdated: number;
  };
  url: string;
}

export interface CheckPayload {
  id: string;
  name: string;
  variant: Record<string, string>;
  result: CheckResult;
  review: CheckReview;
  url: string;
}

/** The body of every webhook delivery (format `json`). Fields are only ever added. */
export interface WebhookPayload {
  /** The delivery id, also in X-Pixeltwin-Delivery: the same on every retry of this delivery. */
  id: string;
  event: string;
  createdAt: number;
  project: ProjectRef;
  build?: BuildPayload;
  check?: CheckPayload;
  review?: { action: 'approved' | 'rejected' | 'reset'; actor: { id: string; name: string } };
}

export function buildPayload(build: BuildView, publicUrl: string): BuildPayload {
  const { counts } = build;
  return {
    id: build.id,
    number: build.number,
    branch: build.branch,
    baseBranch: build.baseBranch,
    commitSha: build.commitSha,
    repository: build.repository,
    pullRequest: build.pullRequest,
    state: build.state,
    verdict: build.verdict,
    counts: {
      total: counts.total,
      unchanged: counts.result.unchanged,
      changed: counts.result.changed,
      new: counts.result.new,
      error: counts.result.error,
      pending: counts.review.pending,
      approved: counts.review.approved,
      rejected: counts.review.rejected,
      outdated: counts.review.outdated,
    },
    url: buildUrl(publicUrl, build.id),
  };
}

/** Slack's mrkdwn escaping. */
function slack(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const VERDICT_WORDS: Record<Verdict, string> = {
  empty: 'has no screenshots',
  error: 'has errors',
  rejected: 'was rejected',
  pending: 'needs review',
  outdated: 'is outdated',
  passed: 'passed',
};

/** A Slack-compatible message (`format: "slack"`): `text` for notifications, `blocks` to show. */
export function slackMessage(payload: WebhookPayload): { text: string; blocks: unknown[] } {
  const project = slack(payload.project.name);
  const build = payload.build;
  if (!build) {
    const text = `pixeltwin test message for project ${project}: this webhook works.`;
    return { text, blocks: [{ type: 'section', text: { type: 'mrkdwn', text } }] };
  }
  const where = `build #${build.number} on ${slack(build.branch)}`;
  const counts = [
    build.counts.pending > 0 ? `${build.counts.pending} to review` : '',
    build.counts.changed > 0 ? `${build.counts.changed} changed` : '',
    build.counts.new > 0 ? `${build.counts.new} new` : '',
    build.counts.rejected > 0 ? `${build.counts.rejected} rejected` : '',
    build.counts.error > 0 ? `${build.counts.error} errors` : '',
    `${build.counts.unchanged} unchanged`,
  ]
    .filter(Boolean)
    .join(' · ');
  let text = `pixeltwin · ${project}: ${where} ${VERDICT_WORDS[build.verdict]}`;
  let reviewed: string | null = null;
  if (payload.event === 'check.reviewed' && payload.check && payload.review) {
    const values = Object.keys(payload.check.variant)
      .sort()
      .map((k) => payload.check?.variant[k]);
    const variant = values.length > 0 ? ` (${slack(values.join(', '))})` : '';
    const action = payload.review.action === 'reset' ? 'sent back to review' : payload.review.action;
    const by = `${action} by ${slack(payload.review.actor.name)}`;
    text = `pixeltwin · ${project}: ${slack(payload.check.name)}${variant} ${by} in ${where}`;
    reviewed = `<${payload.check.url}|${slack(payload.check.name)}>${variant} ${by}`;
  }
  const context = [
    `pixeltwin · ${project}`,
    build.pullRequest ? `PR #${build.pullRequest}` : '',
    build.commitSha ? build.commitSha.slice(0, 7) : '',
  ]
    .filter(Boolean)
    .join(' · ');
  return {
    text,
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*<${build.url}|Build #${build.number}>* on \`${slack(build.branch)}\` ${VERDICT_WORDS[build.verdict]}\n${counts}`,
        },
      },
      ...(reviewed ? [{ type: 'section', text: { type: 'mrkdwn', text: reviewed } }] : []),
      { type: 'context', elements: [{ type: 'mrkdwn', text: context }] },
    ],
  };
}
