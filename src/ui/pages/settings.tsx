import type { OpenAPIHono } from '@hono/zod-openapi';
import type { Context } from 'hono';
import type { Project } from '../../db/schema';
import { hasPermission } from '../../domain/auth/policy';
import { createProjectToken, deleteProjectToken, listProjectTokens, type TokenView } from '../../domain/auth/tokens';
import { deleteProject, getProjectBySlug, updateProject } from '../../domain/projects';
import { AppError } from '../../errors';
import type { AppEnv, Services } from '../../http/env';
import { Ago, describedBy, Field, formErrors, Pill, ProjectTabs } from '../components';
import { field, noticeOf, type Ui, uiOf, userOf } from '../context';
import { Layout } from '../layout';
import { NewTokenButton, NewTokenDialog, NewTokenForm, TokenCreated } from '../token-forms';

function requireProjectAdmin(c: Context<AppEnv>): void {
  if (!hasPermission(userOf(c), 'project.admin'))
    throw new AppError('forbidden', 403, 'Only admins can open this page.');
}

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

function SettingsPage(props: {
  ui: Ui;
  project: Project;
  tokens: TokenView[];
  values?: Record<string, string>;
  errors?: Record<string, string>;
  newToken?: { name: string; scopes: string[]; token: string };
  notice?: string | undefined;
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
      islands={['tokens']}
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
    const slug = c.req.param('slug') ?? '';
    const [project, tokens] = await Promise.all([getProjectBySlug(s.deps, slug), listProjectTokens(s.deps, slug)]);
    return <SettingsPage ui={uiOf(c, s)} project={project} tokens={tokens} notice={noticeOf(c)} {...extra} />;
  };

  app.get('/ui/p/:slug/settings', async (c) => {
    requireProjectAdmin(c);
    return c.html(await page(c));
  });

  app.post('/ui/p/:slug/settings', async (c) => {
    requireProjectAdmin(c);
    const slug = c.req.param('slug');
    const form = await c.req.parseBody();
    const values: Record<string, string> = {};
    for (const f of FIELDS) values[f.name] = field(form, f.name) ?? '';
    const input: Record<string, unknown> = { name: values.name, mainBranch: values.mainBranch };
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
    requireProjectAdmin(c);
    const project = await getProjectBySlug(s.deps, c.req.param('slug'));
    return c.html(<NewTokenPage ui={uiOf(c, s)} project={project} />);
  });

  app.post('/ui/p/:slug/settings/tokens', async (c) => {
    requireProjectAdmin(c);
    const slug = c.req.param('slug');
    const form = await c.req.parseBody({ all: true });
    const scopes = ([] as unknown[]).concat(form.scopes ?? []).map(String);
    const name = typeof form.name === 'string' ? form.name.trim() : undefined;
    try {
      const { token, view } = await createProjectToken(s.deps, slug, { name, scopes });
      return c.html(await page(c, { newToken: { name: view.name, scopes: view.scopes, token } }), 201);
    } catch (err) {
      if (!(err instanceof AppError) || err.status >= 500) throw err;
      const project = await getProjectBySlug(s.deps, slug);
      return c.html(
        <NewTokenPage ui={uiOf(c, s)} project={project} values={{ name, scopes }} errors={formErrors(err)} />,
        err.status as 422,
      );
    }
  });

  app.post('/ui/p/:slug/settings/tokens/:id/delete', async (c) => {
    requireProjectAdmin(c);
    const slug = c.req.param('slug');
    await deleteProjectToken(s.deps, slug, c.req.param('id'));
    return c.redirect(uiOf(c, s).url(`/ui/p/${slug}/settings?done=token-revoked`), 303);
  });

  app.post('/ui/p/:slug/settings/delete', async (c) => {
    requireProjectAdmin(c);
    await deleteProject(s.deps, c.req.param('slug'));
    return c.redirect(uiOf(c, s).url('/ui?done=project-deleted'), 303);
  });
}
