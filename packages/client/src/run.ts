// The run lifecycle shared by the framework integrations: settings from options and environment,
// one build per run, finalize once, summary, gate. Node only (process.env, .git/HEAD).
import { readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { PixeltwinClient } from './client.js';
import { PixeltwinError, PixeltwinGateError } from './errors.js';
import type { Build, Check } from './types.js';

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
  /** `PIXELTWIN_COMMIT_SHA`; else `GITHUB_SHA` / `CI_COMMIT_SHA`. */
  commitSha?: string;
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
}

export interface Settings {
  url: string;
  token: string;
  project: string;
  branch: string | undefined;
  baseBranch: string | undefined;
  commitSha: string | undefined;
  /** Only when given explicitly; see `externalIdFor`. */
  externalId: string | undefined;
  gate: boolean;
  waitSeconds: number;
  finalize: boolean | undefined;
  disabled: boolean;
  retries: number | undefined;
  timeoutMs: number | undefined;
}

export interface CiInfo {
  /** Same for every job and shard of one CI run (attempt). */
  runId?: string;
  branch?: string;
  baseBranch?: string;
  commitSha?: string;
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

/** Branch, base branch, commit and run id from GitHub Actions, GitLab CI or `CI_RUN_ID`. */
export function ciInfo(env: Env = process.env): CiInfo {
  if (env.GITHUB_ACTIONS === 'true') {
    return {
      runId: env.GITHUB_RUN_ID ? `github-${env.GITHUB_RUN_ID}-${env.GITHUB_RUN_ATTEMPT ?? '1'}` : text(env.CI_RUN_ID),
      branch: text(env.GITHUB_HEAD_REF) ?? text(env.GITHUB_REF_NAME),
      baseBranch: text(env.GITHUB_BASE_REF),
      commitSha: text(env.GITHUB_SHA),
    };
  }
  if (env.GITLAB_CI === 'true') {
    return {
      runId: env.CI_PIPELINE_ID ? `gitlab-${env.CI_PIPELINE_ID}` : text(env.CI_RUN_ID),
      branch: text(env.CI_MERGE_REQUEST_SOURCE_BRANCH_NAME) ?? text(env.CI_COMMIT_REF_NAME),
      baseBranch: text(env.CI_MERGE_REQUEST_TARGET_BRANCH_NAME),
      commitSha: text(env.CI_COMMIT_SHA),
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

/** Options win over environment variables, which win over CI detection and defaults. */
export function resolveSettings(options: PixeltwinOptions = {}, env: Env = process.env, cwd?: string): Settings {
  const ci = ciInfo(env);
  const wait = options.waitSeconds ?? Number(text(env.PIXELTWIN_WAIT) ?? 0);
  return {
    url: (options.url ?? text(env.PIXELTWIN_URL) ?? 'http://localhost:8080').replace(/\/+$/, ''),
    token: options.token ?? text(env.PIXELTWIN_TOKEN) ?? '',
    project: options.project ?? text(env.PIXELTWIN_PROJECT) ?? '',
    branch: options.branch ?? text(env.PIXELTWIN_BRANCH) ?? ci.branch ?? gitBranch(cwd),
    baseBranch: options.baseBranch ?? text(env.PIXELTWIN_BASE_BRANCH) ?? ci.baseBranch,
    commitSha: options.commitSha ?? text(env.PIXELTWIN_COMMIT_SHA) ?? ci.commitSha,
    externalId: options.externalId ?? text(env.PIXELTWIN_EXTERNAL_ID),
    gate: options.gate ?? flag(env.PIXELTWIN_GATE) ?? false,
    waitSeconds: Number.isFinite(wait) && wait > 0 ? wait : 0,
    finalize: options.finalize ?? flag(env.PIXELTWIN_FINALIZE),
    disabled: options.disabled ?? flag(env.PIXELTWIN_DISABLED) ?? false,
    retries: options.retries,
    timeoutMs: options.timeoutMs,
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
  set('PIXELTWIN_EXTERNAL_ID', options.externalId);
  set('PIXELTWIN_GATE', options.gate);
  set('PIXELTWIN_WAIT', options.waitSeconds);
  set('PIXELTWIN_FINALIZE', options.finalize);
  set('PIXELTWIN_DISABLED', options.disabled);
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
  const client = clientFor(settings);
  const existing = text(env.PIXELTWIN_BUILD_ID);
  let build: Build;
  if (existing) {
    build = await client.getBuild(existing);
  } else {
    const externalId = externalIdFor(settings, env, context.sharded ?? false);
    build = await client.openBuild(settings.project, {
      branch: settings.branch,
      baseBranch: settings.baseBranch,
      commitSha: settings.commitSha,
      externalId,
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

function variantText(check: Check): string {
  const values = Object.keys(check.variant)
    .sort()
    .map((k) => check.variant[k]);
  return values.length ? ` (${values.join(', ')})` : '';
}

/** Lines describing a build: verdict, counts, what waits for review or failed, and the link. */
export async function summaryLines(client: PixeltwinClient, build: Build): Promise<string[]> {
  const { result, review } = build.counts;
  const lines = [
    `pixeltwin: build #${build.number} on ${build.branch}: verdict ${build.verdict}`,
    `pixeltwin: ${build.counts.total} checks: ${result.unchanged} unchanged, ${result.changed} changed, ` +
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
  lines.push(`pixeltwin: review at ${client.buildUrl(build.id)}`);
  return lines;
}

/**
 * Ends the run: finalizes the build (unless this is one shard of several, or `finalize` is off),
 * waits for reviews if asked, prints the summary and applies the gate (throws `PixeltwinGateError`).
 */
export async function finishRun(
  settings: Settings,
  buildId: string,
  context: RunContext = {},
): Promise<{ build: Build; finalized: boolean }> {
  const log = context.log ?? console.log;
  const client = clientFor(settings);
  const finalize = settings.finalize ?? !context.sharded;
  if (!finalize) {
    const build = await client.getBuild(buildId);
    log(
      `pixeltwin: build #${build.number} left open for other shards (${build.counts.total} checks so far). ` +
        'After every shard, run `npx pixeltwin finalize` with the same environment.',
    );
    return { build, finalized: false };
  }
  let build = await client.finalize(buildId);
  if (settings.waitSeconds > 0 && build.verdict === 'pending') {
    log(`pixeltwin: waiting up to ${settings.waitSeconds} s for reviews at ${client.buildUrl(buildId)}`);
    build = await client.waitForVerdict(buildId, { timeoutMs: settings.waitSeconds * 1000 });
  }
  for (const line of await summaryLines(client, build)) log(line);
  if (settings.gate && build.verdict !== 'passed') throw new PixeltwinGateError(build, client.buildUrl(buildId));
  return { build, finalized: true };
}
