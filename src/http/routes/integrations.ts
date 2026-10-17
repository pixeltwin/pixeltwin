import { type OpenAPIHono, z } from '@hono/zod-openapi';
import type { Context } from 'hono';
import type { Provider } from '../../db/schema';
import { handleMerge, type MergeEvent, type MergeResult } from '../../domain/auto-promote';
import {
  deleteIntegration,
  getIntegration,
  type IntegrationView,
  integrationSchema,
  integrationsForRepository,
  updateIntegration,
} from '../../domain/integrations';
import { getProjectBySlug } from '../../domain/projects';
import { secretMatches, signatureMatches } from '../../domain/secrets';
import {
  createWebhook,
  createWebhookSchema,
  deleteWebhook,
  getWebhook,
  listDeliveries,
  listWebhooks,
  updateWebhook,
  updateWebhookSchema,
} from '../../domain/webhooks';
import { AppError } from '../../errors';
import { API, type AppEnv, type Services } from '../env';
import { defineRoute } from '../route';
import {
  CreatedWebhookSchema,
  DeliverySchema,
  InboundResultSchema,
  IntegrationSchema,
  json,
  problems,
  WebhookSchema,
} from '../schemas';

const slugParam = z.object({ slug: z.string() });
const hookParams = z.object({ slug: z.string(), id: z.string() });

/** Inbound code host webhooks: no session, no CSRF check, authenticated by their own secret. */
export const INBOUND_WEBHOOK_PATH = new RegExp(`^${API}/integrations/(github|gitlab)/webhook$`);

export function inboundWebhookUrl(publicUrl: string, provider: Provider): string {
  return `${publicUrl}${API}/integrations/${provider}/webhook`;
}

export function withWebhookUrl(view: IntegrationView, publicUrl: string) {
  return { ...view, webhookUrl: inboundWebhookUrl(publicUrl, view.provider) };
}

function invalidSignature(provider: Provider): AppError {
  return new AppError(
    'invalid_signature',
    401,
    provider === 'github'
      ? 'X-Hub-Signature-256 does not match the webhook secret of any project with this repository.'
      : 'X-Gitlab-Token does not match the webhook secret of any project with this project path.',
  );
}

async function readJson(c: Context<AppEnv>): Promise<{ raw: Uint8Array; body: Record<string, unknown> }> {
  const raw = new Uint8Array(await c.req.arrayBuffer());
  try {
    const body = JSON.parse(new TextDecoder().decode(raw)) as unknown;
    if (body && typeof body === 'object') return { raw, body: body as Record<string, unknown> };
  } catch {
    // Reported below.
  }
  throw new AppError('bad_request', 400, 'The webhook body is not JSON.');
}

const str = (value: unknown) => (typeof value === 'string' && value ? value : null);
const obj = (value: unknown) => (value && typeof value === 'object' ? (value as Record<string, unknown>) : {});

export function registerIntegrationRoutes(app: OpenAPIHono<AppEnv>, s: Services): void {
  const getRoute = defineRoute('project.admin', {
    method: 'get',
    path: `${API}/projects/{slug}/integration`,
    tags: ['integrations'],
    summary: "The project's code host integration (GitHub or GitLab); the token is never returned",
    request: { params: slugParam },
    responses: { 200: json(IntegrationSchema, 'The integration'), ...problems(401, 403, 404) },
  });
  app.openapi(getRoute, async (c) =>
    c.json(withWebhookUrl(await getIntegration(s.deps, c.req.valid('param').slug), s.config.publicUrl), 200),
  );

  const patchRoute = defineRoute('project.admin', {
    method: 'patch',
    path: `${API}/projects/{slug}/integration`,
    tags: ['integrations'],
    summary: 'Set up or change the code host integration: commit status, pull/merge request comment, auto-promote',
    description:
      'Omitted fields stay. `token: null` and `webhookSecret: null` remove them. Switching `provider` clears the ' +
      'token, the webhook secret and the URL. Auto-promote needs `repository` and `webhookSecret`.',
    request: {
      params: slugParam,
      body: { required: true, content: { 'application/json': { schema: integrationSchema } } },
    },
    responses: { 200: json(IntegrationSchema, 'The integration'), ...problems(401, 403, 404, 422) },
  });
  app.openapi(patchRoute, async (c) => {
    const view = await updateIntegration(s.deps, c.req.valid('param').slug, c.req.valid('json'));
    return c.json(withWebhookUrl(view, s.config.publicUrl), 200);
  });

  const deleteRoute = defineRoute('project.admin', {
    method: 'delete',
    path: `${API}/projects/{slug}/integration`,
    tags: ['integrations'],
    summary: 'Remove the code host integration with its token and secret',
    request: { params: slugParam },
    responses: { 204: { description: 'Removed' }, ...problems(401, 403, 404) },
  });
  app.openapi(deleteRoute, async (c) => {
    await deleteIntegration(s.deps, c.req.valid('param').slug);
    return c.body(null, 204);
  });

  const listHooks = defineRoute('project.admin', {
    method: 'get',
    path: `${API}/projects/{slug}/webhooks`,
    tags: ['webhooks'],
    summary: "The project's outgoing webhooks (never their secrets)",
    request: { params: slugParam },
    responses: { 200: json(z.object({ items: z.array(WebhookSchema) }), 'Webhooks'), ...problems(401, 403, 404) },
  });
  app.openapi(listHooks, async (c) => c.json({ items: await listWebhooks(s.deps, c.req.valid('param').slug) }, 200));

  const createHook = defineRoute('project.admin', {
    method: 'post',
    path: `${API}/projects/{slug}/webhooks`,
    tags: ['webhooks'],
    summary: 'Add a webhook: build.finalized, build.verdict_changed and check.reviewed, signed with its secret',
    description:
      'Each delivery is a POST with `X-Pixeltwin-Event`, `X-Pixeltwin-Delivery` (the same on retries) and ' +
      '`X-Pixeltwin-Signature: sha256=<HMAC-SHA256 of the body with the secret>`. Without `secret` one is ' +
      'generated and returned once. Failed deliveries (network, timeout, 5xx, 429) are retried with backoff ' +
      'for about five hours.',
    request: {
      params: slugParam,
      body: { required: true, content: { 'application/json': { schema: createWebhookSchema } } },
    },
    responses: { 201: json(CreatedWebhookSchema, 'The webhook'), ...problems(401, 403, 404, 422) },
  });
  app.openapi(createHook, async (c) => {
    const { webhook, secret } = await createWebhook(s.deps, c.req.valid('param').slug, c.req.valid('json'));
    return c.json({ ...webhook, secret }, 201);
  });

  const getHook = defineRoute('project.admin', {
    method: 'get',
    path: `${API}/projects/{slug}/webhooks/{id}`,
    tags: ['webhooks'],
    summary: 'Get a webhook',
    request: { params: hookParams },
    responses: { 200: json(WebhookSchema, 'The webhook'), ...problems(401, 403, 404) },
  });
  app.openapi(getHook, async (c) => {
    const { slug, id } = c.req.valid('param');
    return c.json(await getWebhook(s.deps, slug, id), 200);
  });

  const patchHook = defineRoute('project.admin', {
    method: 'patch',
    path: `${API}/projects/{slug}/webhooks/{id}`,
    tags: ['webhooks'],
    summary: 'Change a webhook (a new secret replaces the old one at once)',
    request: {
      params: hookParams,
      body: { required: true, content: { 'application/json': { schema: updateWebhookSchema } } },
    },
    responses: { 200: json(WebhookSchema, 'The webhook'), ...problems(401, 403, 404, 422) },
  });
  app.openapi(patchHook, async (c) => {
    const { slug, id } = c.req.valid('param');
    return c.json(await updateWebhook(s.deps, slug, id, c.req.valid('json')), 200);
  });

  const deleteHook = defineRoute('project.admin', {
    method: 'delete',
    path: `${API}/projects/{slug}/webhooks/{id}`,
    tags: ['webhooks'],
    summary: 'Delete a webhook with its deliveries',
    request: { params: hookParams },
    responses: { 204: { description: 'Deleted' }, ...problems(401, 403, 404) },
  });
  app.openapi(deleteHook, async (c) => {
    const { slug, id } = c.req.valid('param');
    await deleteWebhook(s.deps, slug, id);
    return c.body(null, 204);
  });

  const deliveries = defineRoute('project.admin', {
    method: 'get',
    path: `${API}/projects/{slug}/webhooks/{id}/deliveries`,
    tags: ['webhooks'],
    summary: "A webhook's last 20 deliveries, newest first: status code, error, duration",
    request: { params: hookParams },
    responses: {
      200: json(z.object({ items: z.array(DeliverySchema) }), 'Deliveries'),
      ...problems(401, 403, 404),
    },
  });
  app.openapi(deliveries, async (c) => {
    const { slug, id } = c.req.valid('param');
    return c.json({ items: await listDeliveries(s.deps, slug, id) }, 200);
  });

  const test = defineRoute('project.admin', {
    method: 'post',
    path: `${API}/projects/{slug}/webhooks/{id}/test`,
    tags: ['webhooks'],
    summary: 'Send test: a ping delivery sent now (once, no retries); the answer is its outcome',
    request: { params: hookParams },
    responses: { 200: json(DeliverySchema, 'The delivery'), ...problems(401, 403, 404) },
  });
  app.openapi(test, async (c) => {
    const { slug, id } = c.req.valid('param');
    const project = await getProjectBySlug(s.deps, slug);
    return c.json(await s.notifier.sendTest(project.id, id), 200);
  });

  registerInbound(app, s);
}

/** The merge event of each provider's payload; null when the event is not a merge. */
function githubMerge(event: string | undefined, body: Record<string, unknown>, delivery: string | null) {
  if (event !== 'pull_request') return { detail: `Ignored: only pull_request events are handled (got ${event}).` };
  const pr = obj(body.pull_request);
  if (body.action !== 'closed' || pr.merged !== true) {
    return { detail: 'Ignored: the pull request was not merged.' };
  }
  const merge: Omit<MergeEvent, 'repository'> = {
    provider: 'github',
    pullRequest: Number(pr.number),
    headBranch: str(obj(pr.head).ref) ?? '',
    baseBranch: str(obj(pr.base).ref) ?? '',
    mergeSha: str(pr.merge_commit_sha),
    mergedBy: str(obj(pr.merged_by).login),
    deliveryId: delivery,
  };
  return { merge };
}

function gitlabMerge(body: Record<string, unknown>, delivery: string | null) {
  if (body.object_kind !== 'merge_request') {
    return { detail: `Ignored: only merge request events are handled (got ${String(body.object_kind)}).` };
  }
  const mr = obj(body.object_attributes);
  if (mr.action !== 'merge') return { detail: 'Ignored: the merge request was not merged.' };
  const merge: Omit<MergeEvent, 'repository'> = {
    provider: 'gitlab',
    pullRequest: Number(mr.iid),
    headBranch: str(mr.source_branch) ?? '',
    baseBranch: str(mr.target_branch) ?? '',
    mergeSha: str(mr.merge_commit_sha),
    mergedBy: str(obj(body.user).username),
    deliveryId: delivery,
  };
  return { merge };
}

function registerInbound(app: OpenAPIHono<AppEnv>, s: Services): void {
  const providers: Array<{ provider: Provider; summary: string; description: string }> = [
    {
      provider: 'github',
      summary: 'GitHub repository webhook: a merged pull request promotes its branch (auto-promote)',
      description:
        'Point the repository webhook here (content type application/json, the "Pull requests" event, the secret ' +
        "from the project's integration settings). Verified with X-Hub-Signature-256; the project is the one whose " +
        'integration has this repository. A merged pull request promotes its head branch into its base branch, once.',
    },
    {
      provider: 'gitlab',
      summary: 'GitLab project webhook: a merged merge request promotes its branch (auto-promote)',
      description:
        'Point the project webhook here ("Merge request events", the secret token from the integration settings). ' +
        'Verified with X-Gitlab-Token; the project is the one whose integration has this project path. A merged ' +
        'merge request promotes its source branch into its target branch, once.',
    },
  ];
  for (const { provider, summary, description } of providers) {
    const doc = defineRoute('public', {
      method: 'post',
      path: `${API}/integrations/${provider}/webhook`,
      tags: ['integrations'],
      summary,
      description,
      responses: { 200: json(InboundResultSchema, 'What was done'), ...problems(400, 401, 413) },
    });
    const { middleware: _middleware, ...route } = doc;
    app.openAPIRegistry.registerPath(route);
    // A plain handler: the signature is computed over the raw bytes.
    app.post(`${API}/integrations/${provider}/webhook`, async (c) => {
      const { raw, body } = await readJson(c);
      const repository =
        provider === 'github' ? str(obj(body.repository).full_name) : str(obj(body.project).path_with_namespace);
      const candidates = repository ? await integrationsForRepository(s.deps, provider, repository) : [];
      const verified = candidates.filter((integration) =>
        provider === 'github'
          ? signatureMatches(integration.webhookSecret ?? '', raw, c.req.header('x-hub-signature-256'))
          : secretMatches(integration.webhookSecret ?? '', c.req.header('x-gitlab-token')),
      );
      if (verified.length === 0 || !repository) throw invalidSignature(provider);

      const event = c.req.header(provider === 'github' ? 'x-github-event' : 'x-gitlab-event');
      if (provider === 'github' && event === 'ping') {
        return c.json({ handled: false, detail: 'Pong: the secret matches.', results: [] }, 200);
      }
      const delivery = c.req.header(provider === 'github' ? 'x-github-delivery' : 'x-gitlab-event-uuid') ?? null;
      const parsed = provider === 'github' ? githubMerge(event, body, delivery) : gitlabMerge(body, delivery);
      if (!('merge' in parsed) || !parsed.merge) {
        return c.json({ handled: false, detail: parsed.detail ?? 'Ignored.', results: [] }, 200);
      }
      const merge = parsed.merge;
      if (!Number.isInteger(merge.pullRequest) || merge.pullRequest < 1 || !merge.headBranch || !merge.baseBranch) {
        throw new AppError('bad_request', 400, 'The merge event lacks its number or branches.');
      }
      const results: MergeResult[] = [];
      for (const integration of verified) {
        results.push(await handleMerge(s.deps, integration, { ...merge, repository }));
      }
      const promoted = results.filter((r) => r.outcome === 'promoted');
      const detail =
        promoted.length > 0
          ? `Promoted ${merge.headBranch} into ${merge.baseBranch}.`
          : `Nothing promoted: ${results.map((r) => `${r.project} ${r.outcome.replaceAll('_', ' ')}`).join(', ')}.`;
      return c.json({ handled: true, detail, results }, 200);
    });
  }
}
