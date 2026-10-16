// globalSetup: '@pixeltwin/playwright/setup'. Opens one build for the run before the workers
// start (they inherit PIXELTWIN_BUILD_ID) and returns the teardown that finalizes it.
import { finishRun, resolveSettings, startRun } from '@pixeltwin/client/run';
import type { FullConfig } from '@playwright/test';

export default async function pixeltwinGlobalSetup(config: FullConfig): Promise<() => void | Promise<void>> {
  const settings = resolveSettings();
  const sharded = (config.shard?.total ?? 1) > 1;
  const { build, restoreEnv } = await startRun(settings, { sharded });
  if (!build) return restoreEnv;
  return async () => {
    try {
      await finishRun(settings, build.id, { sharded });
    } finally {
      restoreEnv();
    }
  };
}
