import type { Build } from './types.js';

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

/** The gate is on and the build's verdict is not `passed`. */
export class PixeltwinGateError extends Error {
  readonly build: Build;

  constructor(build: Build, reviewUrl: string) {
    super(`pixeltwin verdict is "${build.verdict}", not "passed". Review: ${reviewUrl}`);
    this.name = 'PixeltwinGateError';
    this.build = build;
  }
}
