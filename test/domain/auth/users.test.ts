import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  authenticate,
  changePassword,
  createUser,
  deleteUser,
  listUsers,
  setPasswordByEmail,
  updateUser,
} from '../../../src/domain/auth/users';
import { createTestDeps, type TestDeps } from '../../helpers/deps';
import { appError } from '../../helpers/errors';

const PASSWORD = 'correct horse battery';

describe('users', () => {
  let deps: TestDeps;

  beforeEach(async () => {
    deps = await createTestDeps();
  });

  afterEach(async () => {
    await deps.handle.close();
  });

  test('creates a user with a normalized email and no password in the view', async () => {
    const user = await createUser(deps, { email: '  Ada@Example.COM ', password: PASSWORD, role: 'reviewer' });
    expect(user).toEqual({
      id: user.id,
      email: 'ada@example.com',
      role: 'reviewer',
      status: 'active',
      name: null,
      createdAt: user.createdAt,
    });
    expect(user.id).toStartWith('usr_');
    const row = await deps.db.selectFrom('users').selectAll().executeTakeFirstOrThrow();
    expect(row.passwordHash).toStartWith('$argon2id$');
  });

  test('accepts addresses without a public domain (a self-hosted team may use admin@localhost)', async () => {
    expect((await createUser(deps, { email: 'admin@localhost', password: PASSWORD })).email).toBe('admin@localhost');
    expect((await createUser(deps, { email: 'qa@intranet', password: PASSWORD })).email).toBe('qa@intranet');
    for (const email of ['no-at-sign', '@example.com', 'a@', 'a b@example.com', 'a@b@c']) {
      expect((await appError(createUser(deps, { email, password: PASSWORD }))).code).toBe('validation_failed');
    }
  });

  test('defaults to viewer and rejects short passwords and duplicate emails', async () => {
    expect((await createUser(deps, { email: 'a@example.com', password: PASSWORD })).role).toBe('viewer');
    const short = await appError(createUser(deps, { email: 'b@example.com', password: 'short' }));
    expect(short.code).toBe('validation_failed');
    expect(short.errors?.[0]?.path).toBe('password');
    const dup = await appError(createUser(deps, { email: 'A@example.com', password: PASSWORD }));
    expect(dup.code).toBe('email_taken');
    expect(dup.status).toBe(409);
  });

  test('authenticates with any email casing and rejects a wrong password', async () => {
    const user = await createUser(deps, { email: 'ada@example.com', password: PASSWORD });
    expect((await authenticate(deps, ' ADA@example.com', PASSWORD))?.id).toBe(user.id);
    expect(await authenticate(deps, 'ada@example.com', 'wrong password!')).toBeNull();
    expect(await authenticate(deps, 'nobody@example.com', PASSWORD)).toBeNull();
  });

  test('changes the password only with the current one', async () => {
    const user = await createUser(deps, { email: 'ada@example.com', password: PASSWORD });
    const wrong = await appError(
      changePassword(deps, user.id, { currentPassword: 'nope', newPassword: 'another long one' }),
    );
    expect(wrong.code).toBe('invalid_current_password');
    await changePassword(deps, user.id, { currentPassword: PASSWORD, newPassword: 'another long one' });
    expect(await authenticate(deps, 'ada@example.com', 'another long one')).not.toBeNull();
  });

  test('never removes or demotes the last admin', async () => {
    const admin = await createUser(deps, { email: 'root@example.com', password: PASSWORD, role: 'admin' });
    expect((await appError(deleteUser(deps, admin.id))).code).toBe('last_admin');
    expect((await appError(updateUser(deps, admin.id, { role: 'viewer' }))).code).toBe('last_admin');

    const second = await createUser(deps, { email: 'two@example.com', password: PASSWORD, role: 'admin' });
    await updateUser(deps, admin.id, { role: 'viewer' });
    expect((await appError(deleteUser(deps, second.id))).code).toBe('last_admin');
    await deleteUser(deps, admin.id);
    expect((await listUsers(deps)).map((u) => u.email)).toEqual(['two@example.com']);
  });

  test('concurrent deletion of two admins keeps at least one', async () => {
    const a = await createUser(deps, { email: 'a@example.com', password: PASSWORD, role: 'admin' });
    const b = await createUser(deps, { email: 'b@example.com', password: PASSWORD, role: 'admin' });
    await Promise.allSettled([deleteUser(deps, a.id), deleteUser(deps, b.id)]);
    expect((await listUsers(deps)).filter((u) => u.role === 'admin')).toHaveLength(1);
  });

  test('updates email with the same uniqueness rule', async () => {
    await createUser(deps, { email: 'a@example.com', password: PASSWORD });
    const b = await createUser(deps, { email: 'b@example.com', password: PASSWORD });
    expect((await appError(updateUser(deps, b.id, { email: 'A@example.com' }))).code).toBe('email_taken');
    expect((await updateUser(deps, b.id, { email: 'C@example.com' })).email).toBe('c@example.com');
  });

  test('resets a password by email', async () => {
    await createUser(deps, { email: 'ada@example.com', password: PASSWORD });
    await setPasswordByEmail(deps, 'ADA@example.com', 'brand new password');
    expect(await authenticate(deps, 'ada@example.com', 'brand new password')).not.toBeNull();
    expect((await appError(setPasswordByEmail(deps, 'x@example.com', 'brand new password'))).code).toBe(
      'user_not_found',
    );
  });

  test('an update with no changes returns the user unchanged', async () => {
    const user = await createUser(deps, { email: 'ada@example.com', password: PASSWORD, role: 'reviewer' });
    expect(await updateUser(deps, user.id, {})).toEqual(user);
  });
});
