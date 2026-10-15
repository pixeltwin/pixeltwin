// Bun-only API (argon2id), confined to src/domain/auth.
import { cpus } from 'node:os';
import { AppError } from '../../errors';

/**
 * Bounds concurrent work: `max` jobs run, `queue` more wait, the rest are refused with 429.
 * argon2id costs ~64 MiB and ~60 ms per call, so unbounded login floods would exhaust memory
 * and starve everything else the process serves.
 */
export class ConcurrencyGate {
  readonly #max: number;
  readonly #queue: number;
  #running = 0;
  readonly #waiting: Array<() => void> = [];

  constructor(max: number, queue: number) {
    this.#max = max;
    this.#queue = queue;
  }

  async run<T>(job: () => Promise<T>): Promise<T> {
    if (this.#running >= this.#max) {
      if (this.#waiting.length >= this.#queue) {
        throw new AppError('rate_limited', 429, 'The server is busy; try again in a moment.');
      }
      await new Promise<void>((resolve) => this.#waiting.push(resolve));
    } else {
      this.#running += 1;
    }
    try {
      return await job();
    } finally {
      const next = this.#waiting.shift();
      if (next) next();
      else this.#running -= 1;
    }
  }
}

const HASH_GATE = new ConcurrencyGate(Math.max(2, cpus().length), 32);

export function hashPassword(password: string): Promise<string> {
  return HASH_GATE.run(() => Bun.password.hash(password, { algorithm: 'argon2id' }));
}

export function verifyPassword(password: string, hash: string): Promise<boolean> {
  return HASH_GATE.run(() => Bun.password.verify(password, hash));
}

/** A valid hash of a random password, verified against when an email is unknown so timing does not reveal it. */
export const DUMMY_HASH = await Bun.password.hash(crypto.randomUUID(), { algorithm: 'argon2id' });
