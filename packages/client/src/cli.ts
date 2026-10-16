// `pixeltwin finalize`: the CI step after every shard. Same environment as the test run.
import { PixeltwinError, PixeltwinGateError, PixeltwinNetworkError } from './errors.js';
import { clientFor, externalIdFor, finishRun, resolveSettings } from './run.js';

const HELP = `Usage: pixeltwin finalize [--gate] [--wait <seconds>] [--build <id>]

Finalizes the build every shard of this CI run posted to, prints the summary and, with --gate
(or PIXELTWIN_GATE=1), exits 1 unless the verdict is "passed".

The build is PIXELTWIN_BUILD_ID or --build when set; otherwise the one opened with the same
PIXELTWIN_EXTERNAL_ID (or CI run id: GitHub Actions, GitLab CI, CI_RUN_ID).
Needs PIXELTWIN_URL, PIXELTWIN_TOKEN and PIXELTWIN_PROJECT like the test run.`;

export async function main(argv: string[], env: Record<string, string | undefined> = process.env): Promise<number> {
  const [command, ...rest] = argv;
  if (!command || command === 'help' || command === '--help' || command === '-h') {
    console.log(HELP);
    return command ? 0 : 2;
  }
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
