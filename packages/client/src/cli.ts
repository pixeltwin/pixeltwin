// `pixeltwin finalize`: the CI step after every shard. `pixeltwin promote`: the CI step after a
// merge. `pixeltwin mcp`: a Model Context Protocol server for agents. Same environment as the test run.
import { PixeltwinError, PixeltwinGateError, PixeltwinNetworkError } from './errors.js';
import { serveMcp } from './mcp.js';
import { clientFor, externalIdFor, finishRun, linkOf, resolveSettings } from './run.js';

const HELP = `Usage: pixeltwin finalize [--gate] [--wait <seconds>] [--build <id>]

Finalizes the build every shard of this CI run posted to, prints the summary and, with --gate
(or PIXELTWIN_GATE=1), exits 1 unless the verdict is "passed".

The build is PIXELTWIN_BUILD_ID or --build when set; otherwise the one opened with the same
PIXELTWIN_EXTERNAL_ID (or CI run id: GitHub Actions, GitLab CI, CI_RUN_ID).
Needs PIXELTWIN_URL, PIXELTWIN_TOKEN and PIXELTWIN_PROJECT like the test run.

Usage: pixeltwin promote <branch> [--only <snapshot key>]... [--dry-run]

After merging <branch>, copies its baselines to the main branch so the main branch does not ask
to review the same screens again. --only picks screens (repeat it); --dry-run lists what would
change. Needs a token with the write scope.

Usage: pixeltwin mcp

A Model Context Protocol server on stdin/stdout for agents such as Claude Code: tools to read a
build's changes element by element, look at the screenshots and approve or reject with a reason.
Needs PIXELTWIN_URL, PIXELTWIN_TOKEN (read, and review to approve) and PIXELTWIN_PROJECT.`;

async function promote(rest: string[], env: Record<string, string | undefined>): Promise<number> {
  const branch = rest[0] && !rest[0].startsWith('--') ? rest[0] : undefined;
  if (!branch) {
    console.error(`pixeltwin: promote needs a branch.\n\n${HELP}`);
    return 2;
  }
  const only: string[] = [];
  let dryRun = false;
  for (let i = 1; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === '--dry-run') dryRun = true;
    else if (arg === '--only' && rest[i + 1]) only.push(rest[++i] as string);
    else {
      console.error(`pixeltwin: unknown option "${arg}".\n\n${HELP}`);
      return 2;
    }
  }
  try {
    const settings = resolveSettings({}, env);
    const client = clientFor(settings);
    if (dryRun) {
      const candidates = await client.promotionCandidates(settings.project, branch);
      for (const c of candidates) {
        const variant = Object.entries(c.variant)
          .map(([k, v]) => `${k}=${v}`)
          .join(', ');
        console.log(
          `pixeltwin:   ${c.mainImageSha ? 'changed' : 'new    '}  ${c.name}${variant ? ` (${variant})` : ''}  ${c.snapshotKey}`,
        );
      }
      const n = candidates.length;
      console.log(`pixeltwin: ${n} ${n === 1 ? 'screen' : 'screens'} would change on main.`);
      return 0;
    }
    const { promoted } = await client.promote(settings.project, branch, only.length ? only : undefined);
    console.log(
      promoted === 0
        ? `pixeltwin: Nothing to promote: main already has every screen of ${branch}.`
        : `pixeltwin: Promoted ${promoted} ${promoted === 1 ? 'screen' : 'screens'} of ${branch} to main.`,
    );
    return 0;
  } catch (err) {
    console.error(err instanceof PixeltwinError || err instanceof PixeltwinNetworkError ? err.message : err);
    return 1;
  }
}

export async function main(argv: string[], env: Record<string, string | undefined> = process.env): Promise<number> {
  const [command, ...rest] = argv;
  if (!command || command === 'help' || command === '--help' || command === '-h') {
    console.log(HELP);
    return command ? 0 : 2;
  }
  if (command === 'promote') return promote(rest, env);
  if (command === 'mcp') return serveMcp(env);
  if (command !== 'finalize') {
    console.error(`pixeltwin: unknown command "${command}".\n\n${HELP}`);
    return 2;
  }
  let gate: boolean | undefined;
  let waitSeconds: number | undefined;
  let buildId = env.PIXELTWIN_BUILD_ID?.trim() || undefined;
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === '--gate') gate = true;
    else if (arg === '--no-gate') gate = false;
    else if (arg === '--wait') waitSeconds = Number(rest[++i]);
    else if (arg === '--build') buildId = rest[++i];
    else {
      console.error(`pixeltwin: unknown option "${arg}".\n\n${HELP}`);
      return 2;
    }
  }
  if (waitSeconds !== undefined && !(waitSeconds >= 0)) {
    console.error('pixeltwin: --wait takes a number of seconds.');
    return 2;
  }

  try {
    const settings = { ...resolveSettings({ gate, waitSeconds }, env), finalize: true };
    if (!buildId) {
      const client = clientFor(settings);
      const build = await client.openBuild(settings.project, {
        branch: settings.branch,
        baseBranch: settings.baseBranch,
        commitSha: settings.commitSha,
        ...linkOf(settings),
        externalId: externalIdFor(settings, env, true),
      });
      if (build.created) console.log(`pixeltwin: no shard posted to this run; build #${build.number} is empty.`);
      buildId = build.id;
    }
    const { build } = await finishRun(settings, buildId);
    return settings.gate && build.verdict !== 'passed' ? 1 : 0;
  } catch (err) {
    if (err instanceof PixeltwinGateError) {
      console.error(err.message);
      return 1;
    }
    console.error(err instanceof PixeltwinError || err instanceof PixeltwinNetworkError ? err.message : err);
    return 1;
  }
}
