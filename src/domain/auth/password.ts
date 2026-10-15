// Bun-only API (argon2id), confined to src/domain/auth.

export function hashPassword(password: string): Promise<string> {
  return Bun.password.hash(password, { algorithm: 'argon2id' });
}

export function verifyPassword(password: string, hash: string): Promise<boolean> {
  return Bun.password.verify(password, hash);
}

/** A valid hash of a random password, verified against when an email is unknown so timing does not reveal it. */
export const DUMMY_HASH = await hashPassword(crypto.randomUUID());
