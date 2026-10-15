import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  createProjectToken,
  deleteProjectToken,
  listProjectTokens,
  resolveProjectToken,
} from '../../../src/domain/auth/tokens';
import { createProject } from '../../../src/domain/projects';
import { createTestDeps, type TestDeps } from '../../helpers/deps';
import { appError } from '../../helpers/errors';

describe('project tokens', () => {
  let deps: TestDeps;

  beforeEach(async () => {
    deps = await createTestDeps();
    await createProject(deps, { slug: 'web', name: 'Web' });
    await createProject(deps, { slug: 'app', name: 'App' });
  });

  afterEach(async () => {
    await deps.handle.close();
  });

  test('creates a token shown once and resolves it to its project and scopes', async () => {
    const { token, view } = await createProjectToken(deps, 'web', { name: 'CI', scopes: ['write', 'read', 'write'] });
    expect(token).toMatch(/^pt_[0-9A-Za-z]{8}_[0-9A-Za-z]{32}$/);
    expect(view).toMatchObject({ name: 'CI', scopes: ['read', 'write'], lastUsedAt: null });
    expect(token.startsWith(view.prefix)).toBe(true);

    const resolved = await resolveProjectToken(deps, token);
    expect(resolved).toEqual({ id: view.id, projectId: view.projectId, scopes: ['read', 'write'] });
    const [listed] = await listProjectTokens(deps, 'web');
    expect(listed?.lastUsedAt).toBeNumber();
    expect(JSON.stringify(listed)).not.toContain(token.slice(12));
  });

  test('rejects malformed, unknown and tampered tokens', async () => {
    const { token } = await createProjectToken(deps, 'web', { name: 'CI', scopes: ['read'] });
    expect(await resolveProjectToken(deps, 'Bearer nonsense')).toBeNull();
    expect(await resolveProjectToken(deps, `pt_ZZZZZZZZ_${'a'.repeat(32)}`)).toBeNull();
    const tampered = `${token.slice(0, -1)}${token.endsWith('a') ? 'b' : 'a'}`;
    expect(await resolveProjectToken(deps, tampered)).toBeNull();
  });

  test('validates scopes', async () => {
    const err = await appError(createProjectToken(deps, 'web', { name: 'CI', scopes: ['admin'] }));
    expect(err.code).toBe('validation_failed');
    expect((await appError(createProjectToken(deps, 'web', { name: 'CI', scopes: [] }))).code).toBe(
      'validation_failed',
    );
  });

  test('deletes a token only within its project', async () => {
    const { token, view } = await createProjectToken(deps, 'web', { name: 'CI', scopes: ['read'] });
    expect((await appError(deleteProjectToken(deps, 'app', view.id))).code).toBe('token_not_found');
    await deleteProjectToken(deps, 'web', view.id);
    expect(await resolveProjectToken(deps, token)).toBeNull();
    expect(await listProjectTokens(deps, 'web')).toEqual([]);
  });
});
