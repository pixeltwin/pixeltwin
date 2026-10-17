import type { Check } from './types.js';

/** How long one check took in the test, in milliseconds, with its retakes. */
export interface CheckTiming {
  /** Taking the screenshots (and measuring the page for ignored elements). */
  screenshotMs: number;
  /** Sending them and the answer coming back, minus the server's own time. */
  uploadMs: number;
  /** The server's time: baseline, compare and store (`check.compareMs`). */
  compareMs: number;
  retakes: number;
  totalMs: number;
}

/** Times one check, take by take: wrap each screenshot in `shoot` and each post in `post`. */
export class CheckTimer {
  readonly #now: () => number;
  #screenshotMs = 0;
  #uploadMs = 0;
  #compareMs = 0;
  #takes = 0;

  constructor(now: () => number = () => performance.now()) {
    this.#now = now;
  }

  async shoot<T>(take: () => Promise<T>): Promise<T> {
    const started = this.#now();
    try {
      return await take();
    } finally {
      this.#screenshotMs += this.#now() - started;
    }
  }

  async post(send: () => Promise<Check>): Promise<Check> {
    const started = this.#now();
    const check = await send();
    const roundTrip = this.#now() - started;
    const server = Math.min(roundTrip, check.compareMs ?? 0);
    this.#compareMs += server;
    this.#uploadMs += roundTrip - server;
    this.#takes += 1;
    return check;
  }

  result(): CheckTiming {
    const round = Math.round;
    const timing = {
      screenshotMs: round(this.#screenshotMs),
      uploadMs: round(this.#uploadMs),
      compareMs: round(this.#compareMs),
      retakes: Math.max(0, this.#takes - 1),
    };
    return { ...timing, totalMs: timing.screenshotMs + timing.uploadMs + timing.compareMs };
  }
}

/** The totals of one worker (or process), sent to the build once when it ends. */
export class TimingTotals {
  #checks = 0;
  #screenshotMs = 0;
  #uploadMs = 0;
  #retakes = 0;

  add(timing: CheckTiming): void {
    this.#checks += 1;
    this.#screenshotMs += timing.screenshotMs;
    this.#uploadMs += timing.uploadMs;
    this.#retakes += timing.retakes;
  }

  /** Sends what was added since the last flush; nothing when there is nothing. */
  async flush(
    client: { addTimings(buildId: string, totals: TimingInput): Promise<unknown> },
    buildId: string,
  ): Promise<void> {
    if (this.#checks === 0) return;
    const totals = {
      checks: this.#checks,
      screenshotMs: this.#screenshotMs,
      uploadMs: this.#uploadMs,
      retakes: this.#retakes,
    };
    this.#checks = this.#screenshotMs = this.#uploadMs = this.#retakes = 0;
    await client.addTimings(buildId, totals);
  }
}

/** What `POST /builds/{id}/timings` takes. */
export interface TimingInput {
  checks: number;
  screenshotMs: number;
  uploadMs: number;
  retakes: number;
}

/** `0.04 s`, `1.4 s`, `38 s`, `2m 51s`, `1h 2m`. */
export function formatMs(ms: number): string {
  if (ms < 100) return `${(ms / 1000).toFixed(2)} s`;
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)} s`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/** `pixeltwin: "home" changed in 1.4 s (screenshot 0.3 s, upload 0.2 s, compare 0.9 s, 1 retake)`. */
export function timingLine(name: string, check: Pick<Check, 'result'>, t: CheckTiming): string {
  const retakes = t.retakes ? `, ${t.retakes} retake${t.retakes === 1 ? '' : 's'}` : '';
  return (
    `pixeltwin: "${name}" ${check.result} in ${formatMs(t.totalMs)} (screenshot ${formatMs(t.screenshotMs)}, ` +
    `upload ${formatMs(t.uploadMs)}, compare ${formatMs(t.compareMs)}${retakes})`
  );
}
