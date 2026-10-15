import { AppError } from '../../src/errors';

/** Awaits a promise that must reject with an AppError and returns that error. */
export async function appError(promise: Promise<unknown>): Promise<AppError> {
  const err = await promise.then(
    () => new Error('expected rejection'),
    (e: unknown) => e,
  );
  if (!(err instanceof AppError)) throw err;
  return err;
}
