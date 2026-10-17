import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { authenticate, createUser, type UserView } from '../../src/domain/auth/users';
import { listMembers } from '../../src/domain/members';
import { createProject } from '../../src/domain/projects';
import { runRetention } from '../../src/domain/retention';
import {
  approveAccessRequest,
  getSignupSettings,
  listAccessRequests,
  rejectAccessRequest,
  requestAccess,
  updateSignupSettings,
  verifySignup,
} from '../../src/domain/signup';
import { createTestDeps, type TestDeps } from '../helpers/deps';
import { appError } from '../helpers/errors';

const PASSWORD = 'correct horse battery';
const DAY = 24 * 60 * 60 * 1000;

describe('sign-up with admin approval', () => {
  let deps: TestDeps;
  let admin: UserView;
  const open = { verifiedOnly: false };

  beforeEach(async () => {
    deps = await createTestDeps();
    admin = await createUser(deps, { email: 'admin@example.com', password: PASSWORD, role: 'admin' });
    await createProject(deps, { slug: 'mobile', name: 'Mobile app' });
  });

  afterEach(async () => {
    await deps.handle.close();
  });

  const ask = (email: string, verify = false, extra: Record<string, string> = {}) =>
    requestAccess(deps, { email, password: PASSWORD, ...extra }, { verify });

  test('is off by default; settings keep the mode and the allowed domains', async () => {
    expect(await getSignupSettings(deps)).toEqual({ mode: 'off', domains: [] });
    expect((await appError(ask('carol@example.com'))).code).toBe('signup_closed');
    expect(await updateSignupSettings(deps, { mode: 'approval', domains: ' Example.com, contractor.io ' })).toEqual({
      mode: 'approval',
      domains: ['example.com', 'contractor.io'],
    });
    expect(await getSignupSettings(deps)).toEqual({ mode: 'approval', domains: ['example.com', 'contractor.io'] });
    expect((await appError(updateSignupSettings(deps, { mode: 'open', domains: '' }))).code).toBe('validation_failed');
  });

  test('a request makes a pending user that admins approve with projects', async () => {
    await updateSignupSettings(deps, { mode: 'approval', domains: 'example.com' });
    expect((await appError(ask('eve@elsewhere.org'))).code).toBe('signup_refused');
    const outcome = await ask('Carol@Example.com', false, { name: 'Carol', note: 'Need the mobile app' });
    expect(outcome).toMatchObject({ kind: 'requested', email: 'carol@example.com', verifyToken: null });
    const [request] = await listAccessRequests(deps, open);
    expect(request).toMatchObject({
      email: 'carol@example.com',
      name: 'Carol',
      note: 'Need the mobile app',
      verified: false,
    });
    expect((await authenticate(deps, 'carol@example.com', PASSWORD))?.status).toBe('pending');

    const approved = await approveAccessRequest(
      deps,
      request?.id ?? '',
      { role: 'reviewer', projects: [{ slug: 'mobile', role: 'viewer' }] },
      admin.id,
      open,
    );
    expect(approved).toMatchObject({ status: 'approved', decidedBy: 'admin@example.com' });
    expect(await authenticate(deps, 'carol@example.com', PASSWORD)).toMatchObject({
      status: 'active',
      role: 'reviewer',
    });
    expect((await listMembers(deps, 'mobile')).map((m) => [m.email, m.role])).toEqual([
      ['carol@example.com', 'viewer'],
    ]);
    expect(await listAccessRequests(deps, open)).toEqual([]);
    expect((await appError(rejectAccessRequest(deps, request?.id ?? '', {}, admin.id, open))).code).toBe(
      'access_request_decided',
    );
  });

  test('an existing email changes nothing and is told apart only to the caller', async () => {
    await updateSignupSettings(deps, { mode: 'approval', domains: '' });
    expect(await ask('admin@example.com')).toEqual({
      kind: 'existing',
      email: 'admin@example.com',
      pendingVerifyToken: null,
    });
    expect(await listAccessRequests(deps, open)).toEqual([]);
    expect(await authenticate(deps, 'admin@example.com', PASSWORD)).toMatchObject({ role: 'admin', status: 'active' });
  });

  test('with SMTP the request shows to admins only once the email is confirmed', async () => {
    await updateSignupSettings(deps, { mode: 'approval', domains: '' });
    const outcome = await ask('carol@example.com', true);
    if (outcome.kind !== 'requested' || !outcome.verifyToken) throw new Error('expected a verify link');
    expect(await listAccessRequests(deps, { verifiedOnly: true })).toEqual([]);
    const [hidden] = await listAccessRequests(deps, open);
    expect(
      (await appError(approveAccessRequest(deps, hidden?.id ?? '', {}, admin.id, { verifiedOnly: true }))).code,
    ).toBe('access_request_not_found');
    // Asking again before confirming sends a new link (the old one stops working).
    const again = await ask('carol@example.com', true);
    if (again.kind !== 'existing' || !again.pendingVerifyToken) throw new Error('expected a new verify link');
    expect((await appError(verifySignup(deps, outcome.verifyToken))).code).toBe('link_invalid');
    await verifySignup(deps, again.pendingVerifyToken);
    expect((await listAccessRequests(deps, { verifiedOnly: true })).map((r) => [r.email, r.verified])).toEqual([
      ['carol@example.com', true],
    ]);
  });

  test('rejected requests go after 30 days, unconfirmed ones 7 days after their link', async () => {
    await updateSignupSettings(deps, { mode: 'approval', domains: '' });
    await ask('nope@example.com');
    await ask('silent@example.com', true);
    await ask('waiting@example.com');
    const [nope] = (await listAccessRequests(deps, open)).filter((r) => r.email === 'nope@example.com');
    const rejected = await rejectAccessRequest(deps, nope?.id ?? '', { reason: 'Not on the team' }, admin.id, open);
    expect(rejected).toMatchObject({ status: 'rejected', reason: 'Not on the team' });
    expect((await authenticate(deps, 'nope@example.com', PASSWORD))?.status).toBe('rejected');

    expect((await runRetention(deps, Date.now() + 8 * DAY)).signupsDeleted).toBe(1);
    expect(await authenticate(deps, 'silent@example.com', PASSWORD)).toBeNull();
    expect((await runRetention(deps, Date.now() + 31 * DAY)).signupsDeleted).toBe(1);
    expect(await authenticate(deps, 'nope@example.com', PASSWORD)).toBeNull();
    // Without SMTP nobody confirms: such a request waits for an admin however long it takes.
    expect((await listAccessRequests(deps, open)).map((r) => r.email)).toEqual(['waiting@example.com']);
  });
});
