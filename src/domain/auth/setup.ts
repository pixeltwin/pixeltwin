import { z } from 'zod';
import { AppError } from '../../errors';
import type { Deps } from '../deps';
import { parseInput } from '../schemas';
import { equalHex, randomBase62, sha256 } from './random';
import { countUsers, emailSchema, insertUser, passwordSchema, type UserView } from './users';

/**
 * First-run setup (spec §6.5). While no user exists the server holds a random setup token;
 * whoever presents it can create the first admin. The token lives in memory only.
 */
export class SetupState {
  #tokenHash: string | null;

  constructor(token: string | null) {
    this.#tokenHash = token ? sha256(token) : null;
  }

  /** Creates the state for a starting server: a fresh token when there are no users yet. */
  static async init(deps: Pick<Deps, 'db'>): Promise<{ state: SetupState; token: string | null }> {
    const token = (await countUsers(deps)) === 0 ? randomBase62(32) : null;
    return { state: new SetupState(token), token };
  }

  get open(): boolean {
    return this.#tokenHash !== null;
  }

  matches(token: string): boolean {
    return this.#tokenHash !== null && equalHex(sha256(token), this.#tokenHash);
  }

  close(): void {
    this.#tokenHash = null;
  }
}

export const setupInputSchema = z.strictObject({
  token: z.string().min(1),
  email: emailSchema,
  password: passwordSchema,
});

export async function completeSetup(deps: Pick<Deps, 'db'>, state: SetupState, input: unknown): Promise<UserView> {
  const data = parseInput(setupInputSchema, input);
  if (!state.open) throw new AppError('setup_complete', 409, 'Setup is already complete; log in instead.');
  if (!state.matches(data.token)) throw new AppError('invalid_setup_token', 403, 'The setup token is wrong.');
  const admin = await deps.db.transaction().execute(async (tx) => {
    if ((await countUsers({ db: tx })) > 0) {
      throw new AppError('setup_complete', 409, 'Setup is already complete; log in instead.');
    }
    return insertUser(tx, { email: data.email, password: data.password, role: 'admin' });
  });
  state.close();
  return admin;
}
