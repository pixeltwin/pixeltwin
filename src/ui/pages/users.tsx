import type { OpenAPIHono } from '@hono/zod-openapi';
import type { Context } from 'hono';
import { USER_ROLES } from '../../db/schema';
import { hasPermission } from '../../domain/auth/policy';
import { createUser, deleteUser, listUsers, type UserView, updateUser } from '../../domain/auth/users';
import { AppError } from '../../errors';
import type { AppEnv, Services } from '../../http/env';
import { Ago, describedBy, Field, formErrors, PasswordField } from '../components';
import { field, noticeOf, type Ui, uiOf, userOf } from '../context';
import { Layout } from '../layout';

function requireUserAdmin(c: Context<AppEnv>): void {
  if (!hasPermission(userOf(c), 'user.admin')) throw new AppError('forbidden', 403, 'Only admins can open this page.');
}

const ROLE_HELP =
  'Admins manage everything. Reviewers approve or reject changes and manage ignore and compare areas. Viewers only look.';

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
      <Field id="user-role" label="Role" hint={ROLE_HELP} error={errors.role}>
        <select name="role" {...describedBy('user-role', ROLE_HELP, errors.role)}>
          {USER_ROLES.map((r) => (
            <option value={r} selected={r === (values.role ?? 'viewer')}>
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

function UsersPage({ ui, users, notice, error }: { ui: Ui; users: UserView[]; notice?: string; error?: string }) {
  return (
    <Layout ui={ui} title="Users" notice={notice} error={error} crumbs={[{ label: 'Users' }]}>
      <div class="page-head">
        <div>
          <h1>Users</h1>
          <p class="sub">{ROLE_HELP}</p>
        </div>
        <div class="page-actions">
          <a class="button primary" href={ui.url('/ui/admin/users/new')} data-dialog-open="new-user">
            Add user
          </a>
        </div>
      </div>
      <table class="stack-on-phone">
        <thead>
          <tr>
            <th>User</th>
            <th>Role</th>
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
                <Ago at={u.createdAt} />
              </td>
              <td>
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
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <dialog id="new-user" aria-labelledby="new-user-title">
        <h2 id="new-user-title">Add user</h2>
        <NewUserForm ui={ui} inDialog />
      </dialog>
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
  const list = async (c: Context<AppEnv>, error?: string) => (
    <UsersPage ui={uiOf(c, s)} users={await listUsers(s.deps)} notice={noticeOf(c)} {...(error ? { error } : {})} />
  );

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
