import type { z } from 'zod';

export interface FieldError {
  path: string;
  message: string;
}

/**
 * The only error type the domain throws on purpose. `code` is stable and machine-readable;
 * the HTTP layer turns it into an RFC 9457 problem response.
 */
export class AppError extends Error {
  readonly code: string;
  readonly status: number;
  readonly detail: string;
  readonly errors: FieldError[] | undefined;
  /** Seconds for a `Retry-After` header (503 and 429 answers). */
  retryAfter: number | undefined;

  constructor(code: string, status: number, detail: string, errors?: FieldError[]) {
    super(detail);
    this.name = 'AppError';
    this.code = code;
    this.status = status;
    this.detail = detail;
    this.errors = errors;
  }
}

export function validationError(error: z.ZodError): AppError {
  const errors = error.issues.map((issue) => ({ path: issue.path.map(String).join('.'), message: issue.message }));
  return new AppError('validation_failed', 422, 'The request is invalid.', errors);
}
