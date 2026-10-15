/** Fixed-window counter per key, in memory (per process; spec §6.6). */
export class RateLimiter {
  readonly #limit: number;
  readonly #windowMs: number;
  readonly #now: () => number;
  readonly #windows = new Map<string, { count: number; resetAt: number }>();

  constructor(limit: number, windowMs: number, now: () => number = Date.now) {
    this.#limit = limit;
    this.#windowMs = windowMs;
    this.#now = now;
  }

  /** Records an attempt; false when the key is over its limit for the current window. */
  hit(key: string): boolean {
    const now = this.#now();
    if (this.#windows.size > 10_000) {
      for (const [k, w] of this.#windows) if (w.resetAt <= now) this.#windows.delete(k);
    }
    const window = this.#windows.get(key);
    if (!window || window.resetAt <= now) {
      this.#windows.set(key, { count: 1, resetAt: now + this.#windowMs });
      return true;
    }
    window.count += 1;
    return window.count <= this.#limit;
  }
}
