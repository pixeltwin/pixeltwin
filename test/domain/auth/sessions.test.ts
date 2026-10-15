import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createSession, deleteSession, resolveSession, SESSION_TTL_MS } from '../../../src/domain/auth/sessions';
import { changePassword, createUser, deleteUser, setPasswordByEmail } from '../../../src/domain/auth/users';
import { createTestDeps, type TestDeps } from '../../helpers/deps';

describe('sessions', () => {
  let deps: TestDeps;
  let userId: string;

  beforeEach(async () => {
    deps = await createTestDeps();
    await createUser(deps, { email: 'root@example.com', password: 'correct horse battery', role: 'admin' });
    userId = (await createUser(deps, { email: 'ada@example.com', password: 'correct horse battery' })).id;
  });

  afterEach(async () => {
    await deps.handle.close();
  });

  test('resolves a session to its user and stores only a hash', async () => {
    const { token, expiresAt } = await createSession(deps, userId);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(expiresAt).toBeGreaterThan(Date.now() + SESSION_TTL_MS - 5000);
    expect((await resolveSession(deps, token))?.email).toBe('ada@example.com');
    const row = await deps.db.selectFrom('sessions').selectAll().executeTakeFirstOrThrow();
    expect(row.tokenHash).not.toContain(token);
  });

  test('rejects unknown, deleted and expired sessions', async () => {
    expect(await resolveSession(deps, 'nope')).toBeNull();
    const first = await createSession(deps, userId);
    await deleteSession(deps, first.token);
    expect(await resolveSession(deps, first.token)).toBeNull();

    const second = await createSession(deps, userId);
    await deps.db
      .updateTable('sessions')
      .set({ expiresAt: Date.now() - 1 })
      .execute();
    expect(await resolveSession(deps, second.token)).toBeNull();
    expect(await deps.db.selectFrom('sessions').selectAll().execute()).toEqual([]);
  });

  test('extends a session that is more than an hour old', async () => {
    const { token } = await createSession(deps, userId);
    const old = Date.now() + SESSION_TTL_MS - 2 * 60 * 60 * 1000;
    await deps.db.updateTable('sessions').set({ expiresAt: old }).execute();
    await resolveSession(deps, token);
    const row = await deps.db.selectFrom('sessions').selectAll().executeTakeFirstOrThrow();
    expect(row.expiresAt).toBeGreaterThan(old + 60 * 60 * 1000);
  });

  test('deleting a user ends their sessions', async () => {
    const { token } = await createSession(deps, userId);
    await deleteUser(deps, userId);
    expect(await resolveSession(deps, token)).toBeNull();
  });

  test('changing the password ends every other session of that user', async () => {
    const current = await createSession(deps, userId);
    const other = await createSession(deps, userId);
    await changePassword(
      deps,
      userId,
      { currentPassword: 'correct horse battery', newPassword: 'a brand new password' },
      current.token,
    );
    expect(await resolveSession(deps, current.token)).not.toBeNull();
    expect(await resolveSession(deps, other.token)).toBeNull();
  });

  test('an admin password reset ends all sessions of that user', async () => {
    const stolen = await createSession(deps, userId);
    await setPasswordByEmail(deps, 'ada@example.com', 'a brand new password');
    expect(await resolveSession(deps, stolen.token)).toBeNull();
  });
});
