import type { OpenAPIHono } from '@hono/zod-openapi';
import type { Context } from 'hono';
import { PROVIDERS, type Project, type Provider, WEBHOOK_EVENTS, WEBHOOK_FORMATS } from '../../db/schema';
import { hasPermission } from '../../domain/auth/policy';
import {
  DEFAULT_BASE_URLS,
  deleteIntegration,
  type IntegrationView,
  PROVIDER_NAMES,
  updateIntegration,
} from '../../domain/integrations';
import { getProjectBySlug } from '../../domain/projects';
import {
  createWebhook,
  type DeliveryView,
  deleteWebhook,
  getWebhook,
  listDeliveries,
  updateWebhook,
  type WebhookView,
} from '../../domain/webhooks';
import { AppError } from '../../errors';
import type { AppEnv, Services } from '../../http/env';
import { inboundWebhookUrl } from '../../http/routes/integrations';
import { Ago, describedBy, Field, formErrors, Pill, type Tone } from '../components';
import { field, noticeOf, type Ui, uiOf, userOf } from '../context';
import { Layout } from '../layout';

// Settings for reaching the pull request: the code host integration (GitHub or GitLab) and the
// outgoing webhooks, on the project's settings page; each webhook has a page with its deliveries.

function requireProjectAdmin(c: Context<AppEnv>): void {
  if (!hasPermission(userOf(c), 'project.admin'))
    throw new AppError('forbidden', 403, 'Only admins can open this page.');
}

const PROVIDER_HINTS: Record<Provider, string> = {
  github:
    'Token: a fine-grained personal access token with Commit statuses and Pull requests (read and write), or a GitHub App installation token.',
  gitlab: 'Token: a project access token with the api scope and at least the Developer role.',
};

const EVENT_HELP: Record<(typeof WEBHOOK_EVENTS)[number], string> = {
  'build.finalized': 'a build was finalized, with its verdict',
  'build.verdict_changed': "a finalized build's verdict changed (a review, an area, a promotion)",
  'check.reviewed': 'a person or token approved, rejected or undid a review',
};

const FORMAT_LABELS: Record<(typeof WEBHOOK_FORMATS)[number], string> = {
  json: 'JSON (pixeltwin payload)',
  slack: 'Slack message (text and blocks)',
};

function deliveryTone(d: Pick<DeliveryView, 'state'>): Tone {
  return d.state === 'delivered' ? 'green' : d.state === 'failed' ? 'red' : 'amber';
}

function DeliveryPill({ delivery }: { delivery: DeliveryView }) {
  const label = delivery.state === 'pending' ? (delivery.attempts > 0 ? 'retrying' : 'queued') : delivery.state;
  return <Pill tone={deliveryTone(delivery)}>{delivery.statusCode ? `${label} · ${delivery.statusCode}` : label}</Pill>;
}

/** The code host section of the settings page. */
export function IntegrationSection(props: {
  ui: Ui;
  project: Project;
  integration: IntegrationView;
  publicUrl: string;
  values?: Record<string, string>;
  errors?: Record<string, string>;
}) {
  const { ui, project, integration } = props;
  const errors = props.errors ?? {};
  const values = props.values;
  const action = ui.url(`/ui/p/${project.slug}/settings/integration`);
  const provider = (values?.provider as Provider | undefined) ?? integration.provider;
  const checked = (name: 'commitStatus' | 'prComment' | 'autoPromote') =>
    values ? values[name] === 'on' : integration[name];
  const name = PROVIDER_NAMES[integration.provider];
  return (
    <section class="settings-section" aria-labelledby="integration-title">
      <div class="section-head">
        <h2 id="integration-title">Pull requests</h2>
        <p class="muted">
          Report each build on its commit and pull (merge) request on GitHub or GitLab, and promote a branch when it is
          merged.
        </p>
      </div>
      <div>
        <form class="panel" method="post" action={action} data-integration-form>
          {errors._form && <p class="flash error">{errors._form}</p>}
          {!integration.encrypted && (
            <p class="warning">
              Tokens and secrets are stored unencrypted. Set SECRET_KEY (32 characters or more) on the server to encrypt
              them.
            </p>
          )}
          <div class="form-grid">
            <Field id="integration-provider" label="Code host" hint={PROVIDER_HINTS[provider]} error={errors.provider}>
              <select
                name="provider"
                data-hint-from-option
                {...describedBy('integration-provider', PROVIDER_HINTS[provider], errors.provider)}
              >
                {PROVIDERS.map((p) => (
                  <option value={p} data-hint={PROVIDER_HINTS[p]} selected={p === provider}>
                    {PROVIDER_NAMES[p]}
                  </option>
                ))}
              </select>
            </Field>
            <Field
              id="integration-repository"
              label="Repository"
              hint="GitHub: owner/name. GitLab: the project path, group/sub/project. Builds from CI name their own."
              error={errors.repository}
            >
              <input
                name="repository"
                type="text"
                placeholder="acme/shop"
                value={values?.repository ?? integration.repository ?? ''}
                {...describedBy('integration-repository', 'hint', errors.repository)}
              />
            </Field>
            <Field
              id="integration-base-url"
              label="API or instance URL"
              hint="Empty: https://api.github.com or https://gitlab.com. GitHub Enterprise: https://host/api/v3."
              error={errors.baseUrl}
            >
              <input
                name="baseUrl"
                type="url"
                value={values?.baseUrl ?? integration.baseUrl}
                {...describedBy('integration-base-url', 'hint', errors.baseUrl)}
              />
            </Field>
            <Field
              id="integration-token"
              label="Token"
              hint={
                integration.tokenSet
                  ? `Set, ends in ${integration.tokenLast4}. Leave empty to keep it.`
                  : 'Never shown again once saved.'
              }
              error={errors.token}
            >
              <input
                name="token"
                type="password"
                autocomplete="new-password"
                placeholder={integration.tokenSet ? `••••${integration.tokenLast4}` : ''}
                {...describedBy('integration-token', 'hint', errors.token)}
              />
            </Field>
          </div>
          <label class="option">
            <input type="checkbox" name="commitStatus" checked={checked('commitStatus')} />
            <span>
              <strong>Commit status</strong>{' '}
              <span class="muted">
                {`pixeltwin/${project.slug}: pending while screenshots wait for review, green once they are approved.`}
              </span>
            </span>
          </label>
          <label class="option">
            <input type="checkbox" name="prComment" checked={checked('prComment')} />
            <span>
              <strong>Pull request comment</strong>{' '}
              <span class="muted">One comment per build with the changed screens, edited as reviews happen.</span>
            </span>
          </label>
          <label class="option">
            <input type="checkbox" name="autoPromote" checked={checked('autoPromote')} />
            <span>
              <strong>Promote on merge</strong>{' '}
              <span class="muted">
                A merged pull request copies its branch's baselines into the branch it was merged into.
              </span>
            </span>
          </label>
          {errors.autoPromote && <p class="field-error">{errors.autoPromote}</p>}
          <Field
            id="integration-webhook-secret"
            label="Webhook secret (for promote on merge)"
            hint={
              integration.webhookSecretSet
                ? 'Set. Leave empty to keep it.'
                : 'At least 16 characters, e.g. from openssl rand -hex 32. Paste the same value into the webhook on the code host.'
            }
            error={errors.webhookSecret}
          >
            <input
              name="webhookSecret"
              type="password"
              autocomplete="new-password"
              placeholder={integration.webhookSecretSet ? '••••••••' : ''}
              {...describedBy('integration-webhook-secret', 'hint', errors.webhookSecret)}
            />
          </Field>
          <p class="hint">
            Webhook URL on {name}: <code>{inboundWebhookUrl(props.publicUrl, integration.provider)}</code>
            {integration.provider === 'github'
              ? ' (content type application/json, the "Pull requests" event).'
              : ' ("Merge request events").'}
          </p>
          {integration.lastSync && (
            <p class={integration.lastSync.error ? 'field-error' : 'hint'}>
              {`Last update to ${name}: `}
              <Ago at={integration.lastSync.at} />
              {integration.lastSync.error ? ` failed: ${integration.lastSync.error}` : ', delivered.'}
            </p>
          )}
          {integration.lastMerge && (
            <p class="hint">
              {`Last merge: #${integration.lastMerge.pullRequest} ${integration.lastMerge.headBranch} → ${integration.lastMerge.baseBranch}, ${integration.lastMerge.promoted ?? 0} screens promoted `}
              <Ago at={integration.lastMerge.at} />
            </p>
          )}
          <div class="form-actions">
            <button class="primary" type="submit">
              Save
            </button>
          </div>
        </form>
        {integration.configured && (
          <form method="post" action={`${action}/delete`} class="inline-end">
            <button
              class="danger small"
              type="submit"
              data-confirm={`Remove the ${name} integration with its token?`}
              data-confirm-label="Remove"
            >
              {`Remove ${name} integration`}
            </button>
          </form>
        )}
      </div>
    </section>
  );
}

/** The webhooks section of the settings page. */
export function WebhooksSection({ ui, project, webhooks }: { ui: Ui; project: Project; webhooks: WebhookView[] }) {
  const base = `/ui/p/${project.slug}/settings/webhooks`;
  return (
    <section class="settings-section" aria-labelledby="webhooks-title">
      <div class="section-head">
        <h2 id="webhooks-title">Webhooks</h2>
        <p class="muted">POST builds and reviews to another service, e.g. Slack. Each is signed with its secret.</p>
        <a class="button primary" href={ui.url(`${base}/new`)}>
          New webhook
        </a>
      </div>
      {webhooks.length === 0 ? (
        <div class="empty">
          <p>No webhooks yet.</p>
        </div>
      ) : (
        <table class="stack-on-phone">
          <thead>
            <tr>
              <th>URL</th>
              <th>Events</th>
              <th>Last delivery</th>
              <th>
                <span class="visually-hidden">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {webhooks.map((w) => (
              <tr>
                <td class="mono wrap">
                  {w.url}
                  {!w.enabled && (
                    <>
                      {' '}
                      <Pill tone="grey">off</Pill>
                    </>
                  )}
                  {w.format === 'slack' && (
                    <>
                      {' '}
                      <Pill tone="grey">slack</Pill>
                    </>
                  )}
                </td>
                <td>{w.events.join(', ')}</td>
                <td>
                  {w.lastDelivery ? (
                    <span class="status">
                      <DeliveryPill delivery={w.lastDelivery} />
                      <Ago at={w.lastDelivery.createdAt} />
                    </span>
                  ) : (
                    <span class="muted">never</span>
                  )}
                </td>
                <td>
                  <a class="button small" href={ui.url(`${base}/${w.id}`)}>
                    Open
                  </a>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

function WebhookForm(props: {
  ui: Ui;
  action: string;
  webhook?: WebhookView;
  values?: { url?: string; events?: string[]; format?: string; enabled?: boolean };
  errors?: Record<string, string>;
  submit: string;
}) {
  const errors = props.errors ?? {};
  const url = props.values?.url ?? props.webhook?.url ?? '';
  const events = props.values?.events ?? props.webhook?.events ?? ['build.finalized', 'build.verdict_changed'];
  const format = props.values?.format ?? props.webhook?.format ?? 'json';
  const enabled = props.values?.enabled ?? props.webhook?.enabled ?? true;
  const secretHint = props.webhook
    ? `Set, ends in ${props.webhook.secretLast4}. Enter a new one to replace it.`
    : 'Leave empty to generate one; it is shown once.';
  return (
    <form method="post" action={props.action}>
      {errors._form && <p class="flash error">{errors._form}</p>}
      <Field id="webhook-url" label="URL" hint="http:// or https://; redirects are not followed." error={errors.url}>
        <input
          name="url"
          type="url"
          required
          value={url}
          placeholder="https://hooks.slack.com/services/…"
          {...describedBy('webhook-url', 'hint', errors.url)}
        />
      </Field>
      <fieldset>
        <legend>Events</legend>
        {WEBHOOK_EVENTS.map((event) => (
          <label class="scope">
            <input type="checkbox" name="events" value={event} checked={events.includes(event)} />
            <span>
              <strong>{event}</strong> <span class="muted">{EVENT_HELP[event]}</span>
            </span>
          </label>
        ))}
        {errors.events && <p class="field-error">{errors.events}</p>}
      </fieldset>
      <Field id="webhook-format" label="Format" error={errors.format}>
        <select name="format" {...describedBy('webhook-format', undefined, errors.format)}>
          {WEBHOOK_FORMATS.map((f) => (
            <option value={f} selected={f === format}>
              {FORMAT_LABELS[f]}
            </option>
          ))}
        </select>
      </Field>
      <Field id="webhook-secret" label="Secret" hint={secretHint} error={errors.secret}>
        <input
          name="secret"
          type="password"
          autocomplete="new-password"
          {...describedBy('webhook-secret', 'hint', errors.secret)}
        />
      </Field>
      {props.webhook && (
        <label class="option">
          <input type="checkbox" name="enabled" checked={enabled} />
          <span>
            <strong>On</strong> <span class="muted">Turned off, nothing is sent (Send test still works).</span>
          </span>
        </label>
      )}
      <div class="form-actions">
        <button class="primary" type="submit">
          {props.submit}
        </button>
      </div>
    </form>
  );
}

function NewWebhookPage(props: {
  ui: Ui;
  project: Project;
  values?: { url?: string; events?: string[]; format?: string };
  errors?: Record<string, string>;
}) {
  const { ui, project } = props;
  return (
    <Layout
      ui={ui}
      title="New webhook"
      crumbs={[
        { label: project.name, href: ui.url(`/ui/p/${project.slug}`) },
        { label: 'Settings', href: ui.url(`/ui/p/${project.slug}/settings`) },
        { label: 'New webhook' },
      ]}
    >
      <div class="panel narrow">
        <h1>New webhook</h1>
        <WebhookForm
          ui={ui}
          action={ui.url(`/ui/p/${project.slug}/settings/webhooks`)}
          values={props.values}
          errors={props.errors}
          submit="Add webhook"
        />
      </div>
    </Layout>
  );
}

function WebhookPage(props: {
  ui: Ui;
  project: Project;
  webhook: WebhookView;
  deliveries: DeliveryView[];
  secret?: string | null;
  notice?: string | undefined;
  error?: string | undefined;
  values?: { url?: string; events?: string[]; format?: string; enabled?: boolean };
  errors?: Record<string, string>;
}) {
  const { ui, project, webhook, deliveries } = props;
  const base = `/ui/p/${project.slug}/settings/webhooks/${webhook.id}`;
  return (
    <Layout
      ui={ui}
      title="Webhook"
      notice={props.notice}
      error={props.error}
      crumbs={[
        { label: project.name, href: ui.url(`/ui/p/${project.slug}`) },
        { label: 'Settings', href: ui.url(`/ui/p/${project.slug}/settings`) },
        { label: 'Webhook' },
      ]}
    >
      <div class="page-head">
        <h1 class="mono wrap">{webhook.url}</h1>
      </div>
      {props.secret && (
        <section class="panel">
          <div class="token-created">
            <h2>Webhook added</h2>
            <p>It signs every delivery with this secret: check X-Pixeltwin-Signature (sha256=HMAC of the body).</p>
            <div class="token-row">
              <code id="new-webhook-secret">{props.secret}</code>
              <button type="button" class="primary small" data-copy-from="new-webhook-secret" hidden>
                Copy
              </button>
            </div>
            <p class="warning">This is the only time the secret is shown. Store it with the receiver now.</p>
          </div>
        </section>
      )}

      <section class="settings-section" aria-labelledby="deliveries-title">
        <div class="section-head">
          <h2 id="deliveries-title">Deliveries</h2>
          <p class="muted">The last 20. Failed ones (network, timeout, 5xx, 429) are retried for about five hours.</p>
          <form method="post" action={ui.url(`${base}/test`)}>
            <button class="button" type="submit">
              Send test
            </button>
          </form>
        </div>
        {deliveries.length === 0 ? (
          <div class="empty">
            <p>Nothing sent yet. Send test posts a ping event.</p>
          </div>
        ) : (
          <table class="stack-on-phone deliveries">
            <thead>
              <tr>
                <th>When</th>
                <th>Event</th>
                <th>Result</th>
                <th>Time</th>
                <th>Error</th>
              </tr>
            </thead>
            <tbody>
              {deliveries.map((d) => (
                <tr>
                  <td>
                    <Ago at={d.createdAt} />
                  </td>
                  <td class="mono">{d.event}</td>
                  <td>
                    <DeliveryPill delivery={d} />
                    {d.attempts > 1 && <span class="muted">{` ${d.attempts} attempts`}</span>}
                  </td>
                  <td>{d.durationMs === null ? <span class="muted">—</span> : `${d.durationMs} ms`}</td>
                  <td class="wrap">{d.error ?? <span class="muted">—</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section class="settings-section" aria-labelledby="webhook-edit-title">
        <div class="section-head">
          <h2 id="webhook-edit-title">Settings</h2>
        </div>
        <div class="panel">
          <WebhookForm
            ui={ui}
            action={ui.url(base)}
            webhook={webhook}
            values={props.values}
            errors={props.errors}
            submit="Save webhook"
          />
        </div>
      </section>

      <section class="settings-section danger-zone" aria-labelledby="webhook-danger-title">
        <div class="section-head">
          <h2 id="webhook-danger-title">Danger zone</h2>
        </div>
        <form class="panel" method="post" action={ui.url(`${base}/delete`)}>
          <p>Deleting the webhook stops its deliveries, also those waiting for a retry.</p>
          <button class="danger" type="submit" data-confirm="Delete this webhook?" data-confirm-label="Delete">
            Delete webhook
          </button>
        </form>
      </section>
    </Layout>
  );
}

/** The webhook form's fields as the API takes them. */
function webhookInput(form: Record<string, string | File | (string | File)[]>, editing: boolean) {
  const events = ([] as unknown[]).concat(form.events ?? []).map(String);
  const values = {
    url: field(form, 'url') ?? '',
    events,
    format: field(form, 'format') ?? 'json',
    enabled: field(form, 'enabled') === 'on',
  };
  const secret = field(form, 'secret');
  const input: Record<string, unknown> = { url: values.url, events: values.events, format: values.format };
  if (secret) input.secret = secret;
  if (editing) input.enabled = values.enabled;
  return { values, input };
}

/** Renders the settings page with the integration form's values and errors (settings.tsx owns the page). */
export type SettingsRenderer = (
  c: Context<AppEnv>,
  extra: { integrationValues: Record<string, string>; integrationErrors: Record<string, string> },
) => Promise<unknown>;

export function registerIntegrationPages(
  app: OpenAPIHono<AppEnv>,
  s: Services,
  renderSettings: SettingsRenderer,
): void {
  app.post('/ui/p/:slug/settings/integration', async (c) => {
    requireProjectAdmin(c);
    const slug = c.req.param('slug');
    const form = await c.req.parseBody();
    const values: Record<string, string> = {};
    for (const name of ['provider', 'repository', 'baseUrl']) values[name] = field(form, name) ?? '';
    for (const name of ['commitStatus', 'prComment', 'autoPromote']) {
      values[name] = field(form, name) === 'on' ? 'on' : '';
    }
    const provider = (PROVIDERS as readonly string[]).includes(values.provider ?? '') ? values.provider : undefined;
    // A default URL means "the default of whichever host is chosen" (the field still shows the old one).
    const baseUrl = Object.values(DEFAULT_BASE_URLS).includes(values.baseUrl ?? '') ? '' : values.baseUrl;
    const input: Record<string, unknown> = {
      provider,
      repository: values.repository,
      baseUrl,
      commitStatus: values.commitStatus === 'on',
      prComment: values.prComment === 'on',
      autoPromote: values.autoPromote === 'on',
    };
    const token = field(form, 'token');
    const webhookSecret = field(form, 'webhookSecret');
    if (token) input.token = token;
    if (webhookSecret) input.webhookSecret = webhookSecret;
    try {
      await updateIntegration(s.deps, slug, input);
      return c.redirect(uiOf(c, s).url(`/ui/p/${slug}/settings?done=integration-saved#integration-title`), 303);
    } catch (err) {
      if (!(err instanceof AppError) || err.status >= 500) throw err;
      const page = await renderSettings(c, { integrationValues: values, integrationErrors: formErrors(err) });
      return c.html(page as string, 422);
    }
  });

  app.post('/ui/p/:slug/settings/integration/delete', async (c) => {
    requireProjectAdmin(c);
    const slug = c.req.param('slug');
    await deleteIntegration(s.deps, slug);
    return c.redirect(uiOf(c, s).url(`/ui/p/${slug}/settings?done=integration-removed`), 303);
  });

  app.get('/ui/p/:slug/settings/webhooks/new', async (c) => {
    requireProjectAdmin(c);
    const project = await getProjectBySlug(s.deps, c.req.param('slug'));
    return c.html(<NewWebhookPage ui={uiOf(c, s)} project={project} />);
  });

  app.post('/ui/p/:slug/settings/webhooks', async (c) => {
    requireProjectAdmin(c);
    const slug = c.req.param('slug');
    const project = await getProjectBySlug(s.deps, slug);
    const { values, input } = webhookInput(await c.req.parseBody({ all: true }), false);
    try {
      const { webhook, secret } = await createWebhook(s.deps, slug, input);
      return c.html(
        <WebhookPage ui={uiOf(c, s)} project={project} webhook={webhook} deliveries={[]} secret={secret} />,
        201,
      );
    } catch (err) {
      if (!(err instanceof AppError) || err.status >= 500) throw err;
      return c.html(
        <NewWebhookPage ui={uiOf(c, s)} project={project} values={values} errors={formErrors(err)} />,
        err.status as 422,
      );
    }
  });

  const webhookPage = async (c: Context<AppEnv>, extra: Partial<Parameters<typeof WebhookPage>[0]> = {}) => {
    const slug = c.req.param('slug') ?? '';
    const id = c.req.param('id') ?? '';
    const [project, webhook, deliveries] = await Promise.all([
      getProjectBySlug(s.deps, slug),
      getWebhook(s.deps, slug, id),
      listDeliveries(s.deps, slug, id),
    ]);
    // A failed Send test is an error toast, not a notice.
    const failed = c.req.query('done') === 'webhook-test-failed';
    return (
      <WebhookPage
        ui={uiOf(c, s)}
        project={project}
        webhook={webhook}
        deliveries={deliveries}
        notice={failed ? undefined : noticeOf(c)}
        error={failed ? noticeOf(c) : undefined}
        {...extra}
      />
    );
  };

  app.get('/ui/p/:slug/settings/webhooks/:id', async (c) => {
    requireProjectAdmin(c);
    return c.html(await webhookPage(c));
  });

  app.post('/ui/p/:slug/settings/webhooks/:id', async (c) => {
    requireProjectAdmin(c);
    const slug = c.req.param('slug');
    const id = c.req.param('id');
    const { values, input } = webhookInput(await c.req.parseBody({ all: true }), true);
    try {
      await updateWebhook(s.deps, slug, id, input);
      return c.redirect(uiOf(c, s).url(`/ui/p/${slug}/settings/webhooks/${id}?done=webhook-saved`), 303);
    } catch (err) {
      if (!(err instanceof AppError) || err.status >= 500) throw err;
      return c.html(await webhookPage(c, { values, errors: formErrors(err) }), err.status as 422);
    }
  });

  app.post('/ui/p/:slug/settings/webhooks/:id/test', async (c) => {
    requireProjectAdmin(c);
    const slug = c.req.param('slug');
    const id = c.req.param('id');
    const project = await getProjectBySlug(s.deps, slug);
    await getWebhook(s.deps, slug, id);
    const delivery = await s.notifier.sendTest(project.id, id);
    const done = delivery.state === 'delivered' ? 'webhook-test-ok' : 'webhook-test-failed';
    return c.redirect(uiOf(c, s).url(`/ui/p/${slug}/settings/webhooks/${id}?done=${done}`), 303);
  });

  app.post('/ui/p/:slug/settings/webhooks/:id/delete', async (c) => {
    requireProjectAdmin(c);
    const slug = c.req.param('slug');
    await deleteWebhook(s.deps, slug, c.req.param('id'));
    return c.redirect(uiOf(c, s).url(`/ui/p/${slug}/settings?done=webhook-deleted#webhooks-title`), 303);
  });
}
