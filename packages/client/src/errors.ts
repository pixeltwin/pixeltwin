import type { Build, Check } from './types.js';

export interface FieldError {
  path: string;
  message: string;
}

/** The server answered with an error. Branch on `code`, not on `detail`. */
export class PixeltwinError extends Error {
  readonly status: number;
  /** Stable problem code, e.g. `build_finalized`; `http_<status>` when the body was not a problem. */
  readonly code: string;
  readonly detail: string;
  readonly errors: FieldError[];
  readonly requestId: string | undefined;
  readonly method: string;
  readonly path: string;

  constructor(init: {
    status: number;
    code: string;
    detail: string;
    errors?: FieldError[];
    requestId?: string;
    method: string;
    path: string;
  }) {
    const fields = init.errors?.length ? ` (${init.errors.map((e) => `${e.path}: ${e.message}`).join('; ')})` : '';
    super(`pixeltwin ${init.method} ${init.path} → ${init.status} ${init.code}: ${init.detail}${fields}`);
    this.name = 'PixeltwinError';
    this.status = init.status;
    this.code = init.code;
    this.detail = init.detail;
    this.errors = init.errors ?? [];
    this.requestId = init.requestId;
    this.method = init.method;
    this.path = init.path;
  }
}

/** No answer from the server after every retry. `cause` is the last error. */
export class PixeltwinNetworkError extends Error {
  readonly method: string;
  readonly path: string;

  constructor(method: string, path: string, attempts: number, cause: unknown) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    super(`pixeltwin ${method} ${path} failed after ${attempts} attempt(s): ${reason}`, { cause });
    this.name = 'PixeltwinNetworkError';
    this.method = method;
    this.path = path;
  }
}

/**
 * Whether `failOnChange` fails this check: anything but unchanged, unless it is approved already
 * (a new screenshot the project approves automatically), and an unchanged one that waits for review
 * (within the tolerance, under `reviewWithinTolerance`).
 */
export function failsOnChange(check: Check): boolean {
  if (check.result === 'unchanged') return check.review === 'pending';
  return !(check.result !== 'error' && check.review === 'approved');
}

/**
 * A check that is not `unchanged` (nor approved already) while `failOnChange` is on: thrown from
 * the check call, so the test fails right there, with the result and the link to review it.
 */
export class PixeltwinCheckError extends Error {
  readonly check: Check;
  readonly url: string;

  constructor(check: Check, url: string) {
    const values = Object.keys(check.variant)
      .sort()
      .map((k) => check.variant[k]);
    const variant = values.length ? ` (${values.join(', ')})` : '';
    const diff = check.diff && 'percent' in check.diff ? `, ${check.diff.percent}% of pixels` : '';
    const what = check.withinTolerance ? 'within the tolerance but waits for review' : check.result;
    super(`pixeltwin: "${check.name}"${variant} is ${what}${diff}. Review: ${url}`);
    this.name = 'PixeltwinCheckError';
    this.check = check;
    this.url = url;
  }
}

/** The gate is on and the build's verdict is not `passed`. */
export class PixeltwinGateError extends Error {
  readonly build: Build;

  constructor(build: Build, reviewUrl: string) {
    super(`pixeltwin verdict is "${build.verdict}", not "passed". Review: ${reviewUrl}`);
    this.name = 'PixeltwinGateError';
    this.build = build;
  }
}
