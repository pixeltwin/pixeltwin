import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { completeSetup, SetupState } from '../../../src/domain/auth/setup';
import { authenticate, createUser } from '../../../src/domain/auth/users';
import { createTestDeps, type TestDeps } from '../../helpers/deps';
import { appError } from '../../helpers/errors';

describe('setup', () => {
  let deps: TestDeps;

  beforeEach(async () => {
    deps = await createTestDeps();
  });

  afterEach(async () => {
    await deps.handle.close();
  });

  test('issues a token only while there are no users', async () => {
    const empty = await SetupState.init(deps);
    expect(empty.token).toMatch(/^[0-9A-Za-z]{32}$/);
    expect(empty.state.open).toBe(true);
    await createUser(deps, { email: 'a@example.com', password: 'correct horse battery' });
    const later = await SetupState.init(deps);
    expect(later.token).toBeNull();
    expect(later.state.open).toBe(false);
  });

  test('the right token creates the first admin, once', async () => {
    const { state, token } = await SetupState.init(deps);
    const input = { token, email: 'Root@Example.com', password: 'correct horse battery' };
    const admin = await completeSetup(deps, state, input);
    expect(admin).toMatchObject({ email: 'root@example.com', role: 'admin' });
    expect(await authenticate(deps, 'root@example.com', 'correct horse battery')).not.toBeNull();
    expect((await appError(completeSetup(deps, state, input))).code).toBe('setup_complete');
  });

  test('a wrong token is refused and creates nothing', async () => {
    const { state } = await SetupState.init(deps);
    const err = await appError(
      completeSetup(deps, state, { token: 'x', email: 'a@b.co', password: 'correct horse battery' }),
    );
    expect(err.code).toBe('invalid_setup_token');
    expect(err.status).toBe(403);
    expect(state.open).toBe(true);
    expect(await deps.db.selectFrom('users').selectAll().execute()).toEqual([]);
  });
});
