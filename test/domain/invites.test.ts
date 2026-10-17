import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { LINK_TTL_MS } from '../../src/domain/auth/links';
import { sha256 } from '../../src/domain/auth/random';
import { acceptReset, createResetLink } from '../../src/domain/auth/resets';
import { createSession, resolveSession } from '../../src/domain/auth/sessions';
import { authenticate, createUser, type UserView } from '../../src/domain/auth/users';
import {
  acceptInvite,
  describeLink,
  inviteToProject,
  inviteToServer,
  listInvites,
  resendInvite,
  revokeInvite,
} from '../../src/domain/invites';
import { listMembers } from '../../src/domain/members';
import { createProject } from '../../src/domain/projects';
import { createTestDeps, type TestDeps } from '../helpers/deps';
import { appError } from '../helpers/errors';

const PASSWORD = 'correct horse battery';
const NEW_PASSWORD = 'a brand new password';

describe('invites', () => {
  let deps: TestDeps;
  let admin: UserView;
  let webId: string;

  beforeEach(async () => {
    deps = await createTestDeps();
    admin = await createUser(deps, { email: 'admin@example.com', password: PASSWORD, role: 'admin' });
    webId = (await createProject(deps, { slug: 'web', name: 'Web shop' })).id;
    await createProject(deps, { slug: 'app', name: 'App' });
  });

  afterEach(async () => {
    await deps.handle.close();
  });

  const invite = async (slug: string, email: string, role?: string) => {
    const result = await inviteToProject(deps, slug, { email, ...(role ? { role } : {}) }, admin.id);
    if (result.kind !== 'invite') throw new Error('expected an invite');
    return result;
  };

  test('stores only the hash of a token that works once, within 7 days', async () => {
    const { token, invite: view } = await invite('web', 'Ann@Example.com', 'reviewer');
    expect(view).toMatchObject({ email: 'ann@example.com', project: { slug: 'web' }, projectRole: 'reviewer' });
    expect(view.expiresAt - view.createdAt).toBe(LINK_TTL_MS.invite);
    const rows = await deps.db.selectFrom('authLinks').selectAll().execute();
    expect(rows.map((r) => r.tokenHash)).toEqual([sha256(token)]);
    expect(JSON.stringify(rows)).not.toContain(token);

    expect(await describeLink(deps, token)).toMatchObject({
      purpose: 'invite',
      email: 'ann@example.com',
      projects: ['Web shop'],
    });
    const user = await acceptInvite(deps, token, { password: NEW_PASSWORD });
    expect(user).toMatchObject({ email: 'ann@example.com', role: 'viewer', status: 'active' });
    expect((await listMembers(deps, 'web')).map((m) => [m.email, m.role])).toEqual([['ann@example.com', 'reviewer']]);
    expect(await authenticate(deps, 'ann@example.com', NEW_PASSWORD)).toBeTruthy();
    expect((await appError(acceptInvite(deps, token, { password: NEW_PASSWORD }))).code).toBe('link_used');
    expect(await listInvites(deps, null)).toEqual([]);
  });

  test('an expired, revoked or unknown link does not work', async () => {
    const { token, invite: view } = await invite('web', 'ann@example.com');
    await deps.db
      .updateTable('authLinks')
      .set({ expiresAt: Date.now() - 1 })
      .execute();
    expect((await appError(acceptInvite(deps, token, { password: NEW_PASSWORD }))).code).toBe('link_expired');
    expect(await listInvites(deps, webId)).toEqual([]);
    const again = await invite('web', 'bob@example.com');
    await revokeInvite(deps, again.invite.id);
    expect((await appError(describeLink(deps, again.token))).code).toBe('link_invalid');
    expect((await appError(describeLink(deps, 'nope'))).code).toBe('link_invalid');
    // An expired invite can still be revoked (tidied away), once.
    await revokeInvite(deps, view.id);
    expect((await appError(revokeInvite(deps, view.id))).code).toBe('invite_not_found');
  });

  test('re-inviting or resending replaces the older link', async () => {
    const first = await invite('web', 'ann@example.com', 'viewer');
    const second = await invite('web', 'ann@example.com', 'maintainer');
    expect((await appError(describeLink(deps, first.token))).code).toBe('link_invalid');
    const resent = await resendInvite(deps, second.invite.id);
    expect((await appError(describeLink(deps, second.token))).code).toBe('link_invalid');
    expect(resent.invite).toMatchObject({ email: 'ann@example.com', projectRole: 'maintainer' });
    expect((await listInvites(deps, webId)).map((i) => i.id)).toEqual([resent.invite.id]);
  });

  test('accepting applies every pending invite of the email; the highest global role wins', async () => {
    const web = await invite('web', 'ann@example.com', 'maintainer');
    const app = await inviteToServer(deps, { email: 'ann@example.com', role: 'reviewer', project: 'app' }, admin.id);
    if (app.kind !== 'invite') throw new Error('expected an invite');
    const user = await acceptInvite(deps, web.token, { password: NEW_PASSWORD });
    expect(user.role).toBe('reviewer');
    expect((await listMembers(deps, 'web')).map((m) => m.role)).toEqual(['maintainer']);
    expect((await listMembers(deps, 'app')).map((m) => m.role)).toEqual(['reviewer']);
    expect((await appError(acceptInvite(deps, app.token, { password: NEW_PASSWORD }))).code).toBe('link_used');
  });

  test('an email with an account becomes a member at once, without a link', async () => {
    await createUser(deps, { email: 'carol@example.com', password: PASSWORD, role: 'viewer' });
    const result = await inviteToProject(deps, 'web', { email: 'carol@example.com', role: 'reviewer' }, admin.id);
    expect(result).toMatchObject({ kind: 'member', member: { email: 'carol@example.com', role: 'reviewer' } });
    expect(await deps.db.selectFrom('authLinks').selectAll().execute()).toEqual([]);
    expect((await appError(inviteToServer(deps, { email: 'carol@example.com' }, admin.id))).code).toBe('email_taken');
    expect((await appError(inviteToProject(deps, 'web', { email: 'admin@example.com' }, admin.id))).code).toBe(
      'user_is_admin',
    );
  });

  test('project invites give project roles only; admins may invite admins without a project', async () => {
    expect(
      (await appError(inviteToProject(deps, 'web', { email: 'x@example.com', role: 'admin' }, admin.id))).code,
    ).toBe('validation_failed');
    const boss = await inviteToServer(deps, { email: 'boss@example.com', role: 'admin', project: 'web' }, admin.id);
    if (boss.kind !== 'invite') throw new Error('expected an invite');
    expect(boss.invite).toMatchObject({ role: 'admin', project: null });
    expect((await acceptInvite(deps, boss.token, { password: NEW_PASSWORD })).role).toBe('admin');
    expect(await listMembers(deps, 'web')).toEqual([]);
  });

  test('a password shorter than the policy is refused and the link stays usable', async () => {
    const { token } = await invite('web', 'ann@example.com');
    expect((await appError(acceptInvite(deps, token, { password: 'short' }))).code).toBe('validation_failed');
    expect((await acceptInvite(deps, token, { password: NEW_PASSWORD })).email).toBe('ann@example.com');
  });
});

describe('password reset links', () => {
  let deps: TestDeps;
  let ann: UserView;

  beforeEach(async () => {
    deps = await createTestDeps();
    ann = await createUser(deps, { email: 'ann@example.com', password: PASSWORD, role: 'viewer' });
  });

  afterEach(async () => {
    await deps.handle.close();
  });

  test('set a new password once within an hour and end every session', async () => {
    const session = await createSession(deps, ann.id);
    const first = await createResetLink(deps, ann.id, null);
    const { token, expiresAt } = await createResetLink(deps, ann.id, null);
    expect(expiresAt - Date.now()).toBeLessThanOrEqual(LINK_TTL_MS.password_reset);
    expect((await appError(acceptReset(deps, first.token, { password: NEW_PASSWORD }))).code).toBe('link_invalid');
    await acceptReset(deps, token, { password: NEW_PASSWORD });
    expect(await authenticate(deps, 'ann@example.com', NEW_PASSWORD)).toBeTruthy();
    expect(await resolveSession(deps, session.token)).toBeNull();
    expect((await appError(acceptReset(deps, token, { password: NEW_PASSWORD }))).code).toBe('link_used');
  });

  test('an invite link is not a reset link', async () => {
    const result = await inviteToProject(deps, 'nope', { email: 'x@example.com' }, ann.id).catch((e: unknown) => e);
    expect((result as { code?: string }).code).toBe('project_not_found');
    const { token } = await createResetLink(deps, ann.id, null);
    expect((await appError(acceptInvite(deps, token, { password: NEW_PASSWORD }))).code).toBe('link_invalid');
  });
});
