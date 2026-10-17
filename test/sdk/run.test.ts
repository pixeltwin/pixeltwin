import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Build, PixeltwinClient, PixeltwinError, PixeltwinGateError } from '@pixeltwin/client';
import {
  ciInfo,
  externalIdFor,
  finishRun,
  gitBranch,
  optionsToEnv,
  resolveSettings,
  startRun,
  summaryLines,
} from '@pixeltwin/client/run';
import { failsOnChange } from '../../packages/client/src/errors';
import type { Check } from '../../packages/client/src/types';
import { makePng, WHITE } from '../helpers/png';
import { REPO, startServer, type TestServer } from './server';

describe('settings', () => {
  test('options win over environment, environment over CI, CI over defaults', () => {
    const env = {
      PIXELTWIN_URL: 'http://env:1/',
      PIXELTWIN_TOKEN: 'pt_env',
      PIXELTWIN_PROJECT: 'env-project',
      PIXELTWIN_BRANCH: 'env-branch',
      PIXELTWIN_GATE: '1',
      PIXELTWIN_WAIT: '30',
      GITHUB_ACTIONS: 'true',
      GITHUB_REF_NAME: 'ci-branch',
      GITHUB_SHA: 'sha-from-ci',
    };
    const fromEnv = resolveSettings({}, env);
    expect(fromEnv).toMatchObject({
      url: 'http://env:1',
      token: 'pt_env',
      project: 'env-project',
      branch: 'env-branch',
      commitSha: 'sha-from-ci',
      gate: true,
      waitSeconds: 30,
      finalize: undefined,
      disabled: false,
    });
    const fromOptions = resolveSettings({ url: 'http://opt', branch: 'opt-branch', gate: false, waitSeconds: 0 }, env);
    expect(fromOptions).toMatchObject({ url: 'http://opt', branch: 'opt-branch', gate: false, waitSeconds: 0 });
    expect(resolveSettings({}, { ...env, PIXELTWIN_BRANCH: '' }).branch).toBe('ci-branch');
    const noRepo = mkdtempSync(join(tmpdir(), 'pixeltwin-nogit-'));
    const defaults = resolveSettings({}, {}, noRepo);
    rmSync(noRepo, { recursive: true, force: true });
    expect(defaults).toMatchObject({
      url: 'http://localhost:8080',
      token: '',
      branch: undefined,
      gate: false,
      waitSeconds: 0,
    });
    expect(resolveSettings({}, { PIXELTWIN_FINALIZE: '0', PIXELTWIN_DISABLED: 'true' })).toMatchObject({
      finalize: false,
      disabled: true,
    });
  });

  test('retakes, failOnChange and allowOffline come from options or the environment', () => {
    expect(resolveSettings({}, {})).toMatchObject({
      retakes: 0,
      retakeIntervalMs: 1000,
      failOnChange: false,
      allowOffline: false,
    });
    const env = {
      PIXELTWIN_RETAKES: '3',
      PIXELTWIN_RETAKE_INTERVAL_MS: '250',
      PIXELTWIN_FAIL_ON_CHANGE: '1',
      PIXELTWIN_ALLOW_OFFLINE: 'true',
    };
    expect(resolveSettings({}, env)).toMatchObject({
      retakes: 3,
      retakeIntervalMs: 250,
      failOnChange: true,
      allowOffline: true,
    });
    expect(resolveSettings({ retakes: 1, failOnChange: false }, env)).toMatchObject({
      retakes: 1,
      failOnChange: false,
    });
    expect(resolveSettings({}, { PIXELTWIN_RETAKES: 'many' }).retakes).toBe(0);
    expect(optionsToEnv({ retakes: 2, failOnChange: true, allowOffline: false })).toMatchObject({
      PIXELTWIN_RETAKES: '2',
      PIXELTWIN_FAIL_ON_CHANGE: '1',
      PIXELTWIN_ALLOW_OFFLINE: '0',
    });
  });

  test('CI detection: GitHub pull request, GitLab merge request, CI_RUN_ID', () => {
    expect(
      ciInfo({
        GITHUB_ACTIONS: 'true',
        GITHUB_RUN_ID: '42',
        GITHUB_RUN_ATTEMPT: '2',
        GITHUB_HEAD_REF: 'feature/x',
        GITHUB_REF_NAME: '17/merge',
        GITHUB_BASE_REF: 'main',
        GITHUB_SHA: 'abc',
      }),
    ).toEqual({ runId: 'github-42-2', branch: 'feature/x', baseBranch: 'main', commitSha: 'abc' });
    expect(
      ciInfo({
        GITLAB_CI: 'true',
        CI_PIPELINE_ID: '7',
        CI_COMMIT_REF_NAME: 'feature/y',
        CI_MERGE_REQUEST_TARGET_BRANCH_NAME: 'develop',
        CI_COMMIT_SHA: 'def',
        CI_JOB_ID: '901',
      }),
    ).toEqual({ runId: 'gitlab-7', jobId: '901', branch: 'feature/y', baseBranch: 'develop', commitSha: 'def' });
    expect(ciInfo({ CI_RUN_ID: 'run-9' })).toEqual({ runId: 'run-9' });
  });

  test('CI detection: the commit, repository and pull request a build reports on', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pixeltwin-event-'));
    try {
      // On a pull_request event GITHUB_SHA is a merge commit nobody pushed: the head commit is in the event.
      const event = join(dir, 'event.json');
      writeFileSync(event, JSON.stringify({ pull_request: { number: 42, head: { sha: 'head-sha' } } }));
      const github = {
        GITHUB_ACTIONS: 'true',
        GITHUB_EVENT_NAME: 'pull_request',
        GITHUB_EVENT_PATH: event,
        GITHUB_SHA: 'merge-sha',
        GITHUB_REPOSITORY: 'acme/shop',
        GITHUB_HEAD_REF: 'feature/login',
        GITHUB_BASE_REF: 'main',
      };
      expect(ciInfo(github)).toMatchObject({ commitSha: 'head-sha', repository: 'acme/shop', pullRequest: 42 });
      // A push: GITHUB_SHA is the commit, there is no pull request.
      expect(ciInfo({ ...github, GITHUB_EVENT_NAME: 'push' })).toMatchObject({
        commitSha: 'merge-sha',
        repository: 'acme/shop',
        pullRequest: undefined,
      });
      // An unreadable event file still gives the commit and the number from refs/pull/<n>/merge.
      expect(
        ciInfo({ ...github, GITHUB_EVENT_PATH: join(dir, 'missing.json'), GITHUB_REF: 'refs/pull/17/merge' }),
      ).toMatchObject({ commitSha: 'merge-sha', pullRequest: 17 });
      expect(
        ciInfo({
          GITLAB_CI: 'true',
          CI_COMMIT_SHA: 'gl-sha',
          CI_MERGE_REQUEST_IID: '9',
          CI_PROJECT_PATH: 'group/sub/shop',
        }),
      ).toMatchObject({ commitSha: 'gl-sha', repository: 'group/sub/shop', pullRequest: 9 });

      // Explicit options and PIXELTWIN_* variables win over CI.
      expect(resolveSettings({}, github)).toMatchObject({ repository: 'acme/shop', pullRequest: 42 });
      expect(
        resolveSettings({}, { ...github, PIXELTWIN_REPOSITORY: 'acme/web', PIXELTWIN_PULL_REQUEST: '43' }),
      ).toMatchObject({ repository: 'acme/web', pullRequest: 43 });
      expect(resolveSettings({ repository: 'x/y', pullRequest: 5 }, github)).toMatchObject({
        repository: 'x/y',
        pullRequest: 5,
      });
      expect(optionsToEnv({ repository: 'x/y', pullRequest: 5 })).toEqual({
        PIXELTWIN_REPOSITORY: 'x/y',
        PIXELTWIN_PULL_REQUEST: '5',
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('externalId: explicit, shared by shards, unique otherwise', () => {
    const gh = { GITHUB_ACTIONS: 'true', GITHUB_RUN_ID: '42', GITHUB_RUN_ATTEMPT: '1' };
    expect(externalIdFor({ externalId: 'mine' }, gh, true)).toBe('mine');
    expect(externalIdFor({ externalId: undefined }, gh, true)).toBe('github-42-1');
    const a = externalIdFor({ externalId: undefined }, gh, false);
    const b = externalIdFor({ externalId: undefined }, gh, false);
    expect(a).toStartWith('github-42-1-');
    expect(a).not.toBe(b);
    expect(externalIdFor({ externalId: undefined }, {}, false)).toStartWith('local-');
    expect(() => externalIdFor({ externalId: undefined }, {}, true)).toThrow('PIXELTWIN_EXTERNAL_ID');
  });

  test('the summary says how long pixeltwin took, when the SDK measured it', async () => {
    const counts = {
      total: 83,
      result: { unchanged: 83, changed: 0, new: 0, error: 0 },
      review: { none: 83, pending: 0, approved: 0, rejected: 0, outdated: 0 },
      autoApproved: 0,
    };
    const timing = { checks: 83, screenshotMs: 38_000, uploadMs: 41_000, retakes: 6, compareMs: 92_000 };
    const build = { id: 'bld_1', number: 7, branch: 'main', verdict: 'passed', counts, timing } as unknown as Build;
    const client = { buildUrl: (id: string) => `http://pt/ui/builds/${id}` } as unknown as PixeltwinClient;
    expect(await summaryLines(client, build)).toContain(
      'pixeltwin: 2m 51s over 83 checks (2.1 s each): screenshots 38 s, upload 41 s, compare 1m 32s; 6 retakes',
    );
    const untimed = { ...build, timing: { ...timing, checks: 0 } } as Build;
    expect((await summaryLines(client, untimed)).join('\n')).not.toContain(' over ');
  });

  test('the summary counts the unchanged checks that passed within the tolerance', async () => {
    const counts = {
      total: 9,
      result: { unchanged: 9, changed: 0, new: 0, error: 0 },
      review: { none: 9, pending: 0, approved: 0, rejected: 0, outdated: 0 },
      autoApproved: 0,
      withinTolerance: 2,
    };
    const build = { id: 'bld_1', number: 7, branch: 'main', verdict: 'passed', counts } as unknown as Build;
    const client = { buildUrl: (id: string) => `http://pt/ui/builds/${id}` } as unknown as PixeltwinClient;
    expect((await summaryLines(client, build)).join('\n')).toContain(
      '9 checks: 9 unchanged (2 within the tolerance), 0 changed',
    );
  });

  test('failOnChange fails an unchanged check only while it waits for review (within the tolerance)', () => {
    const check = (result: string, review: string, withinTolerance = false) =>
      ({ result, review, withinTolerance }) as unknown as Check;
    expect(failsOnChange(check('unchanged', 'none'))).toBe(false);
    expect(failsOnChange(check('unchanged', 'none', true))).toBe(false);
    expect(failsOnChange(check('unchanged', 'pending', true))).toBe(true);
    expect(failsOnChange(check('changed', 'pending'))).toBe(true);
    expect(failsOnChange(check('new', 'approved'))).toBe(false);
    expect(failsOnChange(check('error', 'none'))).toBe(true);
  });

  test('the summary ends with a tip for screens people keep rejecting as captured too early', async () => {
    const counts = {
      total: 3,
      result: { unchanged: 3, changed: 0, new: 0, error: 0 },
      review: { none: 3, pending: 0, approved: 0, rejected: 0, outdated: 0 },
      autoApproved: 0,
    };
    const build = { id: 'bld_1', number: 7, branch: 'main', verdict: 'passed', counts } as unknown as Build;
    const screen = (name: string, byCategory: Record<string, number>, tooEarly: number) => ({
      snapshotKey: name,
      name,
      variant: name === 'home' ? { browser: 'chromium' } : {},
      count: tooEarly,
      byCategory,
      top: null,
      tooEarly,
      hint: '',
      recent: [],
      lastAt: 0,
    });
    let requests = 0;
    const client = {
      buildUrl: (id: string) => `http://pt/ui/builds/${id}`,
      buildRejections: async () => {
        requests += 1;
        return {
          total: 6,
          categories: [],
          screens: [
            screen('home', { not_loaded: 3 }, 3),
            screen('hero', { late_asset: 2, not_loaded: 1 }, 3),
            screen('cart', { not_loaded: 1, real_bug: 4 }, 1),
          ],
        };
      },
    } as unknown as PixeltwinClient;
    const lines = await summaryLines(client, build);
    expect(requests).toBe(1);
    expect(lines.filter((l) => l.includes('tip:'))).toEqual([
      "pixeltwin: tip: 'home' (chromium) was rejected 3× as not fully loaded — wait for it before the screenshot",
      "pixeltwin: tip: 'hero' was rejected 2× for an image, banner or font that loaded late (and 1× as not fully loaded) — wait for it before the screenshot",
    ]);
    expect(lines.at(-1)).toBe('pixeltwin: review at http://pt/ui/builds/bld_1');
    // An older server (or no read scope): no tips, and the summary still ends with the link.
    const older = {
      buildUrl: client.buildUrl,
      buildRejections: async () => {
        throw new PixeltwinError({ status: 404, code: 'not_found', detail: 'Not found', method: 'GET', path: '/' });
      },
    } as unknown as PixeltwinClient;
    expect((await summaryLines(older, build)).join('\n')).not.toContain('tip:');
  });

  test('a parallel build: part count and part id from options or the environment', () => {
    expect(resolveSettings({}, {})).toMatchObject({ parallelTotal: undefined, parallelPart: undefined });
    const env = { PIXELTWIN_PARALLEL_TOTAL: '2', PIXELTWIN_PARALLEL_PART: 'farm1' };
    expect(resolveSettings({}, env)).toMatchObject({ parallelTotal: 2, parallelPart: 'farm1' });
    expect(resolveSettings({ parallelTotal: 3 }, env).parallelTotal).toBe(3);
    expect(resolveSettings({}, { PIXELTWIN_PARALLEL_TOTAL: 'two' }).parallelTotal).toBeUndefined();
    expect(optionsToEnv({ parallelTotal: 2, parallelPart: 'a' })).toMatchObject({
      PIXELTWIN_PARALLEL_TOTAL: '2',
      PIXELTWIN_PARALLEL_PART: 'a',
    });
  });

  test('the branch comes from .git/HEAD, also in a worktree; detached is undefined', () => {
    const root = mkdtempSync(join(tmpdir(), 'pixeltwin-git-'));
    try {
      mkdirSync(join(root, 'repo/.git'), { recursive: true });
      mkdirSync(join(root, 'repo/sub/dir'), { recursive: true });
      writeFileSync(join(root, 'repo/.git/HEAD'), 'ref: refs/heads/feature/login\n');
      expect(gitBranch(join(root, 'repo/sub/dir'))).toBe('feature/login');

      mkdirSync(join(root, 'repo/.git/worktrees/wt'), { recursive: true });
      writeFileSync(join(root, 'repo/.git/worktrees/wt/HEAD'), 'ref: refs/heads/wt-branch\n');
      mkdirSync(join(root, 'wt'));
      writeFileSync(join(root, 'wt/.git'), `gitdir: ${join(root, 'repo/.git/worktrees/wt')}\n`);
      expect(gitBranch(join(root, 'wt'))).toBe('wt-branch');

      writeFileSync(join(root, 'repo/.git/HEAD'), '3f2a9c0d\n');
      expect(gitBranch(join(root, 'repo'))).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('optionsToEnv carries options to other processes', () => {
    expect(optionsToEnv({ project: 'web', gate: true, finalize: false, waitSeconds: 10 })).toEqual({
      PIXELTWIN_PROJECT: 'web',
      PIXELTWIN_GATE: '1',
      PIXELTWIN_FINALIZE: '0',
      PIXELTWIN_WAIT: '10',
    });
  });
});

describe('run lifecycle against a real server', () => {
  let server: TestServer;
  let client: PixeltwinClient;
  const png = (blue = 243) =>
    makePng(120, 80, WHITE, [{ x: 10, y: 10, width: 40, height: 20, color: [0, 0, blue, 255] }]);

  beforeAll(async () => {
    server = await startServer('run');
    client = new PixeltwinClient({ url: server.url, token: server.token });
  }, 60_000);

  afterAll(async () => {
    await server?.stop();
  });

  const settingsFor = (env: Record<string, string | undefined>, options = {}) =>
    resolveSettings({ url: server.url, token: server.token, project: 'run', branch: 'main', ...options }, env);

  test('the build opened for a run carries its commit, repository and pull request', async () => {
    const env: Record<string, string | undefined> = {};
    const settings = settingsFor(env, {
      branch: 'feature/pr',
      commitSha: 'c0ffee1',
      repository: 'acme/shop',
      pullRequest: 42,
    });
    const started = await startRun(settings, { env, log: () => {} });
    expect(started.build).toMatchObject({ commitSha: 'c0ffee1', repository: 'acme/shop', pullRequest: 42 });
    started.restoreEnv();
  });

  test('start publishes the build id; finish finalizes, prints the summary and gates', async () => {
    const env: Record<string, string | undefined> = {};
    const lines: string[] = [];
    const log = (line: string) => lines.push(line);
    const settings = settingsFor(env, { gate: true });
    const started = await startRun(settings, { env, log });
    const build = started.build;
    if (!build) throw new Error('no build');
    expect(env.PIXELTWIN_BUILD_ID).toBe(build.id);
    expect(env.PIXELTWIN_EXTERNAL_ID).toStartWith('local-');
    expect(lines[0]).toContain(`/ui/builds/${build.id}`);

    await client.postCheck(build.id, {
      name: 'home',
      variant: { browser: 'chromium', viewport: '120x80' },
      image: png(),
    });
    const err = await finishRun(settings, build.id, { env, log }).catch((e) => e);
    expect(err).toBeInstanceOf(PixeltwinGateError);
    expect(err.build.verdict).toBe('pending');
    const summary = lines.join('\n');
    expect(summary).toContain('verdict pending');
    expect(summary).toContain('1 check: 0 unchanged, 0 changed, 1 new, 0 errors; 1 awaiting review');
    expect(summary).toContain('new       home (chromium, 120x80)');
    expect(summary).toContain(`review at ${server.url}/ui/builds/${build.id}`);

    started.restoreEnv();
    expect(env).toEqual({});
    await client.approveBuild(build.id);

    // The next run passes the gate.
    const next = await startRun(settings, { env, log });
    const nextId = next.build?.id ?? '';
    await client.postCheck(nextId, {
      name: 'home',
      variant: { browser: 'chromium', viewport: '120x80' },
      image: png(),
    });
    const done = await finishRun(settings, nextId, { env, log });
    expect(done.finalized).toBe(true);
    expect(done.build.verdict).toBe('passed');
  });

  test('finish prints a tip for a screen rejected again and again as not loaded', async () => {
    const banner = (x: number) =>
      makePng(120, 80, WHITE, [{ x, y: 40, width: 30, height: 20, color: [200, 0, 0, 255] }]);
    const first = await client.openBuild('run', { branch: 'tips' });
    await client.postCheck(first.id, { name: 'banner', image: banner(10) });
    await client.approveBuild(first.id);
    for (const x of [40, 70]) {
      const build = await client.openBuild('run', { branch: 'tips' });
      const check = await client.postCheck(build.id, { name: 'banner', image: banner(x) });
      await client.review(check.id, 'reject', { reasonCode: 'not_loaded', reason: 'The banner was still loading' });
    }
    const env: Record<string, string | undefined> = {};
    const lines: string[] = [];
    const settings = settingsFor(env, { branch: 'tips' });
    const started = await startRun(settings, { env, log: (line) => lines.push(line) });
    await client.postCheck(started.build?.id ?? '', { name: 'banner', image: banner(85) });
    await finishRun(settings, started.build?.id ?? '', { env, log: (line) => lines.push(line) });
    started.restoreEnv();
    expect(lines).toContain(
      "pixeltwin: tip: 'banner' was rejected 2× as not fully loaded — wait for it before the screenshot",
    );
  });

  test('a shard leaves the build open; the next shard finds it by the CI run id', async () => {
    const ci = { GITHUB_ACTIONS: 'true', GITHUB_RUN_ID: '1001', GITHUB_RUN_ATTEMPT: '1' };
    const lines: string[] = [];
    const log = (line: string) => lines.push(line);
    const shard1 = { ...ci } as Record<string, string | undefined>;
    const shard2 = { ...ci } as Record<string, string | undefined>;
    const a = await startRun(settingsFor(shard1), { env: shard1, sharded: true, log });
    const b = await startRun(settingsFor(shard2), { env: shard2, sharded: true, log });
    expect(a.build?.id).toBe(b.build?.id ?? 'different');
    expect(a.build?.externalId).toBe('github-1001-1');
    const id = a.build?.id ?? '';
    const left = await finishRun(settingsFor(shard1, { gate: true }), id, { env: shard1, sharded: true, log });
    expect(left.finalized).toBe(false);
    expect(left.build.state).toBe('open');
    expect(lines.at(-1)).toContain('npx pixeltwin finalize');
  });

  test('a parallel build: every CI job opens the same build, the last part to finish finalizes and gates', async () => {
    const lines: string[] = [];
    const log = (line: string) => lines.push(line);
    const job = (id: string) =>
      ({ GITLAB_CI: 'true', CI_PIPELINE_ID: '5150', CI_JOB_ID: id }) as Record<string, string | undefined>;
    const farm1 = job('11');
    const farm2 = job('12');
    const settings = (env: Record<string, string | undefined>) => settingsFor(env, { parallelTotal: 2, gate: true });
    const a = await startRun(settings(farm1), { env: farm1, log });
    const b = await startRun(settings(farm2), { env: farm2, log });
    const id = a.build?.id ?? '';
    expect(b.build?.id).toBe(id);
    expect(a.build).toMatchObject({ externalId: 'gitlab-5150', parallelTotal: 2 });

    await client.postCheck(id, { name: 'farm1', image: png() });
    const first = await finishRun(settings(farm1), id, { env: farm1, log });
    expect(first).toMatchObject({ finalized: false, build: { state: 'open', partsFinished: 1 } });
    expect(lines.at(-1)).toContain('part 1 of 2');

    // The last part gets the verdict: the new screen waits for review, so the gate fails here.
    const err = await finishRun(settings(farm2), id, { env: farm2, log }).catch((e) => e);
    expect(err).toBeInstanceOf(PixeltwinGateError);
    expect(err.build).toMatchObject({ state: 'finalized', partsFinished: 2 });
    expect(lines.join('\n')).toContain('1 check: 0 unchanged, 0 changed, 1 new');
  });

  test('a finalized build is refused at start and the environment is left as it was', async () => {
    const env: Record<string, string | undefined> = { PIXELTWIN_EXTERNAL_ID: 'done-1' };
    const settings = settingsFor(env);
    const first = await startRun(settings, { env, log: () => {} });
    await finishRun(settings, first.build?.id ?? '', { env, log: () => {} });
    first.restoreEnv();
    const err = await startRun(settings, { env, log: () => {} }).catch((e) => e);
    expect(err).toBeInstanceOf(PixeltwinError);
    expect(err.code).toBe('build_finalized');
    expect(err.message).toContain('new PIXELTWIN_EXTERNAL_ID');
    expect(env).toEqual({ PIXELTWIN_EXTERNAL_ID: 'done-1' });
  });

  test('disabled: no build, workers are told', async () => {
    const env: Record<string, string | undefined> = {};
    const started = await startRun(resolveSettings({ disabled: true }, env), { env, log: () => {} });
    expect(started.build).toBeNull();
    expect(env.PIXELTWIN_DISABLED).toBe('1');
  });

  test('a missing token or project is a clear error', async () => {
    const err = await startRun(resolveSettings({}, {}), { env: {}, log: () => {} }).catch((e) => e);
    expect(err.message).toContain('PIXELTWIN_TOKEN');
    const noProject = await startRun(resolveSettings({ token: 'pt_x' }, {}), { env: {}, log: () => {} }).catch(
      (e) => e,
    );
    expect(noProject.message).toContain('PIXELTWIN_PROJECT');
  });

  test('`pixeltwin finalize` closes the build the shards share and gates on it', async () => {
    const env = {
      PATH: process.env.PATH,
      PIXELTWIN_URL: server.url,
      PIXELTWIN_TOKEN: server.token,
      PIXELTWIN_PROJECT: 'run',
      PIXELTWIN_BRANCH: 'cli',
      CI_RUN_ID: 'cli-run-1',
    };
    const shard: Record<string, string | undefined> = { ...env };
    const started = await startRun(resolveSettings({}, shard), { env: shard, sharded: true, log: () => {} });
    await client.postCheck(started.build?.id ?? '', { name: 'cli', image: png(100) });

    const cli = (args: string[], extra: Record<string, string> = {}) =>
      spawnSync(process.execPath, ['packages/client/src/bin.ts', ...args], {
        cwd: REPO,
        env: { ...env, ...extra },
        encoding: 'utf8',
      });
    const gated = cli(['finalize', '--gate']);
    expect(gated.status).toBe(1);
    expect(gated.stdout).toContain('verdict pending');
    expect(gated.stdout).toContain('new       cli');
    expect(gated.stderr).toContain('not "passed"');
    expect((await client.getBuild(started.build?.id ?? '')).state).toBe('finalized');

    await client.approveBuild(started.build?.id ?? '');
    const again = cli(['finalize'], { PIXELTWIN_GATE: '1' });
    expect(again.status).toBe(0);
    expect(again.stdout).toContain('verdict passed');

    expect(cli(['finalize', '--bogus']).status).toBe(2);
    expect(cli([]).status).toBe(2);
    const noRun = cli(['finalize'], { CI_RUN_ID: '' });
    expect(noRun.status).toBe(1);
    expect(noRun.stderr).toContain('PIXELTWIN_EXTERNAL_ID');
  });

  test('`pixeltwin promote` copies a branch to main after the merge, all or some screens', async () => {
    const env = {
      PATH: process.env.PATH,
      PIXELTWIN_URL: server.url,
      PIXELTWIN_TOKEN: server.token,
      PIXELTWIN_PROJECT: 'run',
    };
    const build = await client.openBuild('run', { branch: 'feature/promo' });
    await client.postCheck(build.id, { name: 'promo a', image: png(110) });
    const b = await client.postCheck(build.id, { name: 'promo b', image: png(120) });
    await client.approveBuild(build.id);
    const cli = (args: string[]) =>
      spawnSync(process.execPath, ['packages/client/src/bin.ts', ...args], { cwd: REPO, env, encoding: 'utf8' });

    const dry = cli(['promote', 'feature/promo', '--dry-run']);
    expect(dry.status).toBe(0);
    expect(dry.stdout).toContain('promo a');
    expect(dry.stdout).toContain('promo b');
    expect(dry.stdout).toContain('2 screens would change on main');

    const some = cli(['promote', 'feature/promo', '--only', b.snapshotKey]);
    expect(some.status).toBe(0);
    expect(some.stdout).toContain('Promoted 1 screen of feature/promo to main');
    const rest = cli(['promote', 'feature/promo']);
    expect(rest.stdout).toContain('Promoted 1 screen of feature/promo to main');
    expect(cli(['promote', 'feature/promo']).stdout).toContain('Nothing to promote');
    expect(cli(['promote']).status).toBe(2);
    expect(cli(['promote', 'main']).status).toBe(1);
  });
});
