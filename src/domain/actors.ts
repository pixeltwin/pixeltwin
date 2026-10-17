import type { Deps } from './deps';
import { AUTO_APPROVER } from './reviews';

/** The actor of a promotion made by a merged pull (merge) request: `github:<login>` or `gitlab:<username>`. */
export const MERGE_ACTORS = { github: 'GitHub', gitlab: 'GitLab' } as const;

export function mergeActor(provider: keyof typeof MERGE_ACTORS, login: string | null): string {
  return `${provider}:${login ?? ''}`;
}

/**
 * Who acted, in words: a user's email, the name of the project token, the auto-approve setting
 * or a GitHub merge. Review history, baselines and webhooks show actors this way.
 */
export async function actorName(deps: Pick<Deps, 'db'>, id: string): Promise<string> {
  if (id === AUTO_APPROVER) return 'auto-approve (project setting)';
  for (const [prefix, host] of Object.entries(MERGE_ACTORS)) {
    if (!id.startsWith(`${prefix}:`)) continue;
    const login = id.slice(prefix.length + 1);
    return login ? `${host} merge by ${login}` : `${host} merge`;
  }
  const user = await deps.db.selectFrom('users').select('email').where('id', '=', id).executeTakeFirst();
  if (user) return user.email;
  const token = await deps.db.selectFrom('projectTokens').select('name').where('id', '=', id).executeTakeFirst();
  return token ? `token “${token.name}”` : 'a deleted account';
}
