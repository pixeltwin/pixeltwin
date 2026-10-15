import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { AppError, validationError } from '../src/errors';

describe('AppError', () => {
  test('carries code, status and detail', () => {
    const err = new AppError('build_finalized', 409, 'Build is finalized.');
    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe('build_finalized');
    expect(err.status).toBe(409);
    expect(err.message).toBe('Build is finalized.');
  });

  test('validationError maps zod issues to field errors', () => {
    const result = z.object({ name: z.string(), size: z.object({ w: z.number() }) }).safeParse({ size: { w: 'x' } });
    if (result.success) throw new Error('expected failure');
    const err = validationError(result.error);
    expect(err.code).toBe('validation_failed');
    expect(err.status).toBe(422);
    expect(err.errors?.map((e) => e.path)).toEqual(['name', 'size.w']);
  });
});
