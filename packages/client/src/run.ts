// The run lifecycle shared by the framework integrations: settings from options and environment,
// one build per run, finalize once, summary, gate. Node only (process.env, .git/HEAD).
import { readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { PixeltwinClient } from './client.js';
import { PixeltwinError, PixeltwinGateError } from './errors.js';
import { formatMs } from './timing.js';
import type { Build, Check, ScreenRejections } from './types.js';

type Env = Record<string, string | undefined>;

/** Options in code; each falls back to its environment variable (see the README). */
export interface PixeltwinOptions {
  /** `PIXELTWIN_URL`, default `http://localhost:8080`. */
  url?: string;
  /** `PIXELTWIN_TOKEN`: a project token with `read` and `write`. */
  token?: string;
  /** `PIXELTWIN_PROJECT`: the project slug. */
  project?: string;
  /** `PIXELTWIN_BRANCH`; else the CI branch, else `.git/HEAD`, else the project's main branch. */
  branch?: string;
  /** `PIXELTWIN_BASE_BRANCH`; else the pull request's target branch, else the project's main branch. */
  baseBranch?: string;
  /**
   * `PIXELTWIN_COMMIT_SHA`; else the pull request's head commit (GitHub Actions `pull_request` events),
   * `GITHUB_SHA` or `CI_COMMIT_SHA`.
   */
  commitSha?: string;
  /** `PIXELTWIN_REPOSITORY`: `owner/name`; else `GITHUB_REPOSITORY` / `CI_PROJECT_PATH`. */
  repository?: string;
  /** `PIXELTWIN_PULL_REQUEST`: the pull request number; else from the GitHub event / `CI_MERGE_REQUEST_IID`. */
  pullRequest?: number;
  /** `PIXELTWIN_EXTERNAL_ID`: every process or shard with the same id posts to the same build. */
  externalId?: string;
  /** `PIXELTWIN_GATE=1`: fail the run unless the verdict is `passed`. */
  gate?: boolean;
  /** `PIXELTWIN_WAIT`: seconds to wait for reviews while the verdict is `pending`. Default 0. */
  waitSeconds?: number;
  /** `PIXELTWIN_FINALIZE=0`: leave the build open (another step finalizes). Default: on unless sharded. */
  finalize?: boolean;
  /** `PIXELTWIN_DISABLED=1`: take no screenshots, post nothing. */
  disabled?: boolean;
  /** Request retries (default 3) and per-attempt timeout (default 60 s). */
  retries?: number;
  timeoutMs?: number;
  /**
   * `PIXELTWIN_RETAKES`: further screenshots, `retakeIntervalMs` apart (`PIXELTWIN_RETAKE_INTERVAL_MS`,
   * default 1000), while a check comes back `changed` (the page may still be loading). Default 0.
   */
  retakes?: number;
  retakeIntervalMs?: number;
  /**
   * `PIXELTWIN_FAIL_ON_CHANGE=1`: a check that is not `unchanged` throws PixeltwinCheckError, so its
   * test fails at once (by default the build verdict and the gate decide at the end).
   */
  failOnChange?: boolean;
  /**
   * `PIXELTWIN_ALLOW_OFFLINE=1`: when the build cannot be opened (server down, bad token), the run
   * goes on and each check fails with the reason, instead of the run stopping before any test.
   */
  allowOffline?: boolean;
  /**
   * `PIXELTWIN_PARALLEL_TOTAL`: several CI jobs post to one build (same externalId, the CI run id by
   * default). Each finalizes its part; the last one finalizes the build, prints the summary and gates.
   */
  parallelTotal?: number;
  /** `PIXELTWIN_PARALLEL_PART`: this job's part id. Default: the CI job id (GitLab), else a random id. */
  parallelPart?: string;
  /**
   * `PIXELTWIN_ELEMENTS=0`: send no page elements with the screenshots. By default the SDKs send the
   * boxes of the visible elements (test ids, roles, text) so the diff can name what changed.
   */
  elements?: boolean;
}

export interface Settings {
  url: string;
  token: string;
  project: string;
  branch: string | undefined;
  baseBranch: string | undefined;
  commitSha: string | undefined;
  repository: string | undefined;
  pullRequest: number | undefined;
  /** Only when given explicitly; see `externalIdFor`. */
  externalId: string | undefined;
  gate: boolean;
  waitSeconds: number;
  finalize: boolean | undefined;
  disabled: boolean;
  retries: number | undefined;
  timeoutMs: number | undefined;
  retakes: number;
  retakeIntervalMs: number;
  failOnChange: boolean;
  allowOffline: boolean;
  parallelTotal: number | undefined;
  parallelPart: string | undefined;
  elements: boolean;
}

export interface CiInfo {
  /** Same for every job and shard of one CI run (attempt). */
  runId?: string;
  /** This job only (GitLab `CI_JOB_ID`). */
  jobId?: string;
  branch?: string;
  baseBranch?: string;
  commitSha?: string;
  /** `owner/name` (GitLab: the project path). */
  repository?: string;
  pullRequest?: number;
}

const TRUE = new Set(['1', 'true', 'yes', 'on']);
const FALSE = new Set(['0', 'false', 'no', 'off']);

function flag(value: string | undefined): boolean | undefined {
  if (value === undefined || value === '') return undefined;
  const v = value.trim().toLowerCase();
  if (TRUE.has(v)) return true;
  if (FALSE.has(v)) return false;
  return undefined;
}

function text(value: string | undefined): string | undefined {
  const v = value?.trim();
  return v ? v : undefined;
}

function positive(value: number | string | undefined): number | undefined {
  const n = Number(value);
  return value !== undefined && value !== '' && Number.isInteger(n) && n >= 1 ? n : undefined;
}

/**
 * The pull request of a GitHub Actions run: number and head commit from the event file of a
 * `pull_request` (or `pull_request_target`) event, else the number from `refs/pull/<n>/merge`.
 */
function githubPullRequest(env: Env): { number?: number; headSha?: string } {
  const fromRef = positive(/^refs\/pull\/(\d+)\//.exec(env.GITHUB_REF ?? '')?.[1]);
  if (!env.GITHUB_EVENT_NAME?.startsWith('pull_request') || !env.GITHUB_EVENT_PATH) {
    return fromRef ? { number: fromRef } : {};
  }
  try {
    const event = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, 'utf8')) as {
      pull_request?: { number?: number; head?: { sha?: string } };
    };
    const number = positive(event.pull_request?.number) ?? fromRef;
    const headSha = text(event.pull_request?.head?.sha);
    return { ...(number ? { number } : {}), ...(headSha ? { headSha } : {}) };
  } catch {
    return fromRef ? { number: fromRef } : {};
  }
}

/** Branch, base branch, commit, pull request and run id from GitHub Actions, GitLab CI or `CI_RUN_ID`. */
export function ciInfo(env: Env = process.env): CiInfo {
  if (env.GITHUB_ACTIONS === 'true') {
    // On a pull_request event GITHUB_SHA is a merge commit GitHub made for the run; the pull
    // request shows statuses of its head commit.
    const pr = githubPullRequest(env);
    return {
      runId: env.GITHUB_RUN_ID ? `github-${env.GITHUB_RUN_ID}-${env.GITHUB_RUN_ATTEMPT ?? '1'}` : text(env.CI_RUN_ID),
      branch: text(env.GITHUB_HEAD_REF) ?? text(env.GITHUB_REF_NAME),
      baseBranch: text(env.GITHUB_BASE_REF),
      commitSha: pr.headSha ?? text(env.GITHUB_SHA),
      repository: text(env.GITHUB_REPOSITORY),
      pullRequest: pr.number,
    };
  }
  if (env.GITLAB_CI === 'true') {
    return {
      runId: env.CI_PIPELINE_ID ? `gitlab-${env.CI_PIPELINE_ID}` : text(env.CI_RUN_ID),
      ...(text(env.CI_JOB_ID) ? { jobId: text(env.CI_JOB_ID) } : {}),
      branch: text(env.CI_MERGE_REQUEST_SOURCE_BRANCH_NAME) ?? text(env.CI_COMMIT_REF_NAME),
      baseBranch: text(env.CI_MERGE_REQUEST_TARGET_BRANCH_NAME),
      commitSha: text(env.CI_MERGE_REQUEST_SOURCE_BRANCH_SHA) ?? text(env.CI_COMMIT_SHA),
      repository: text(env.CI_PROJECT_PATH),
      pullRequest: positive(env.CI_MERGE_REQUEST_IID),
    };
  }
  return { runId: text(env.CI_RUN_ID) };
}

/** The checked-out branch from `.git/HEAD` (also in a worktree); undefined when detached or no repo. */
export function gitBranch(cwd: string = process.cwd()): string | undefined {
  let dir = resolve(cwd);
  for (;;) {
    const dotGit = join(dir, '.git');
    try {
      let gitDir = dotGit;
      if (statSync(dotGit).isFile()) {
        const target = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGit, 'utf8'))?.[1]?.trim();
        if (!target) return undefined;
        gitDir = isAbsolute(target) ? target : join(dir, target);
      }
      const head = readFileSync(join(gitDir, 'HEAD'), 'utf8');
      return /^ref:\s*refs\/heads\/(.+)$/m.exec(head)?.[1]?.trim();
    } catch {
      const parent = dirname(dir);
      if (parent === dir) return undefined;
      dir = parent;
    }
  }
}

function partCount(value: number | string | undefined): number | undefined {
  const n = Number(value);
  return value !== undefined && Number.isInteger(n) && n >= 1 ? n : undefined;
}

/** Options win over environment variables, which win over CI detection and defaults. */
export function resolveSettings(options: PixeltwinOptions = {}, env: Env = process.env, cwd?: string): Settings {
  const ci = ciInfo(env);
  const wait = options.waitSeconds ?? Number(text(env.PIXELTWIN_WAIT) ?? 0);
  const count = (value: number | undefined, envValue: string | undefined, fallback: number) => {
    const n = value ?? Number(text(envValue) ?? fallback);
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
  };
  return {
    url: (options.url ?? text(env.PIXELTWIN_URL) ?? 'http://localhost:8080').replace(/\/+$/, ''),
    token: options.token ?? text(env.PIXELTWIN_TOKEN) ?? '',
    project: options.project ?? text(env.PIXELTWIN_PROJECT) ?? '',
    branch: options.branch ?? text(env.PIXELTWIN_BRANCH) ?? ci.branch ?? gitBranch(cwd),
    baseBranch: options.baseBranch ?? text(env.PIXELTWIN_BASE_BRANCH) ?? ci.baseBranch,
    commitSha: options.commitSha ?? text(env.PIXELTWIN_COMMIT_SHA) ?? ci.commitSha,
    repository: options.repository ?? text(env.PIXELTWIN_REPOSITORY) ?? ci.repository,
    pullRequest: positive(options.pullRequest) ?? positive(text(env.PIXELTWIN_PULL_REQUEST)) ?? ci.pullRequest,
    externalId: options.externalId ?? text(env.PIXELTWIN_EXTERNAL_ID),
    gate: options.gate ?? flag(env.PIXELTWIN_GATE) ?? false,
    waitSeconds: Number.isFinite(wait) && wait > 0 ? wait : 0,
    finalize: options.finalize ?? flag(env.PIXELTWIN_FINALIZE),
    disabled: options.disabled ?? flag(env.PIXELTWIN_DISABLED) ?? false,
    retries: options.retries,
    timeoutMs: options.timeoutMs,
    retakes: count(options.retakes, env.PIXELTWIN_RETAKES, 0),
    retakeIntervalMs: count(options.retakeIntervalMs, env.PIXELTWIN_RETAKE_INTERVAL_MS, 1000),
    failOnChange: options.failOnChange ?? flag(env.PIXELTWIN_FAIL_ON_CHANGE) ?? false,
    allowOffline: options.allowOffline ?? flag(env.PIXELTWIN_ALLOW_OFFLINE) ?? false,
    parallelTotal: partCount(options.parallelTotal ?? text(env.PIXELTWIN_PARALLEL_TOTAL)),
    parallelPart: options.parallelPart ?? text(env.PIXELTWIN_PARALLEL_PART),
    elements: options.elements ?? flag(env.PIXELTWIN_ELEMENTS) ?? true,
  };
}

/**
 * Environment variables carrying the options to other processes (Playwright workers load the
 * config again; the CLI reads the same variables).
 */
export function optionsToEnv(options: PixeltwinOptions): Record<string, string> {
  const out: Record<string, string> = {};
  const set = (key: string, value: string | number | boolean | undefined) => {
    if (value === undefined) return;
    out[key] = typeof value === 'boolean' ? (value ? '1' : '0') : String(value);
  };
  set('PIXELTWIN_URL', options.url);
  set('PIXELTWIN_TOKEN', options.token);
  set('PIXELTWIN_PROJECT', options.project);
  set('PIXELTWIN_BRANCH', options.branch);
  set('PIXELTWIN_BASE_BRANCH', options.baseBranch);
  set('PIXELTWIN_COMMIT_SHA', options.commitSha);
  set('PIXELTWIN_REPOSITORY', options.repository);
  set('PIXELTWIN_PULL_REQUEST', options.pullRequest);
  set('PIXELTWIN_RETAKES', options.retakes);
  set('PIXELTWIN_RETAKE_INTERVAL_MS', options.retakeIntervalMs);
  set('PIXELTWIN_FAIL_ON_CHANGE', options.failOnChange);
  set('PIXELTWIN_ALLOW_OFFLINE', options.allowOffline);
  set('PIXELTWIN_EXTERNAL_ID', options.externalId);
  set('PIXELTWIN_GATE', options.gate);
  set('PIXELTWIN_WAIT', options.waitSeconds);
  set('PIXELTWIN_FINALIZE', options.finalize);
  set('PIXELTWIN_DISABLED', options.disabled);
  set('PIXELTWIN_PARALLEL_TOTAL', options.parallelTotal);
  set('PIXELTWIN_PARALLEL_PART', options.parallelPart);
  set('PIXELTWIN_ELEMENTS', options.elements);
  return out;
}

function random(): string {
  return Math.random().toString(36).slice(2, 10);
}

/**
 * The build's `externalId`. Explicit wins. Shards share the CI run id (and fail without one);
 * a single run gets a unique id, so two CI jobs never share a build by accident.
 */
export function externalIdFor(settings: Pick<Settings, 'externalId'>, env: Env, sharded: boolean): string {
  if (settings.externalId) return settings.externalId;
  const { runId } = ciInfo(env);
  if (sharded) {
    if (runId) return runId;
    throw new Error(
      'pixeltwin: a sharded run needs one build id for every shard. Set PIXELTWIN_EXTERNAL_ID to the same ' +
        'value in each shard (GitHub Actions and GitLab CI are detected automatically).',
    );
  }
  return `${runId ?? 'local'}-${random()}`;
}

/** The repository and pull request to send when opening a build (only those known). */
export function linkOf(settings: Pick<Settings, 'repository' | 'pullRequest'>): {
  repository?: string;
  pullRequest?: number;
} {
  return {
    ...(settings.repository ? { repository: settings.repository } : {}),
    ...(settings.pullRequest ? { pullRequest: settings.pullRequest } : {}),
  };
}

export function clientFor(settings: Settings): PixeltwinClient {
  if (!settings.token) {
    throw new Error(
      'pixeltwin: set PIXELTWIN_TOKEN to a project token with read and write scopes (or PIXELTWIN_DISABLED=1).',
    );
  }
  if (!settings.project) throw new Error('pixeltwin: set PIXELTWIN_PROJECT to the project slug.');
  return new PixeltwinClient({
    url: settings.url,
    token: settings.token,
    retries: settings.retries,
    timeoutMs: settings.timeoutMs,
  });
}

export interface RunContext {
  /** True when this process runs one shard of several (it must not finalize). */
  sharded?: boolean;
  /** Where the summary goes. Default `console.log`. */
  log?: (line: string) => void;
  /** Read and written: `PIXELTWIN_BUILD_ID` and `PIXELTWIN_EXTERNAL_ID` go here for the workers. */
  env?: Env;
}

export interface StartedRun {
  /** Null when pixeltwin is disabled. */
  build: Build | null;
  /** Puts back the environment variables `startRun` set (a watch mode may start another run). */
  restoreEnv(): void;
}

/** Set by `startRun` with `allowOffline` when no build could be opened: the reason. */
const OFFLINE_ENV = 'PIXELTWIN_OFFLINE';

/**
 * The run's build id, for a check in a worker. Without one it throws: the reason the build could
 * not be opened (`allowOffline`), else `hint` (how to set the integration up).
 */
export function runBuildId(hint: string, env: Env = process.env): string {
  const id = text(env.PIXELTWIN_BUILD_ID);
  if (id) return id;
  const offline = text(env[OFFLINE_ENV]);
  throw new Error(offline ? `pixeltwin: no build for this run: ${offline}` : hint);
}

/** Opens (or reuses) the run's build and publishes its id in `env.PIXELTWIN_BUILD_ID`. */
export async function startRun(settings: Settings, context: RunContext = {}): Promise<StartedRun> {
  const env = context.env ?? process.env;
  const log = context.log ?? console.log;
  const saved = new Map<string, string | undefined>();
  const setEnv = (key: string, value: string) => {
    if (!saved.has(key)) saved.set(key, env[key]);
    env[key] = value;
  };
  const restoreEnv = () => {
    for (const [key, value] of saved) {
      if (value === undefined) delete env[key];
      else env[key] = value;
    }
    saved.clear();
  };
  if (settings.disabled) {
    setEnv('PIXELTWIN_DISABLED', '1');
    log('pixeltwin: disabled (PIXELTWIN_DISABLED); no screenshots are posted.');
    return { build: null, restoreEnv };
  }
  try {
    return await openRun(settings, context, env, log, setEnv, restoreEnv);
  } catch (err) {
    if (!settings.allowOffline) throw err;
    // The run goes on without a build; every check then fails with this reason.
    const reason = err instanceof Error ? err.message : String(err);
    setEnv(OFFLINE_ENV, reason);
    log(`pixeltwin: could not open a build, so checks will fail (allowOffline): ${reason}`);
    return { build: null, restoreEnv };
  }
}

async function openRun(
  settings: Settings,
  context: RunContext,
  env: Env,
  log: (line: string) => void,
  setEnv: (key: string, value: string) => void,
  restoreEnv: () => void,
): Promise<StartedRun> {
  const client = clientFor(settings);
  const existing = text(env.PIXELTWIN_BUILD_ID);
  let build: Build;
  if (existing) {
    build = await client.getBuild(existing);
  } else {
    // The parts of a parallel build find each other by the CI run id, like shards.
    const externalId = externalIdFor(settings, env, (context.sharded ?? false) || isParallel(settings));
    build = await client.openBuild(settings.project, {
      branch: settings.branch,
      baseBranch: settings.baseBranch,
      commitSha: settings.commitSha,
      ...linkOf(settings),
      externalId,
      ...(settings.parallelTotal ? { parallelTotal: settings.parallelTotal } : {}),
    });
    setEnv('PIXELTWIN_EXTERNAL_ID', externalId);
  }
  if (build.state === 'finalized') {
    restoreEnv();
    throw new PixeltwinError({
      status: 409,
      code: 'build_finalized',
      detail:
        `Build #${build.number} (${build.id}, externalId ${build.externalId}) is already finalized. ` +
        'Use a new PIXELTWIN_EXTERNAL_ID for each attempt.',
      method: 'POST',
      path: `/projects/${settings.project}/builds`,
    });
  }
  setEnv('PIXELTWIN_BUILD_ID', build.id);
  log(`pixeltwin: build #${build.number} on ${build.branch} → ${client.buildUrl(build.id)}`);
  return { build, restoreEnv };
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

function variantText(check: Check): string {
  const values = Object.keys(check.variant)
    .sort()
    .map((k) => check.variant[k]);
  return values.length ? ` (${values.join(', ')})` : '';
}

/** Rejections as captured too early that make a screen worth a tip at the end of the run. */
export const TIP_AFTER = 2;
/** Tips printed at most; the rest are counted. */
const MAX_TIPS = 3;

function tipFor(screen: ScreenRejections): string {
  const notLoaded = screen.byCategory.not_loaded ?? 0;
  const late = screen.byCategory.late_asset ?? 0;
  const values = Object.keys(screen.variant)
    .sort()
    .map((k) => screen.variant[k]);
  const name = `'${screen.name}'${values.length ? ` (${values.join(', ')})` : ''}`;
  const why =
    notLoaded >= late
      ? `as not fully loaded${late ? ` (and ${late}× for a late image, banner or font)` : ''}`
      : `for an image, banner or font that loaded late${notLoaded ? ` (and ${notLoaded}× as not fully loaded)` : ''}`;
  const times = notLoaded >= late ? notLoaded : late;
  return `pixeltwin: tip: ${name} was rejected ${times}× ${why} — wait for it before the screenshot`;
}

/**
 * One line per screen of the build that people keep rejecting as captured too early (not_loaded,
 * late_asset), from one request (GET /builds/{id}/rejections). Never fails the run: an older
 * server, a token without read or a network error give no tips.
 */
export async function rejectionTips(client: PixeltwinClient, build: Build): Promise<string[]> {
  if (build.counts.total === 0) return [];
  let screens: ScreenRejections[];
  try {
    screens = (await client.buildRejections(build.id)).screens;
  } catch {
    return [];
  }
  const early = screens.filter((sc) => sc.tooEarly >= TIP_AFTER).sort((a, b) => b.tooEarly - a.tooEarly);
  const lines = early.slice(0, MAX_TIPS).map(tipFor);
  if (early.length > MAX_TIPS) lines.push(`pixeltwin: tip: … and ${plural(early.length - MAX_TIPS, 'more screen')}`);
  return lines;
}

/** Lines describing a build: verdict, counts, what waits for review or failed, and the link. */
export async function summaryLines(client: PixeltwinClient, build: Build): Promise<string[]> {
  const { result, review } = build.counts;
  const lines = [
    `pixeltwin: build #${build.number} on ${build.branch}: verdict ${build.verdict}`,
    `pixeltwin: ${plural(build.counts.total, 'check')}: ${result.unchanged} unchanged, ${result.changed} changed, ` +
      `${result.new} new, ${result.error} errors; ${review.pending} awaiting review`,
  ];
  const listed: Check[] = [];
  if (result.error > 0) listed.push(...(await client.listChecks(build.id, { result: 'error', limit: 20 })).items);
  if (review.pending > 0) listed.push(...(await client.listChecks(build.id, { review: 'pending', limit: 20 })).items);
  if (review.rejected > 0) listed.push(...(await client.listChecks(build.id, { review: 'rejected', limit: 20 })).items);
  for (const check of listed.slice(0, 20)) {
    const what = check.review === 'rejected' ? 'rejected' : check.result;
    lines.push(`pixeltwin:   ${what.padEnd(9)} ${check.name}${variantText(check)}  ${client.checkUrl(check)}`);
  }
  const more = result.error + review.pending + review.rejected - Math.min(listed.length, 20);
  if (more > 0) lines.push(`pixeltwin:   … and ${more} more`);
  const t = build.timing;
  if (t && t.checks > 0) {
    const total = t.screenshotMs + t.uploadMs + t.compareMs;
    lines.push(
      `pixeltwin: ${formatMs(total)} over ${plural(t.checks, 'check')} (${formatMs(total / t.checks)} each): ` +
        `screenshots ${formatMs(t.screenshotMs)}, upload ${formatMs(t.uploadMs)}, compare ${formatMs(t.compareMs)}; ` +
        plural(t.retakes, 'retake'),
    );
  }
  lines.push(...(await rejectionTips(client, build)));
  lines.push(`pixeltwin: review at ${client.buildUrl(build.id)}`);
  return lines;
}

function isParallel(settings: Pick<Settings, 'parallelTotal'>): boolean {
  return (settings.parallelTotal ?? 0) > 1;
}

/**
 * Ends the run: finalizes the build (unless this is one shard of several, or `finalize` is off),
 * waits for reviews if asked, prints the summary and applies the gate (throws `PixeltwinGateError`).
 * A part of a parallel build finalizes its part; only the last one gets the verdict and gates.
 */
export async function finishRun(
  settings: Settings,
  buildId: string,
  context: RunContext = {},
): Promise<{ build: Build; finalized: boolean }> {
  const log = context.log ?? console.log;
  const client = clientFor(settings);
  if (isParallel(settings) && settings.finalize !== false) {
    const part = settings.parallelPart ?? ciInfo(context.env ?? process.env).jobId ?? random();
    const build = await client.finalize(buildId, { part });
    if (build.state === 'open') {
      log(
        `pixeltwin: build #${build.number}: part ${build.partsFinished} of ${build.parallelTotal ?? '?'} finished ` +
          `(${part}); the last part prints the verdict. ${client.buildUrl(buildId)}`,
      );
      return { build, finalized: false };
    }
    return verdictOf(settings, client, build, log);
  }
  const finalize = settings.finalize ?? !context.sharded;
  if (!finalize) {
    const build = await client.getBuild(buildId);
    const why = context.sharded ? 'for the other shards' : '(finalize is off)';
    log(
      `pixeltwin: build #${build.number} left open ${why} with ${plural(build.counts.total, 'check')} so far. ` +
        'When every part is done, run `npx pixeltwin finalize` with the same environment.',
    );
    return { build, finalized: false };
  }
  return verdictOf(settings, client, await client.finalize(buildId), log);
}

/** After the build is finalized: waits for reviews if asked, prints the summary, applies the gate. */
async function verdictOf(
  settings: Settings,
  client: PixeltwinClient,
  finalized: Build,
  log: (line: string) => void,
): Promise<{ build: Build; finalized: boolean }> {
  let build = finalized;
  if (settings.waitSeconds > 0 && build.verdict === 'pending') {
    log(`pixeltwin: waiting up to ${settings.waitSeconds} s for reviews at ${client.buildUrl(build.id)}`);
    build = await client.waitForVerdict(build.id, { timeoutMs: settings.waitSeconds * 1000 });
  }
  for (const line of await summaryLines(client, build)) log(line);
  if (settings.gate && build.verdict !== 'passed') throw new PixeltwinGateError(build, client.buildUrl(build.id));
  return { build, finalized: true };
}
