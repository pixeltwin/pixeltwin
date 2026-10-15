import type { OpenAPIHono } from '@hono/zod-openapi';
import type { Context } from 'hono';
import type { Project } from '../../db/schema';
import { USER_ROLES } from '../../db/schema';
import { hasPermission, type Permission } from '../../domain/auth/policy';
import {
  createProjectToken,
  deleteProjectToken,
  listProjectTokens,
  TOKEN_SCOPES,
  type TokenView,
} from '../../domain/auth/tokens';
import { createUser, deleteUser, listUsers, type UserView, updateUser } from '../../domain/auth/users';
import { deleteProject, getProjectBySlug, updateProject } from '../../domain/projects';
import { AppError } from '../../errors';
import type { AppEnv, Services } from '../../http/env';
import { When } from '../components';
import { field, noticeOf, type Ui, uiOf, userOf } from '../context';
import { Layout } from '../layout';

function requireAdmin(c: Context<AppEnv>, permission: Permission): void {
  if (!hasPermission(userOf(c), permission)) throw new AppError('forbidden', 403, 'Only admins can open this page.');
}

function messageOf(err: unknown): string {
  if (!(err instanceof AppError) || err.status >= 500) throw err;
  return err.errors?.length ? err.errors.map((e) => `${e.path}: ${e.message}`).join('; ') : err.detail;
}

function statusOf(err: unknown): 400 | 403 | 404 | 409 | 422 {
  return (err instanceof AppError ? err.status : 422) as 400 | 403 | 404 | 409 | 422;
}

function UsersPage({ ui, users, notice, error }: { ui: Ui; users: UserView[]; notice?: string; error?: string }) {
  return (
    <Layout ui={ui} title="Users" notice={notice} error={error}>
      <h1>Users</h1>
      <p class="sub">Admins manage everything; reviewers approve and reject; viewers only look.</p>
      <table>
        <thead>
          <tr>
            <th>Email</th>
            <th>Role</th>
            <th>Created</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {users.map((u) => (
            <tr>
              <td>{u.email}</td>
              <td>
                <form class="inline" method="post" action={ui.url(`/ui/admin/users/${u.id}`)}>
                  <select name="role" aria-label={`Role of ${u.email}`}>
                    {USER_ROLES.map((r) => (
                      <option value={r} selected={r === u.role}>
                        {r}
                      </option>
                    ))}
                  </select>
                  <button type="submit">Save</button>
                </form>
              </td>
              <td>
                <When at={u.createdAt} />
              </td>
              <td>
                <form class="inline" method="post" action={ui.url(`/ui/admin/users/${u.id}/delete`)}>
                  <button class="danger" type="submit" data-confirm={`Delete ${u.email}?`}>
                    Delete
                  </button>
                </form>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <h2>New user</h2>
      <form class="panel row" method="post" action={ui.url('/ui/admin/users')}>
        <div>
          <label for="email">Email</label>
          <input id="email" name="email" type="email" required />
        </div>
        <div>
          <label for="password">Initial password (10+ characters)</label>
          <input id="password" name="password" type="password" minlength={10} required autocomplete="new-password" />
        </div>
        <div>
          <label for="role">Role</label>
          <select id="role" name="role">
            {USER_ROLES.map((r) => (
              <option value={r} selected={r === 'viewer'}>
                {r}
              </option>
            ))}
          </select>
        </div>
        <button class="primary" type="submit">
          Create
        </button>
      </form>
    </Layout>
  );
}

function SettingsPage(props: {
  ui: Ui;
  project: Project;
  tokens: TokenView[];
  newToken?: { name: string; token: string };
  notice?: string | undefined;
  error?: string;
}) {
  const { ui, project, tokens } = props;
  const base = `/ui/p/${project.slug}/settings`;
  return (
    <Layout ui={ui} title={`${project.name} settings`} notice={props.notice} error={props.error}>
      <p class="muted">
        <a href={ui.url(`/ui/p/${project.slug}`)}>{project.name}</a>
      </p>
      <h1>Settings</h1>
      {props.newToken && (
        <div class="panel">
          <p>
            <strong>{`Token “${props.newToken.name}” created.`}</strong> Copy it now; it is not shown again.
          </p>
          <p class="secret">{props.newToken.token}</p>
        </div>
      )}
      <form class="panel" method="post" action={ui.url(base)}>
        <div class="row">
          <div>
            <label for="name">Name</label>
            <input id="name" name="name" type="text" required value={project.name} />
          </div>
          <div>
            <label for="mainBranch">Main branch</label>
            <input id="mainBranch" name="mainBranch" type="text" required value={project.mainBranch} />
          </div>
        </div>
        <div class="row">
          <div>
            <label for="colorThreshold">Colour threshold (0–1)</label>
            <input
              id="colorThreshold"
              name="colorThreshold"
              type="number"
              min={0}
              max={1}
              step="any"
              value={String(project.colorThreshold)}
            />
          </div>
          <div>
            <label for="tolerancePercent">Tolerance (% of pixels)</label>
            <input
              id="tolerancePercent"
              name="tolerancePercent"
              type="number"
              min={0}
              max={100}
              step="any"
              value={String(project.tolerancePercent)}
            />
          </div>
          <div>
            <label for="retentionDays">Keep builds for (days)</label>
            <input
              id="retentionDays"
              name="retentionDays"
              type="number"
              min={1}
              max={3650}
              step={1}
              value={String(project.retentionDays)}
            />
          </div>
        </div>
        <p>
          <button class="primary" type="submit">
            Save settings
          </button>
        </p>
      </form>

      <h2>Tokens</h2>
      <p class="sub">
        For CI and agents. <code>read</code> views, <code>write</code> posts builds and checks, <code>review</code>{' '}
        approves.
      </p>
      {tokens.length > 0 && (
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Token</th>
              <th>Scopes</th>
              <th>Last used</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {tokens.map((t) => (
              <tr>
                <td>{t.name}</td>
                <td class="muted">{`${t.prefix}…`}</td>
                <td>{t.scopes.join(', ')}</td>
                <td>
                  <When at={t.lastUsedAt} />
                </td>
                <td>
                  <form class="inline" method="post" action={ui.url(`${base}/tokens/${t.id}/delete`)}>
                    <button
                      class="danger"
                      type="submit"
                      data-confirm={`Revoke token “${t.name}”? Anything using it stops working.`}
                    >
                      Revoke
                    </button>
                  </form>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <form class="panel row" method="post" action={ui.url(`${base}/tokens`)}>
        <div>
          <label for="token-name">New token name</label>
          <input id="token-name" name="name" type="text" required placeholder="GitHub Actions" />
        </div>
        <fieldset>
          <legend>Scopes</legend>
          {TOKEN_SCOPES.map((scope) => (
            <label>
              <input type="checkbox" name="scopes" value={scope} checked={scope !== 'review'} /> {scope}
            </label>
          ))}
        </fieldset>
        <button class="primary" type="submit">
          Create token
        </button>
      </form>

      <h2>Danger zone</h2>
      <form class="panel" method="post" action={ui.url(`${base}/delete`)}>
        <p>Deleting the project removes its builds, checks, baselines and tokens.</p>
        <button class="danger" type="submit" data-confirm={`Delete project ${project.name} and all its data?`}>
          Delete project
        </button>
      </form>
    </Layout>
  );
}

const NUMBER_FIELDS = ['colorThreshold', 'tolerancePercent', 'retentionDays'] as const;

export function registerAdminPages(app: OpenAPIHono<AppEnv>, s: Services): void {
  app.get('/ui/admin/users', async (c) => {
    requireAdmin(c, 'user.admin');
    return c.html(<UsersPage ui={uiOf(c, s)} users={await listUsers(s.deps)} notice={noticeOf(c)} />);
  });

  app.post('/ui/admin/users', async (c) => {
    requireAdmin(c, 'user.admin');
    const ui = uiOf(c, s);
    const form = await c.req.parseBody();
    try {
      await createUser(s.deps, { email: field(form, 'email'), password: form.password, role: field(form, 'role') });
      return c.redirect(ui.url('/ui/admin/users?done=user-created'), 303);
    } catch (err) {
      return c.html(<UsersPage ui={ui} users={await listUsers(s.deps)} error={messageOf(err)} />, statusOf(err));
    }
  });

  app.post('/ui/admin/users/:id', async (c) => {
    requireAdmin(c, 'user.admin');
    const ui = uiOf(c, s);
    const form = await c.req.parseBody();
    try {
      await updateUser(s.deps, c.req.param('id'), { role: field(form, 'role') });
      return c.redirect(ui.url('/ui/admin/users?done=user-saved'), 303);
    } catch (err) {
      return c.html(<UsersPage ui={ui} users={await listUsers(s.deps)} error={messageOf(err)} />, statusOf(err));
    }
  });

  app.post('/ui/admin/users/:id/delete', async (c) => {
    requireAdmin(c, 'user.admin');
    const ui = uiOf(c, s);
    try {
      await deleteUser(s.deps, c.req.param('id'));
      return c.redirect(ui.url('/ui/admin/users?done=user-deleted'), 303);
    } catch (err) {
      return c.html(<UsersPage ui={ui} users={await listUsers(s.deps)} error={messageOf(err)} />, statusOf(err));
    }
  });

  const settings = async (
    c: Context<AppEnv>,
    extra: { newToken?: { name: string; token: string }; error?: string } = {},
  ) => {
    const slug = c.req.param('slug') ?? '';
    const project = await getProjectBySlug(s.deps, slug);
    const tokens = await listProjectTokens(s.deps, slug);
    return <SettingsPage ui={uiOf(c, s)} project={project} tokens={tokens} notice={noticeOf(c)} {...extra} />;
  };

  app.get('/ui/p/:slug/settings', async (c) => {
    requireAdmin(c, 'project.admin');
    return c.html(await settings(c));
  });

  app.post('/ui/p/:slug/settings', async (c) => {
    requireAdmin(c, 'project.admin');
    const slug = c.req.param('slug');
    const form = await c.req.parseBody();
    const input: Record<string, unknown> = { name: field(form, 'name'), mainBranch: field(form, 'mainBranch') };
    for (const name of NUMBER_FIELDS) {
      const raw = field(form, name);
      if (raw) input[name] = Number(raw);
    }
    try {
      await updateProject(s.deps, slug, input);
      return c.redirect(uiOf(c, s).url(`/ui/p/${slug}/settings?done=project-saved`), 303);
    } catch (err) {
      return c.html(await settings(c, { error: messageOf(err) }), statusOf(err));
    }
  });

  app.post('/ui/p/:slug/settings/tokens', async (c) => {
    requireAdmin(c, 'project.admin');
    const form = await c.req.parseBody({ all: true });
    const scopes = ([] as unknown[]).concat(form.scopes ?? []);
    const name = typeof form.name === 'string' ? form.name.trim() : undefined;
    try {
      const { token, view } = await createProjectToken(s.deps, c.req.param('slug'), { name, scopes });
      return c.html(await settings(c, { newToken: { name: view.name, token } }), 201);
    } catch (err) {
      return c.html(await settings(c, { error: messageOf(err) }), statusOf(err));
    }
  });

  app.post('/ui/p/:slug/settings/tokens/:id/delete', async (c) => {
    requireAdmin(c, 'project.admin');
    const slug = c.req.param('slug');
    await deleteProjectToken(s.deps, slug, c.req.param('id'));
    return c.redirect(uiOf(c, s).url(`/ui/p/${slug}/settings?done=token-revoked`), 303);
  });

  app.post('/ui/p/:slug/settings/delete', async (c) => {
    requireAdmin(c, 'project.admin');
    await deleteProject(s.deps, c.req.param('slug'));
    return c.redirect(uiOf(c, s).url('/ui?done=project-deleted'), 303);
  });
}
