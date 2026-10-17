import type { Deps } from './deps';
import { AUTO_APPROVER } from './reviews';

/** The actor of a promotion made by a merged GitHub pull request: `github:<login>`. */
export const GITHUB_ACTOR_PREFIX = 'github:';

/**
 * Who acted, in words: a user's email, the name of the project token, the auto-approve setting
 * or a GitHub merge. Review history, baselines and webhooks show actors this way.
 */
export async function actorName(deps: Pick<Deps, 'db'>, id: string): Promise<string> {
  if (id === AUTO_APPROVER) return 'auto-approve (project setting)';
  if (id.startsWith(GITHUB_ACTOR_PREFIX)) {
    const login = id.slice(GITHUB_ACTOR_PREFIX.length);
    return login ? `GitHub merge by ${login}` : 'GitHub merge';
  }
  const user = await deps.db.selectFrom('users').select('email').where('id', '=', id).executeTakeFirst();
  if (user) return user.email;
  const token = await deps.db.selectFrom('projectTokens').select('name').where('id', '=', id).executeTakeFirst();
  return token ? `token “${token.name}”` : 'a deleted account';
}
