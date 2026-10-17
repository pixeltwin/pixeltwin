import type { OpenAPIHono } from '@hono/zod-openapi';
import type { Context } from 'hono';
import { PROJECT_ROLES, type Project, type ProjectRole, USER_ROLES, type UserRole } from '../../db/schema';
import { linkUrl } from '../../domain/auth/links';
import { hasPermission } from '../../domain/auth/policy';
import { createResetLink } from '../../domain/auth/resets';
import { createUser, deleteUser, listUsers, type UserView, updateUser } from '../../domain/auth/users';
import { type InviteView, inviteToServer, listInvites, resendInvite, revokeInvite } from '../../domain/invites';
import { membershipsOf } from '../../domain/members';
import { listProjects } from '../../domain/projects';
import {
  type AccessRequestView,
  approveAccessRequest,
  getSignupSettings,
  listAccessRequests,
  rejectAccessRequest,
  type SignupSettings,
  updateSignupSettings,
} from '../../domain/signup';
import { AppError } from '../../errors';
import type { AppEnv, Services } from '../../http/env';
import { sendInvite } from '../../http/routes/invites';
import { mailDecision } from '../../http/routes/signup';
import { resetMail } from '../../mail/messages';
import { deliver } from '../../mail/smtp';
import { Ago, describedBy, Field, formErrors, PasswordField, Pill } from '../components';
import { field, noticeOf, type Ui, uiOf, userOf } from '../context';
import { LinkCreated, PendingInvites } from '../invite-forms';
import { Layout } from '../layout';

function requireUserAdmin(c: Context<AppEnv>): void {
  if (!hasPermission(userOf(c), 'user.admin')) throw new AppError('forbidden', 403, 'Only admins can open this page.');
}

const ROLE_HELP =
  'Admins manage everything and see every project. Everyone else sees the projects they are added to, in each project’s settings, and those visible to everyone.';

/** What each role may do, shown under the Role select for the chosen one. */
const ROLE_HINTS: Record<UserRole, string> = {
  viewer:
    'Sees the projects they are added to and those visible to everyone, but cannot change anything unless a project gives them more.',
  reviewer:
    'Approves or rejects changes and manages ignore and compare areas, in the projects they are added to and those visible to everyone. Cannot change users.',
  admin: 'Manages everything: every project, its settings, tokens and members, and users. Reviews too.',
};

type Memberships = Map<string, Array<{ slug: string; name: string; role: ProjectRole }>>;

/** The projects column: admins see every project; others what they were added to. */
function UserProjects({ ui, user, memberships }: { ui: Ui; user: UserView; memberships: Memberships }) {
  if (user.role === 'admin') return <span class="muted">Every project</span>;
  const mine = memberships.get(user.id) ?? [];
  if (mine.length === 0) return <span class="muted">Only projects visible to everyone</span>;
  return (
    <ul class="user-projects">
      {mine.map((m) => (
        <li>
          <a href={ui.url(`/ui/p/${m.slug}/settings#members-title`)}>{m.name}</a> <Pill tone="grey">{m.role}</Pill>
        </li>
      ))}
    </ul>
  );
}

type UserValues = { email?: string | undefined; role?: string | undefined };

function NewUserForm({
  ui,
  values = {},
  errors = {},
  inDialog,
}: {
  ui: Ui;
  values?: UserValues;
  errors?: Record<string, string>;
  inDialog: boolean;
}) {
  const passwordHint = 'At least 10 characters. Share it with them safely.';
  const chosenRole: UserRole = USER_ROLES.find((r) => r === values.role) ?? 'viewer';
  return (
    <form method="post" action={ui.url('/ui/admin/users')}>
      {errors._form && <p class="flash error">{errors._form}</p>}
      <Field id="user-email" label="Email" error={errors.email}>
        <input
          name="email"
          type="email"
          required
          autocomplete="off"
          value={values.email ?? ''}
          {...describedBy('user-email', undefined, errors.email)}
        />
      </Field>
      <Field id="user-password" label="Initial password" hint={passwordHint} error={errors.password}>
        <PasswordField>
          <input
            name="password"
            type="password"
            required
            minlength={10}
            autocomplete="new-password"
            {...describedBy('user-password', passwordHint, errors.password)}
          />
        </PasswordField>
      </Field>
      <Field id="user-role" label="Role" hint={ROLE_HINTS[chosenRole]} error={errors.role}>
        <select name="role" data-hint-from-option {...describedBy('user-role', ROLE_HINTS[chosenRole], errors.role)}>
          {USER_ROLES.map((r) => (
            <option value={r} data-hint={ROLE_HINTS[r]} selected={r === chosenRole}>
              {r}
            </option>
          ))}
        </select>
      </Field>
      <div class="dialog-actions">
        {inDialog ? (
          <button type="button" data-dialog-close>
            Cancel
          </button>
        ) : (
          <a class="button" href={ui.url('/ui/admin/users')}>
            Cancel
          </a>
        )}
        <button class="primary" type="submit">
          Add user
        </button>
      </div>
    </form>
  );
}

type InviteValues = {
  email?: string | undefined;
  role?: string | undefined;
  project?: string | undefined;
  projectRole?: string | undefined;
};

/** Invites someone to the server: a global role, and optionally a project with a role. */
function InviteUserForm({
  ui,
  projects,
  values = {},
  errors = {},
  inDialog,
}: {
  ui: Ui;
  projects: Project[];
  values?: InviteValues;
  errors?: Record<string, string>;
  inDialog: boolean;
}) {
  const chosenRole: UserRole = USER_ROLES.find((r) => r === values.role) ?? 'viewer';
  const projectHint = 'Optional. Admins have every project.';
  return (
    <form method="post" action={ui.url('/ui/admin/invites')}>
      {errors._form && <p class="flash error">{errors._form}</p>}
      <Field id="invite-email" label="Email" error={errors.email}>
        <input
          name="email"
          type="email"
          required
          autocomplete="off"
          value={values.email ?? ''}
          {...describedBy('invite-email', undefined, errors.email)}
        />
      </Field>
      <Field id="invite-role" label="Role" hint={ROLE_HINTS[chosenRole]} error={errors.role}>
        <select name="role" data-hint-from-option {...describedBy('invite-role', ROLE_HINTS[chosenRole], errors.role)}>
          {USER_ROLES.map((r) => (
            <option value={r} data-hint={ROLE_HINTS[r]} selected={r === chosenRole}>
              {r}
            </option>
          ))}
        </select>
      </Field>
      <div class="form-grid">
        <Field id="invite-project" label="Project" hint={projectHint} error={errors.project}>
          <select name="project" {...describedBy('invite-project', projectHint, errors.project)}>
            <option value="">no project</option>
            {projects.map((p) => (
              <option value={p.slug} selected={p.slug === values.project}>
                {p.name}
              </option>
            ))}
          </select>
        </Field>
        <Field id="invite-project-role" label="Role in the project" error={errors.projectRole}>
          <select name="projectRole" {...describedBy('invite-project-role', undefined, errors.projectRole)}>
            {PROJECT_ROLES.map((r) => (
              <option value={r} selected={r === (values.projectRole ?? 'viewer')}>
                {r}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <div class="dialog-actions">
        {inDialog ? (
          <button type="button" data-dialog-close>
            Cancel
          </button>
        ) : (
          <a class="button" href={ui.url('/ui/admin/users')}>
            Cancel
          </a>
        )}
        <button class="primary" type="submit">
          Invite
        </button>
      </div>
    </form>
  );
}

/** Sign-ups waiting for an admin: approve with a role and projects, or turn down with a reason. */
function AccessRequests({ ui, requests, projects }: { ui: Ui; requests: AccessRequestView[]; projects: Project[] }) {
  if (requests.length === 0) return null;
  return (
    <section class="access-requests" aria-labelledby="requests-title">
      <h2 id="requests-title">
        Access requests <span class="count-badge">{String(requests.length)}</span>
      </h2>
      <ul class="request-list">
        {requests.map((r) => (
          <li class="panel request">
            <div class="request-head">
              <strong>{r.email}</strong>
              {r.name && <span>{r.name}</span>}
              {r.verified ? <Pill tone="green">email confirmed</Pill> : <Pill tone="amber">email not verified</Pill>}
              <span class="muted">
                {'asked '}
                <Ago at={r.createdAt} />
              </span>
            </div>
            {r.note && <p class="request-note">{r.note}</p>}
            <div class="request-actions">
              <details>
                <summary class="button primary small">Approve…</summary>
                <form method="post" action={ui.url(`/ui/admin/requests/${r.id}/approve`)}>
                  <Field id={`approve-role-${r.id}`} label="Server role">
                    <select name="role" id={`approve-role-${r.id}`}>
                      {USER_ROLES.map((role) => (
                        <option value={role} selected={role === 'viewer'}>
                          {role}
                        </option>
                      ))}
                    </select>
                  </Field>
                  {projects.length > 0 && (
                    <fieldset>
                      <legend>Projects</legend>
                      {projects.map((p) => (
                        <label class="scope">
                          <input type="checkbox" name="project" value={p.slug} />
                          <span>{p.name}</span>
                          <select name={`role-${p.slug}`} aria-label={`Role in ${p.name}`}>
                            {PROJECT_ROLES.map((role) => (
                              <option value={role}>{role}</option>
                            ))}
                          </select>
                        </label>
                      ))}
                    </fieldset>
                  )}
                  <div class="form-actions">
                    <button class="primary" type="submit">
                      Approve
                    </button>
                  </div>
                </form>
              </details>
              <details>
                <summary class="button small">Turn down…</summary>
                <form method="post" action={ui.url(`/ui/admin/requests/${r.id}/reject`)}>
                  <Field id={`reject-reason-${r.id}`} label="Reason (optional, they see it)">
                    <input name="reason" id={`reject-reason-${r.id}`} type="text" maxlength={1000} />
                  </Field>
                  <div class="form-actions">
                    <button class="danger" type="submit">
                      Turn down
                    </button>
                  </div>
                </form>
              </details>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

function SignupSettingsForm({ ui, settings, mailer }: { ui: Ui; settings: SignupSettings; mailer: boolean }) {
  const hint = 'Comma-separated, e.g. company.com, contractor.io. Empty: any domain.';
  return (
    <section class="settings-section" aria-labelledby="signup-title">
      <div class="section-head">
        <h2 id="signup-title">Sign-up</h2>
        <p class="muted">
          {mailer
            ? 'People who ask for access confirm their email first; you approve them here.'
            : 'Without SMTP, emails are not confirmed: requests come marked "email not verified" and your approval is the check.'}
        </p>
      </div>
      <form class="panel" method="post" action={ui.url('/ui/admin/signup')}>
        <div class="form-grid">
          <Field id="signup-mode" label="Requests">
            <select name="mode" id="signup-mode">
              <option value="off" selected={settings.mode === 'off'}>
                off: only admins add people
              </option>
              <option value="approval" selected={settings.mode === 'approval'}>
                on: anyone may ask, an admin approves
              </option>
            </select>
          </Field>
          <Field id="signup-domains" label="Allowed email domains" hint={hint}>
            <input
              name="domains"
              type="text"
              value={settings.domains.join(', ')}
              {...describedBy('signup-domains', hint)}
            />
          </Field>
        </div>
        <div class="form-actions">
          <button class="primary" type="submit">
            Save
          </button>
        </div>
      </form>
    </section>
  );
}

function UsersPage({
  ui,
  users,
  memberships,
  projects,
  invites,
  requests,
  signup,
  mailer,
  newLink,
  notice,
  error,
}: {
  ui: Ui;
  users: UserView[];
  memberships: Memberships;
  projects: Project[];
  invites: InviteView[];
  requests: AccessRequestView[];
  signup: SignupSettings;
  mailer: boolean;
  newLink?: { title: string; email: string; link: string; mailed: boolean; note: string } | undefined;
  notice?: string;
  error?: string;
}) {
  return (
    <Layout ui={ui} title="Users" notice={notice} error={error} crumbs={[{ label: 'Users' }]}>
      <div class="page-head">
        <div>
          <h1>Users</h1>
          <p class="sub">{ROLE_HELP}</p>
        </div>
        <div class="page-actions">
          <a class="button" href={ui.url('/ui/admin/users/new')} data-dialog-open="new-user">
            Add user
          </a>
          <a class="button primary" href={ui.url('/ui/admin/invites/new')} data-dialog-open="invite-user">
            Invite user
          </a>
        </div>
      </div>
      {newLink && (
        <section class="panel">
          <LinkCreated {...newLink} />
        </section>
      )}
      <AccessRequests ui={ui} requests={requests} projects={projects} />
      <table class="stack-on-phone">
        <thead>
          <tr>
            <th>User</th>
            <th>Role</th>
            <th>Projects</th>
            <th>Added</th>
            <th>
              <span class="visually-hidden">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {users.map((u) => (
            <tr>
              <td>
                <span class="user-cell">
                  <span class="avatar" aria-hidden="true">
                    {u.email.charAt(0).toUpperCase()}
                  </span>
                  {u.email}
                  {u.id === ui.user?.id && <span class="you">you</span>}
                  {u.status === 'pending' && <Pill tone="amber">waiting for approval</Pill>}
                  {u.status === 'rejected' && <Pill tone="grey">turned down</Pill>}
                </span>
              </td>
              <td>
                {/* With JavaScript a change saves at once; the Save button is for browsers without it. */}
                <form class="inline" method="post" action={ui.url(`/ui/admin/users/${u.id}`)} data-autosubmit>
                  <select name="role" aria-label={`Role of ${u.email}`}>
                    {USER_ROLES.map((r) => (
                      <option value={r} selected={r === u.role}>
                        {r}
                      </option>
                    ))}
                  </select>
                  <button type="submit" class="no-js">
                    Save
                  </button>
                </form>
              </td>
              <td>
                <UserProjects ui={ui} user={u} memberships={memberships} />
              </td>
              <td>
                <Ago at={u.createdAt} />
              </td>
              <td>
                <span class="row-actions">
                  <form method="post" action={ui.url(`/ui/admin/users/${u.id}/reset-link`)}>
                    <button class="small" type="submit" title="A one-time link to set a new password, for an hour">
                      Reset link
                    </button>
                  </form>
                  <form method="post" action={ui.url(`/ui/admin/users/${u.id}/delete`)}>
                    <button
                      class="danger small"
                      type="submit"
                      data-confirm={`Delete ${u.email}? They can no longer log in.`}
                      data-confirm-label="Delete"
                    >
                      Delete
                    </button>
                  </form>
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <PendingInvites ui={ui} invites={invites} base="/ui/admin/invites" showProject />
      <SignupSettingsForm ui={ui} settings={signup} mailer={mailer} />
      <dialog id="new-user" aria-labelledby="new-user-title">
        <h2 id="new-user-title">Add user</h2>
        <NewUserForm ui={ui} inDialog />
      </dialog>
      <dialog id="invite-user" aria-labelledby="invite-user-title">
        <h2 id="invite-user-title">Invite user</h2>
        <InviteUserForm ui={ui} projects={projects} inDialog />
      </dialog>
    </Layout>
  );
}

function InviteUserPage(props: {
  ui: Ui;
  projects: Project[];
  values?: InviteValues;
  errors?: Record<string, string>;
}) {
  return (
    <Layout
      ui={props.ui}
      title="Invite user"
      crumbs={[{ label: 'Users', href: props.ui.url('/ui/admin/users') }, { label: 'Invite user' }]}
    >
      <div class="panel narrow">
        <h1>Invite user</h1>
        <InviteUserForm
          ui={props.ui}
          projects={props.projects}
          values={props.values}
          errors={props.errors}
          inDialog={false}
        />
      </div>
    </Layout>
  );
}

function NewUserPage(props: { ui: Ui; values?: UserValues; errors?: Record<string, string> }) {
  return (
    <Layout
      ui={props.ui}
      title="Add user"
      crumbs={[{ label: 'Users', href: props.ui.url('/ui/admin/users') }, { label: 'Add user' }]}
    >
      <div class="panel narrow">
        <h1>Add user</h1>
        <NewUserForm ui={props.ui} values={props.values} errors={props.errors} inDialog={false} />
      </div>
    </Layout>
  );
}

function messageOf(err: unknown): string {
  if (!(err instanceof AppError) || err.status >= 500) throw err;
  return err.errors?.length ? err.errors.map((e) => `${e.path}: ${e.message}`).join('; ') : err.detail;
}

function statusOf(err: unknown): 400 | 403 | 404 | 409 | 422 {
  return (err instanceof AppError ? err.status : 422) as 400 | 403 | 404 | 409 | 422;
}

export function registerUserPages(app: OpenAPIHono<AppEnv>, s: Services): void {
  const list = async (
    c: Context<AppEnv>,
    error?: string,
    newLink?: { title: string; email: string; link: string; mailed: boolean; note: string },
  ) => {
    const [users, memberships, projects, invites, requests, signup] = await Promise.all([
      listUsers(s.deps),
      membershipsOf(s.deps),
      listProjects(s.deps),
      listInvites(s.deps, null),
      listAccessRequests(s.deps, { verifiedOnly: !!s.mailer }),
      getSignupSettings(s.deps),
    ]);
    return (
      <UsersPage
        ui={uiOf(c, s)}
        users={users}
        memberships={memberships}
        projects={projects}
        invites={invites}
        requests={requests}
        signup={signup}
        mailer={!!s.mailer}
        newLink={newLink}
        notice={noticeOf(c)}
        {...(error ? { error } : {})}
      />
    );
  };

  const inviteLink = (invite: InviteView, token: string) => ({
    title: `Invite for ${invite.email}`,
    email: invite.email,
    note: 'It works once, for 7 days, and creates their account.',
    ...sendInvite(s, invite, token),
  });

  app.get('/ui/admin/invites/new', async (c) => {
    requireUserAdmin(c);
    return c.html(<InviteUserPage ui={uiOf(c, s)} projects={await listProjects(s.deps)} />);
  });

  app.post('/ui/admin/invites', async (c) => {
    requireUserAdmin(c);
    const form = await c.req.parseBody();
    const values = {
      email: field(form, 'email'),
      role: field(form, 'role'),
      project: field(form, 'project') || undefined,
      projectRole: field(form, 'projectRole') || undefined,
    };
    try {
      const input = Object.fromEntries(Object.entries(values).filter(([, v]) => v !== undefined));
      const result = await inviteToServer(s.deps, input, userOf(c).id);
      if (result.kind === 'member') return c.redirect(uiOf(c, s).url('/ui/admin/users?done=member-had-account'), 303);
      return c.html(await list(c, undefined, inviteLink(result.invite, result.token)), 201);
    } catch (err) {
      if (!(err instanceof AppError) || err.status >= 500) throw err;
      return c.html(
        <InviteUserPage
          ui={uiOf(c, s)}
          projects={await listProjects(s.deps)}
          values={values}
          errors={formErrors(err)}
        />,
        statusOf(err),
      );
    }
  });

  app.post('/ui/admin/invites/:id/resend', async (c) => {
    requireUserAdmin(c);
    const { invite, token } = await resendInvite(s.deps, c.req.param('id'));
    return c.html(await list(c, undefined, inviteLink(invite, token)), 201);
  });

  app.post('/ui/admin/invites/:id/delete', async (c) => {
    requireUserAdmin(c);
    await revokeInvite(s.deps, c.req.param('id'));
    return c.redirect(uiOf(c, s).url('/ui/admin/users?done=invite-revoked'), 303);
  });

  app.post('/ui/admin/signup', async (c) => {
    requireUserAdmin(c);
    const form = await c.req.parseBody();
    try {
      await updateSignupSettings(s.deps, { mode: field(form, 'mode'), domains: field(form, 'domains') ?? '' });
      return c.redirect(uiOf(c, s).url('/ui/admin/users?done=signup-saved#signup-title'), 303);
    } catch (err) {
      return c.html(await list(c, messageOf(err)), statusOf(err));
    }
  });

  for (const action of ['approve', 'reject'] as const) {
    app.post(`/ui/admin/requests/:id/${action}`, async (c) => {
      requireUserAdmin(c);
      const form = await c.req.parseBody({ all: true });
      const options = { verifiedOnly: !!s.mailer };
      try {
        let request: AccessRequestView;
        if (action === 'approve') {
          const picked = ([] as unknown[]).concat(form.project ?? []).filter((v): v is string => typeof v === 'string');
          const projects = picked.map((slug) => ({ slug, role: field(form, `role-${slug}`) || 'viewer' }));
          request = await approveAccessRequest(
            s.deps,
            c.req.param('id'),
            { role: field(form, 'role') || 'viewer', projects },
            userOf(c).id,
            options,
          );
        } else {
          const reason = field(form, 'reason');
          request = await rejectAccessRequest(
            s.deps,
            c.req.param('id'),
            reason ? { reason } : {},
            userOf(c).id,
            options,
          );
        }
        mailDecision(s, request);
        const done = action === 'approve' ? 'request-approved' : 'request-rejected';
        return c.redirect(uiOf(c, s).url(`/ui/admin/users?done=${done}`), 303);
      } catch (err) {
        return c.html(await list(c, messageOf(err)), statusOf(err));
      }
    });
  }

  app.post('/ui/admin/users/:id/reset-link', async (c) => {
    requireUserAdmin(c);
    const { token, email } = await createResetLink(s.deps, c.req.param('id'), userOf(c).id);
    const link = linkUrl(s.config.publicUrl, 'password_reset', token);
    void deliver(s.mailer, resetMail(email, link), s.logger.warn, 'password reset');
    const note = 'It works once, for an hour, and ends their other sessions.';
    return c.html(
      await list(c, undefined, { title: `Reset link for ${email}`, email, link, mailed: !!s.mailer, note }),
      201,
    );
  });

  app.get('/ui/admin/users', async (c) => {
    requireUserAdmin(c);
    return c.html(await list(c));
  });

  app.get('/ui/admin/users/new', (c) => {
    requireUserAdmin(c);
    return c.html(<NewUserPage ui={uiOf(c, s)} />);
  });

  app.post('/ui/admin/users', async (c) => {
    requireUserAdmin(c);
    const ui = uiOf(c, s);
    const form = await c.req.parseBody();
    const values = { email: field(form, 'email'), role: field(form, 'role') };
    try {
      await createUser(s.deps, { ...values, password: form.password });
      return c.redirect(ui.url('/ui/admin/users?done=user-created'), 303);
    } catch (err) {
      if (!(err instanceof AppError) || err.status >= 500) throw err;
      return c.html(<NewUserPage ui={ui} values={values} errors={formErrors(err)} />, statusOf(err));
    }
  });

  app.post('/ui/admin/users/:id', async (c) => {
    requireUserAdmin(c);
    const form = await c.req.parseBody();
    try {
      await updateUser(s.deps, c.req.param('id'), { role: field(form, 'role') });
      return c.redirect(uiOf(c, s).url('/ui/admin/users?done=user-saved'), 303);
    } catch (err) {
      return c.html(await list(c, messageOf(err)), statusOf(err));
    }
  });

  app.post('/ui/admin/users/:id/delete', async (c) => {
    requireUserAdmin(c);
    try {
      await deleteUser(s.deps, c.req.param('id'));
      return c.redirect(uiOf(c, s).url('/ui/admin/users?done=user-deleted'), 303);
    } catch (err) {
      return c.html(await list(c, messageOf(err)), statusOf(err));
    }
  });
}
