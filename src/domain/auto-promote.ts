import type { Provider } from '../db/schema';
import { AppError } from '../errors';
import { mergeActor } from './actors';
import { promoteBranch } from './baselines';
import type { Deps } from './deps';
import type { IntegrationConfig } from './integrations';

// Auto-promote: a merged pull (merge) request promotes its branch's baselines into the branch it
// was merged into, as `pixeltwin promote` would. Each merged request is handled once per project
// (integration_merges' key), so a redelivered webhook, or one that reaches two replicas at once,
// never promotes again over what main approved since.

export interface MergeEvent {
  provider: Provider;
  repository: string;
  /** The pull request number or merge request IID. */
  pullRequest: number;
  headBranch: string;
  baseBranch: string;
  mergeSha: string | null;
  mergedBy: string | null;
  deliveryId: string | null;
}

export type MergeOutcome = 'promoted' | 'already_promoted' | 'auto_promote_off' | 'same_branch';

export interface MergeResult {
  project: string;
  outcome: MergeOutcome;
  /** Baselines copied (0 when the branch had nothing new). */
  promoted: number;
}

export async function handleMerge(
  deps: Pick<Deps, 'db' | 'events'>,
  integration: Pick<IntegrationConfig, 'projectId' | 'autoPromote'> & { slug: string },
  event: MergeEvent,
): Promise<MergeResult> {
  const result = (outcome: MergeOutcome, promoted = 0): MergeResult => ({
    project: integration.slug,
    outcome,
    promoted,
  });
  if (!integration.autoPromote) return result('auto_promote_off');
  if (event.headBranch === event.baseBranch) return result('same_branch');
  const inserted = await deps.db
    .insertInto('integrationMerges')
    .values({
      projectId: integration.projectId,
      provider: event.provider,
      repository: event.repository.toLowerCase(),
      pullRequest: event.pullRequest,
      headBranch: event.headBranch,
      baseBranch: event.baseBranch,
      mergeSha: event.mergeSha,
      mergedBy: event.mergedBy,
      deliveryId: event.deliveryId,
      promoted: null,
      createdAt: Date.now(),
    })
    .onConflict((oc) => oc.columns(['projectId', 'repository', 'pullRequest']).doNothing())
    .returning('projectId')
    .executeTakeFirst();
  if (!inserted) {
    const earlier = await deps.db
      .selectFrom('integrationMerges')
      .select('promoted')
      .where('projectId', '=', integration.projectId)
      .where('repository', '=', event.repository.toLowerCase())
      .where('pullRequest', '=', event.pullRequest)
      .executeTakeFirst();
    return result('already_promoted', Number(earlier?.promoted ?? 0));
  }
  const thisMerge = {
    projectId: integration.projectId,
    repository: event.repository.toLowerCase(),
    pullRequest: event.pullRequest,
  };
  try {
    const { promoted } = await promoteBranch(
      deps,
      integration.slug,
      event.headBranch,
      mergeActor(event.provider, event.mergedBy),
      { into: event.baseBranch },
    );
    await deps.db
      .updateTable('integrationMerges')
      .set({ promoted })
      .where('projectId', '=', thisMerge.projectId)
      .where('repository', '=', thisMerge.repository)
      .where('pullRequest', '=', thisMerge.pullRequest)
      .execute();
    return result('promoted', promoted);
  } catch (err) {
    // Not recorded as handled: the code host's redelivery (or a retry) may promote it.
    await deps.db
      .deleteFrom('integrationMerges')
      .where('projectId', '=', thisMerge.projectId)
      .where('repository', '=', thisMerge.repository)
      .where('pullRequest', '=', thisMerge.pullRequest)
      .execute();
    if (err instanceof AppError && err.code === 'invalid_promotion') return result('same_branch');
    throw err;
  }
}
