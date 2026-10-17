import type { OpenAPIHono } from '@hono/zod-openapi';
import type { Context } from 'hono';
import { PROJECT_ROLES, type Project } from '../../db/schema';
import { createProjectToken, deleteProjectToken, listProjectTokens, type TokenView } from '../../domain/auth/tokens';
import { addMember, listMembers, type MemberView, removeMember, updateMember } from '../../domain/members';
import { deleteProject, updateProject } from '../../domain/projects';
import { AppError } from '../../errors';
import { type ProjectAccess, visibleProject } from '../../http/access';
import type { AppEnv, Services } from '../../http/env';
import { Ago, describedBy, Field, formErrors, Pill, ProjectTabs } from '../components';
import { field, noticeOf, type Ui, uiOf, userOf } from '../context';
import { Layout } from '../layout';
import { NewTokenButton, NewTokenDialog, NewTokenForm, TokenCreated } from '../token-forms';

/** Settings, tokens and members: admins and the project's maintainers (project.admin). */
function managed(c: Context<AppEnv>, s: Services) {
  return visibleProject(c, s.deps, c.req.param('slug') ?? '', 'project.admin');
}

const MEMBER_HELP =
  'Who can open this project besides admins. Viewers look; reviewers also approve and reject; maintainers also manage settings, tokens and members.';

const NUMBER_FIELDS = ['colorThreshold', 'tolerancePercent', 'retentionDays'] as const;

interface SettingField {
  name: 'name' | 'mainBranch' | (typeof NUMBER_FIELDS)[number];
  label: string;
  hint: string;
  input: Record<string, string | number | boolean>;
}

const FIELDS: SettingField[] = [
  { name: 'name', label: 'Name', hint: 'Shown in the UI.', input: { type: 'text', required: true } },
  {
    name: 'mainBranch',
    label: 'Main branch',
    hint: 'Other branches compare with its baselines until they have their own.',
    input: { type: 'text', required: true },
  },
  {
    name: 'colorThreshold',
    label: 'Colour threshold',
    hint: 'Pixels whose colour differs by less than this count as equal (0–1; 0.1 ignores anti-aliasing).',
    input: { type: 'number', min: 0, max: 1, step: 'any' },
  },
  {
    name: 'tolerancePercent',
    label: 'Tolerance (% of pixels)',
    hint: 'A check stays unchanged while at most this share of its pixels differs.',
    input: { type: 'number', min: 0, max: 100, step: 'any' },
  },
  {
    name: 'retentionDays',
    label: 'Keep builds for (days)',
    hint: 'Older builds and their checks are deleted by the hourly clean-up. Baselines are always kept.',
    input: { type: 'number', min: 1, max: 3650, step: 1 },
  },
];

function MembersSection(props: {
  ui: Ui;
  project: Project;
  members: MemberView[];
  values?: { email?: string | undefined; role?: string | undefined } | undefined;
}) {
  const { ui, project, members } = props;
  const base = `/ui/p/${project.slug}/settings/members`;
  const chosen = PROJECT_ROLES.find((r) => r === props.values?.role);
  return (
    <section class="settings-section" aria-labelledby="members-title">
      <div class="section-head">
        <h2 id="members-title">Members</h2>
        <p class="muted">{MEMBER_HELP}</p>
      </div>
      <div>
        <form class="member-add" method="post" action={ui.url(base)}>
          <label class="visually-hidden" for="member-email">
            Email
          </label>
          {/* With JavaScript (the members island) this searches the users who could be added. */}
          <div class="combobox">
            <input
              id="member-email"
              name="email"
              type="email"
              required
              autocomplete="off"
              placeholder="Email of an existing user"
              value={props.values?.email ?? ''}
              data-member-search={project.slug}
              aria-controls="member-candidates"
            />
            <ul id="member-candidates" class="combobox-list" aria-label="Users to add" hidden />
          </div>
          <label class="visually-hidden" for="member-role">
            Role
          </label>
          <select id="member-role" name="role">
            <option value="" selected={!chosen}>
              their default role
            </option>
            {PROJECT_ROLES.map((r) => (
              <option value={r} selected={r === chosen}>
                {r}
              </option>
            ))}
          </select>
          <button class="primary" type="submit">
            Add member
          </button>
        </form>
        {members.length === 0 ? (
          <div class="empty">
            <p>
              {project.visibleToAll
                ? 'No members yet. Everyone on this server can open the project with their server role.'
                : 'No members yet. Only admins can open this project.'}
            </p>
          </div>
        ) : (
          <table class="stack-on-phone">
            <thead>
              <tr>
                <th>Member</th>
                <th>Role</th>
                <th>Added</th>
                <th>
                  <span class="visually-hidden">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {members.map((m) => {
                const self = m.userId === ui.user?.id;
                return (
                  <tr>
                    <td>
                      <span class="user-cell">
                        <span class="avatar" aria-hidden="true">
                          {m.email.charAt(0).toUpperCase()}
                        </span>
                        {m.email}
                        {self && <span class="you">you</span>}
                      </span>
                    </td>
                    <td>
                      {self ? (
                        <span title="Ask an admin or another maintainer to change your own role.">{m.role}</span>
                      ) : (
                        // With JavaScript a change saves at once; the Save button is for browsers without it.
                        <form class="inline" method="post" action={ui.url(`${base}/${m.userId}`)} data-autosubmit>
                          <select name="role" aria-label={`Role of ${m.email}`}>
                            {PROJECT_ROLES.map((r) => (
                              <option value={r} selected={r === m.role}>
                                {r}
                              </option>
                            ))}
                          </select>
                          <button type="submit" class="no-js">
                            Save
                          </button>
                        </form>
                      )}
                    </td>
                    <td>
                      <Ago at={m.createdAt} />
                    </td>
                    <td>
                      {!self && (
                        <form method="post" action={ui.url(`${base}/${m.userId}/delete`)}>
                          <button
                            class="danger small"
                            type="submit"
                            data-confirm={`Remove ${m.email} from ${project.name}?`}
                            data-confirm-label="Remove"
                          >
                            Remove
                          </button>
                        </form>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </section>
  );
}

function SettingsPage(props: {
  ui: Ui;
  project: Project;
  access: ProjectAccess;
  tokens: TokenView[];
  members: MemberView[];
  values?: Record<string, string>;
  errors?: Record<string, string>;
  memberValues?: { email?: string | undefined; role?: string | undefined };
  newToken?: { name: string; scopes: string[]; token: string };
  notice?: string | undefined;
  error?: string | undefined;
}) {
  const { ui, project, tokens } = props;
  const errors = props.errors ?? {};
  const base = `/ui/p/${project.slug}/settings`;
  const valueFor = (name: SettingField['name']) => props.values?.[name] ?? String(project[name]);
  return (
    <Layout
      ui={ui}
      title={`${project.name} settings`}
      notice={props.notice}
      error={props.error}
      canManage
      islands={['tokens', 'members']}
      project={project.slug}
      crumbs={[{ label: project.name, href: ui.url(`/ui/p/${project.slug}`) }, { label: 'Settings' }]}
    >
      <div class="page-head">
        <h1>{project.name}</h1>
      </div>
      <ProjectTabs ui={ui} slug={project.slug} current="settings" canManage />
      {props.newToken && (
        <section class="panel">
          <TokenCreated {...props.newToken} />
        </section>
      )}

      <section class="settings-section" aria-labelledby="general-title">
        <div class="section-head">
          <h2 id="general-title">General</h2>
          <p class="muted">How this project's screenshots are compared and kept.</p>
        </div>
        <form class="panel" method="post" action={ui.url(base)}>
          {errors._form && <p class="flash error">{errors._form}</p>}
          <div class="form-grid">
            {FIELDS.map((f) => {
              const id = `settings-${f.name}`;
              return (
                <Field id={id} label={f.label} hint={f.hint} error={errors[f.name]}>
                  <input
                    name={f.name}
                    value={valueFor(f.name)}
                    {...f.input}
                    {...describedBy(id, f.hint, errors[f.name])}
                  />
                </Field>
              );
            })}
          </div>
          <label class="option">
            <input
              type="checkbox"
              name="autoApproveNew"
              checked={props.values ? props.values.autoApproveNew === 'on' : project.autoApproveNew}
            />
            <span>
              <strong>Approve new screenshots automatically</strong>{' '}
              <span class="muted">
                A screenshot with no baseline yet becomes the baseline as soon as it arrives; only changes wait for
                review.
              </span>
            </span>
          </label>
          <label class="option">
            <input
              type="checkbox"
              name="visibleToAll"
              checked={props.values ? props.values.visibleToAll === 'on' : project.visibleToAll}
            />
            <span>
              <strong>Visible to everyone on this server</strong>{' '}
              <span class="muted">
                Every user can open the project with their server role (viewer or reviewer), member or not. Off: only
                admins and members.
              </span>
            </span>
          </label>
          <div class="form-actions">
            <button class="primary" type="submit">
              Save settings
            </button>
          </div>
        </form>
      </section>

      <section class="settings-section" aria-labelledby="tokens-title">
        <div class="section-head">
          <h2 id="tokens-title">Tokens</h2>
          <p class="muted">For CI and agents. Send one as Authorization: Bearer pt_…</p>
          <NewTokenButton ui={ui} slug={project.slug} />
        </div>
        {tokens.length === 0 ? (
          <div class="empty">
            <p>No tokens yet. Tests need one with read and write to send screenshots.</p>
          </div>
        ) : (
          <table class="stack-on-phone">
            <thead>
              <tr>
                <th>Name</th>
                <th>Token</th>
                <th>Scopes</th>
                <th>Created</th>
                <th>Last used</th>
                <th>
                  <span class="visually-hidden">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {tokens.map((t) => (
                <tr>
                  <td>{t.name}</td>
                  <td class="mono muted">{`${t.prefix}…`}</td>
                  <td>
                    <span class="status">
                      {t.scopes.map((scope) => (
                        <Pill tone="grey">{scope}</Pill>
                      ))}
                    </span>
                  </td>
                  <td>
                    <Ago at={t.createdAt} />
                  </td>
                  <td>{t.lastUsedAt ? <Ago at={t.lastUsedAt} /> : <span class="muted">never</span>}</td>
                  <td>
                    <form method="post" action={ui.url(`${base}/tokens/${t.id}/delete`)}>
                      <button
                        class="danger small"
                        type="submit"
                        data-confirm={`Revoke token “${t.name}”? Anything using it stops working.`}
                        data-confirm-label="Revoke"
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
        <NewTokenDialog ui={ui} slug={project.slug} />
      </section>

      <MembersSection ui={ui} project={project} members={props.members} values={props.memberValues} />

      {props.access.can('server.admin') && (
        <section class="settings-section danger-zone" aria-labelledby="danger-title">
          <div class="section-head">
            <h2 id="danger-title">Danger zone</h2>
          </div>
          <form class="panel" method="post" action={ui.url(`${base}/delete`)}>
            <p>Deleting the project removes its builds, checks, baselines and tokens. It cannot be undone.</p>
            <button
              class="danger"
              type="submit"
              data-confirm={`Delete project ${project.name} and all its data?`}
              data-confirm-label="Delete project"
            >
              Delete project
            </button>
          </form>
        </section>
      )}
    </Layout>
  );
}

function NewTokenPage(props: {
  ui: Ui;
  project: Project;
  values?: { name?: string | undefined; scopes?: string[] };
  errors?: Record<string, string>;
}) {
  const { ui, project } = props;
  return (
    <Layout
      ui={ui}
      title="New token"
      crumbs={[
        { label: project.name, href: ui.url(`/ui/p/${project.slug}`) },
        { label: 'Settings', href: ui.url(`/ui/p/${project.slug}/settings`) },
        { label: 'New token' },
      ]}
    >
      <div class="panel narrow">
        <h1>New token</h1>
        <NewTokenForm ui={ui} slug={project.slug} values={props.values} errors={props.errors} inDialog={false} />
      </div>
    </Layout>
  );
}

export function registerSettingsPages(app: OpenAPIHono<AppEnv>, s: Services): void {
  const page = async (c: Context<AppEnv>, extra: Partial<Parameters<typeof SettingsPage>[0]> = {}) => {
    const { project, access } = await managed(c, s);
    const [tokens, members] = await Promise.all([
      listProjectTokens(s.deps, project.slug),
      listMembers(s.deps, project.slug),
    ]);
    return (
      <SettingsPage
        ui={uiOf(c, s)}
        project={project}
        access={access}
        tokens={tokens}
        members={members}
        notice={noticeOf(c)}
        {...extra}
      />
    );
  };

  app.get('/ui/p/:slug/settings', async (c) => c.html(await page(c)));

  app.post('/ui/p/:slug/settings', async (c) => {
    await managed(c, s);
    const slug = c.req.param('slug');
    const form = await c.req.parseBody();
    const values: Record<string, string> = {};
    for (const f of FIELDS) values[f.name] = field(form, f.name) ?? '';
    // An unticked checkbox is not sent at all.
    values.autoApproveNew = field(form, 'autoApproveNew') === 'on' ? 'on' : '';
    values.visibleToAll = field(form, 'visibleToAll') === 'on' ? 'on' : '';
    const input: Record<string, unknown> = {
      name: values.name,
      mainBranch: values.mainBranch,
      autoApproveNew: values.autoApproveNew === 'on',
      visibleToAll: values.visibleToAll === 'on',
    };
    for (const name of NUMBER_FIELDS) if (values[name]) input[name] = Number(values[name]);
    try {
      await updateProject(s.deps, slug, input);
      return c.redirect(uiOf(c, s).url(`/ui/p/${slug}/settings?done=project-saved`), 303);
    } catch (err) {
      if (!(err instanceof AppError) || err.status >= 500) throw err;
      return c.html(await page(c, { values, errors: formErrors(err) }), err.status as 409 | 422);
    }
  });

  app.get('/ui/p/:slug/settings/tokens/new', async (c) => {
    const { project } = await managed(c, s);
    return c.html(<NewTokenPage ui={uiOf(c, s)} project={project} />);
  });

  app.post('/ui/p/:slug/settings/tokens', async (c) => {
    const { project } = await managed(c, s);
    const slug = c.req.param('slug');
    const form = await c.req.parseBody({ all: true });
    const scopes = ([] as unknown[]).concat(form.scopes ?? []).map(String);
    const name = typeof form.name === 'string' ? form.name.trim() : undefined;
    try {
      const { token, view } = await createProjectToken(s.deps, slug, { name, scopes });
      return c.html(await page(c, { newToken: { name: view.name, scopes: view.scopes, token } }), 201);
    } catch (err) {
      if (!(err instanceof AppError) || err.status >= 500) throw err;
      return c.html(
        <NewTokenPage ui={uiOf(c, s)} project={project} values={{ name, scopes }} errors={formErrors(err)} />,
        err.status as 422,
      );
    }
  });

  app.post('/ui/p/:slug/settings/tokens/:id/delete', async (c) => {
    await managed(c, s);
    const slug = c.req.param('slug');
    await deleteProjectToken(s.deps, slug, c.req.param('id'));
    return c.redirect(uiOf(c, s).url(`/ui/p/${slug}/settings?done=token-revoked`), 303);
  });

  app.post('/ui/p/:slug/settings/delete', async (c) => {
    const { project } = await visibleProject(c, s.deps, c.req.param('slug'), 'server.admin');
    await deleteProject(s.deps, project.slug);
    return c.redirect(uiOf(c, s).url('/ui?done=project-deleted'), 303);
  });

  const membersPage = (c: Context<AppEnv>, err: unknown, memberValues?: { email?: string; role?: string }) => {
    if (!(err instanceof AppError) || err.status >= 500) throw err;
    const error = err.errors?.length ? err.errors.map((e) => `${e.path}: ${e.message}`).join('; ') : err.detail;
    return page(c, { error, ...(memberValues ? { memberValues } : {}) }).then((html) =>
      c.html(html, err.status as 404 | 409 | 422),
    );
  };

  app.post('/ui/p/:slug/settings/members', async (c) => {
    const { project } = await managed(c, s);
    const form = await c.req.parseBody();
    const email = field(form, 'email') ?? '';
    const role = field(form, 'role') || undefined;
    try {
      await addMember(s.deps, project.slug, { email, ...(role ? { role } : {}) });
      return c.redirect(uiOf(c, s).url(`/ui/p/${project.slug}/settings?done=member-added#members-title`), 303);
    } catch (err) {
      return membersPage(c, err, { email, ...(role ? { role } : {}) });
    }
  });

  app.post('/ui/p/:slug/settings/members/:userId', async (c) => {
    const { project } = await managed(c, s);
    const form = await c.req.parseBody();
    try {
      await updateMember(s.deps, project.slug, c.req.param('userId'), { role: field(form, 'role') }, userOf(c).id);
      return c.redirect(uiOf(c, s).url(`/ui/p/${project.slug}/settings?done=member-saved#members-title`), 303);
    } catch (err) {
      return membersPage(c, err);
    }
  });

  app.post('/ui/p/:slug/settings/members/:userId/delete', async (c) => {
    const { project } = await managed(c, s);
    try {
      await removeMember(s.deps, project.slug, c.req.param('userId'), userOf(c).id);
      return c.redirect(uiOf(c, s).url(`/ui/p/${project.slug}/settings?done=member-removed#members-title`), 303);
    } catch (err) {
      return membersPage(c, err);
    }
  });
}
