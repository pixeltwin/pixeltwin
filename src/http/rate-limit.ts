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

/**
 * Login attempts (spec §7.1): 10 per minute per (IP, email), plus 60 per minute per IP so a
 * client cannot dodge the first limit by trying a new email each time.
 */
export class LoginLimiter {
  readonly #perIpEmail: RateLimiter;
  readonly #perIp: RateLimiter;

  constructor(options: { perIpEmail?: number; perIp?: number; now?: () => number } = {}) {
    this.#perIpEmail = new RateLimiter(options.perIpEmail ?? 10, 60_000, options.now);
    this.#perIp = new RateLimiter(options.perIp ?? 60, 60_000, options.now);
  }

  /** Records an attempt; false when either limit is exceeded. */
  hit(ip: string, email: string): boolean {
    const byEmail = this.#perIpEmail.hit(`${ip}|${email.trim().toLowerCase()}`);
    const byIp = this.#perIp.hit(ip);
    return byEmail && byIp;
  }
}
