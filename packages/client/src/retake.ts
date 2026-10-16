import type { Check } from './types.js';

export interface RetakeOptions {
  /** Further screenshots after a `changed` one. 0: post once. */
  retakes: number;
  /** Wait between screenshots. */
  intervalMs: number;
  /** No retake starts after this time (ms since the epoch). */
  deadline?: number;
  /** Called before each retake, with the changed check and the retake's number (from 1). */
  onRetake?: (check: Check, retake: number) => void;
  /** Default `setTimeout`; tests pass their own. */
  sleep?: (ms: number) => Promise<void>;
}

const wait = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

/**
 * Posts a screenshot and, while the result is `changed`, waits and posts a fresh one: a page that
 * is still loading or animating settles. `post` must take a new screenshot each time; the same name
 * and variant replace the check in the build, so it keeps one. New and error results are final.
 */
export async function postWithRetakes(post: () => Promise<Check>, options: RetakeOptions): Promise<Check> {
  const sleep = options.sleep ?? wait;
  let check = await post();
  for (let retake = 1; retake <= options.retakes && check.result === 'changed'; retake++) {
    if (options.deadline !== undefined && Date.now() + options.intervalMs >= options.deadline) break;
    options.onRetake?.(check, retake);
    await sleep(options.intervalMs);
    check = await post();
  }
  return check;
}
