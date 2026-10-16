import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PixeltwinClient, PixeltwinError, PixeltwinGateError } from '@pixeltwin/client';
import {
  ciInfo,
  externalIdFor,
  finishRun,
  gitBranch,
  optionsToEnv,
  resolveSettings,
  startRun,
} from '@pixeltwin/client/run';
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
      }),
    ).toEqual({ runId: 'gitlab-7', branch: 'feature/y', baseBranch: 'develop', commitSha: 'def' });
    expect(ciInfo({ CI_RUN_ID: 'run-9' })).toEqual({ runId: 'run-9' });
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
