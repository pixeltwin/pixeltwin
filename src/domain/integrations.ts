import { sql } from 'kysely';
import { z } from 'zod';
import { type IntegrationsTable, PROVIDERS, type Provider } from '../db/schema';
import { AppError, type FieldError } from '../errors';
import { GITHUB_API_URL } from '../notify/github';
import { GITLAB_URL } from '../notify/gitlab';
import { outboundUrlProblem } from '../notify/outbound';
import type { Deps } from './deps';
import { getProjectBySlug } from './projects';
import { parseInput, repositorySchema } from './schemas';
import { PLAIN_SECRETS, type SecretBox } from './secrets';

// A project's code host integration: GitHub or GitLab, one at a time. Where its builds report (a
// commit status, one pull/merge request comment per build) and whether a merged pull request
// promotes its branch. The token and the webhook secret are write-only: the API says whether they
// are set (and the token's last four characters).

type IntegrationDeps = Pick<Deps, 'db' | 'secrets'>;

export function secretsOf(deps: Pick<Deps, 'secrets'>): SecretBox {
  return deps.secrets ?? PLAIN_SECRETS;
}

export const DEFAULT_BASE_URLS: Record<Provider, string> = { github: GITHUB_API_URL, gitlab: GITLAB_URL };
export const PROVIDER_NAMES: Record<Provider, string> = { github: 'GitHub', gitlab: 'GitLab' };

const emptyToNull = (value: unknown) => (value === '' ? null : value);

export const integrationSchema = z.strictObject({
  /** `github` or `gitlab`. Switching it clears the token, the webhook secret and the URL. */
  provider: z.enum(PROVIDERS).optional(),
  /** GitHub `owner/name` or GitLab `group/sub/project`; used when a build names none, and to match incoming webhooks. */
  repository: z.preprocess(emptyToNull, repositorySchema.nullable()).optional(),
  /** GitHub's API URL or the GitLab instance URL; empty means https://api.github.com or https://gitlab.com. */
  baseUrl: z
    .preprocess(
      (value) => (value === '' ? null : value),
      z
        .string()
        .trim()
        .max(500)
        .superRefine((value, ctx) => {
          const problem = outboundUrlProblem(value);
          if (problem) ctx.addIssue({ code: 'custom', message: problem });
        })
        .transform((value) => value.replace(/\/+$/, ''))
        .nullable(),
    )
    .optional(),
  /** GitHub: a fine-grained token (Commit statuses, Pull requests: write); GitLab: a project access token (api). null removes it. */
  token: z.preprocess(emptyToNull, z.string().trim().min(1).max(1000).nullable()).optional(),
  commitStatus: z.boolean().optional(),
  prComment: z.boolean().optional(),
  autoPromote: z.boolean().optional(),
  /** GitHub: the webhook's secret; GitLab: the webhook's secret token. null removes it. */
  webhookSecret: z.preprocess(emptyToNull, z.string().min(16).max(200).nullable()).optional(),
});

export interface IntegrationView {
  /** False until the integration is first saved. */
  configured: boolean;
  provider: Provider;
  repository: string | null;
  baseUrl: string;
  tokenSet: boolean;
  /** The token's last four characters, to recognise it. */
  tokenLast4: string | null;
  commitStatus: boolean;
  prComment: boolean;
  autoPromote: boolean;
  webhookSecretSet: boolean;
  /** Secrets are encrypted at rest (SECRET_KEY is set). */
  encrypted: boolean;
  /** The last time a build was reported to the code host, and the error if it failed. */
  lastSync: { buildId: string; at: number; error: string | null } | null;
  /** The last merged pull (merge) request auto-promote handled. */
  lastMerge: {
    repository: string;
    pullRequest: number;
    headBranch: string;
    baseBranch: string;
    mergedBy: string | null;
    promoted: number | null;
    at: number;
  } | null;
  updatedAt: number | null;
}

/** What delivering needs, secrets opened. Opening throws 500 secret_unreadable when SECRET_KEY changed. */
export interface IntegrationConfig {
  projectId: string;
  provider: Provider;
  repository: string | null;
  baseUrl: string;
  token: string | null;
  commitStatus: boolean;
  prComment: boolean;
  autoPromote: boolean;
  webhookSecret: string | null;
}

function row(deps: Pick<Deps, 'db'>, projectId: string) {
  return deps.db.selectFrom('integrations').selectAll().where('projectId', '=', projectId).executeTakeFirst();
}

async function viewOf(
  deps: IntegrationDeps,
  projectId: string,
  stored: IntegrationsTable | undefined,
): Promise<IntegrationView> {
  const [sync, merge] = await Promise.all([
    deps.db
      .selectFrom('integrationSyncs')
      .select(['buildId', 'updatedAt', 'lastError'])
      .where('projectId', '=', projectId)
      .where((eb) => eb.or([eb('syncedAt', 'is not', null), eb('lastError', 'is not', null)]))
      .orderBy('updatedAt', 'desc')
      .limit(1)
      .executeTakeFirst(),
    deps.db
      .selectFrom('integrationMerges')
      .selectAll()
      .where('projectId', '=', projectId)
      .orderBy('createdAt', 'desc')
      .limit(1)
      .executeTakeFirst(),
  ]);
  const provider = stored?.provider ?? 'github';
  return {
    configured: stored !== undefined,
    provider,
    repository: stored?.repository ?? null,
    baseUrl: stored?.baseUrl ?? DEFAULT_BASE_URLS[provider],
    tokenSet: Boolean(stored?.token),
    tokenLast4: stored?.token ? stored.tokenLast4 : null,
    commitStatus: stored ? Number(stored.commitStatus) === 1 : true,
    prComment: stored ? Number(stored.prComment) === 1 : true,
    autoPromote: stored ? Number(stored.autoPromote) === 1 : false,
    webhookSecretSet: Boolean(stored?.webhookSecret),
    encrypted: secretsOf(deps).encrypts,
    lastSync: sync ? { buildId: sync.buildId, at: Number(sync.updatedAt), error: sync.lastError } : null,
    lastMerge: merge
      ? {
          repository: merge.repository,
          pullRequest: Number(merge.pullRequest),
          headBranch: merge.headBranch,
          baseBranch: merge.baseBranch,
          mergedBy: merge.mergedBy,
          promoted: merge.promoted === null ? null : Number(merge.promoted),
          at: Number(merge.createdAt),
        }
      : null,
    updatedAt: stored ? Number(stored.updatedAt) : null,
  };
}

export async function getIntegration(deps: IntegrationDeps, projectSlug: string): Promise<IntegrationView> {
  const project = await getProjectBySlug(deps, projectSlug);
  return viewOf(deps, project.id, await row(deps, project.id));
}

/**
 * Changes the integration (creating it on first save, GitHub unless `provider` says otherwise).
 * Omitted fields stay; `token: null` and `webhookSecret: null` remove them. Switching the provider
 * clears the token, the webhook secret and the URL, which belong to the other host. Auto-promote
 * needs a repository and a webhook secret.
 */
export async function updateIntegration(
  deps: IntegrationDeps,
  projectSlug: string,
  input: unknown,
): Promise<IntegrationView> {
  const changes = parseInput(integrationSchema, input);
  const project = await getProjectBySlug(deps, projectSlug);
  const found = await row(deps, project.id);
  const provider = changes.provider ?? found?.provider ?? 'github';
  // The other host's token and secret mean nothing here.
  const stored = found && found.provider === provider ? found : undefined;
  const box = secretsOf(deps);
  const now = Date.now();
  const next: IntegrationsTable = {
    projectId: project.id,
    provider,
    repository: changes.repository !== undefined ? changes.repository : (stored?.repository ?? null),
    baseUrl: changes.baseUrl ?? stored?.baseUrl ?? DEFAULT_BASE_URLS[provider],
    token: stored?.token ?? null,
    tokenLast4: stored?.tokenLast4 ?? null,
    commitStatus: changes.commitStatus !== undefined ? Number(changes.commitStatus) : (found?.commitStatus ?? 1),
    prComment: changes.prComment !== undefined ? Number(changes.prComment) : (found?.prComment ?? 1),
    autoPromote: changes.autoPromote !== undefined ? Number(changes.autoPromote) : (found?.autoPromote ?? 0),
    webhookSecret: stored?.webhookSecret ?? null,
    createdAt: found?.createdAt ?? now,
    updatedAt: now,
  };
  if (changes.token !== undefined) {
    next.token = changes.token === null ? null : box.seal(changes.token);
    next.tokenLast4 = changes.token === null ? null : changes.token.slice(-4);
  }
  if (changes.webhookSecret !== undefined) {
    next.webhookSecret = changes.webhookSecret === null ? null : box.seal(changes.webhookSecret);
  }
  const errors: FieldError[] = [];
  // The token goes to the base URL with every call: whoever moves it elsewhere (a maintainer, who
  // cannot read the token someone else entered) must enter the token again.
  if (stored?.token && next.baseUrl !== stored.baseUrl && changes.token === undefined) {
    errors.push({
      path: 'token',
      message: 'Enter the token again: the URL changed, and the saved token is not sent to a new URL',
    });
  }
  if (provider === 'github' && next.repository && !/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(next.repository)) {
    errors.push({ path: 'repository', message: 'Use owner/name, e.g. acme/shop' });
  }
  if (Number(next.autoPromote) === 1) {
    if (!next.repository) errors.push({ path: 'repository', message: 'Auto-promote needs the repository' });
    if (!next.webhookSecret) errors.push({ path: 'webhookSecret', message: "Auto-promote needs the webhook's secret" });
  }
  if (errors.length > 0) throw new AppError('validation_failed', 422, 'The request is invalid.', errors);
  const { projectId: _projectId, createdAt: _createdAt, ...update } = next;
  await deps.db
    .insertInto('integrations')
    .values(next)
    .onConflict((oc) => oc.column('projectId').doUpdateSet(update))
    .execute();
  // Comments made on the other host are not ours to edit any more.
  if (found && found.provider !== provider) {
    await deps.db.deleteFrom('integrationSyncs').where('projectId', '=', project.id).execute();
  }
  return viewOf(deps, project.id, next);
}

/** Removes the integration with its token and secret; queued updates are dropped. */
export async function deleteIntegration(deps: IntegrationDeps, projectSlug: string): Promise<void> {
  const project = await getProjectBySlug(deps, projectSlug);
  await deps.db.deleteFrom('integrationSyncs').where('projectId', '=', project.id).execute();
  await deps.db.deleteFrom('integrations').where('projectId', '=', project.id).execute();
}

function configOf(deps: IntegrationDeps, stored: IntegrationsTable): IntegrationConfig {
  const box = secretsOf(deps);
  return {
    projectId: stored.projectId,
    provider: stored.provider,
    repository: stored.repository,
    baseUrl: stored.baseUrl,
    token: stored.token ? box.open(stored.token) : null,
    commitStatus: Number(stored.commitStatus) === 1,
    prComment: Number(stored.prComment) === 1,
    autoPromote: Number(stored.autoPromote) === 1,
    webhookSecret: stored.webhookSecret ? box.open(stored.webhookSecret) : null,
  };
}

/** The project's integration with its secrets opened; null when there is none. */
export async function loadIntegration(deps: IntegrationDeps, projectId: string): Promise<IntegrationConfig | null> {
  const stored = await row(deps, projectId);
  return stored ? configOf(deps, stored) : null;
}

/** True when builds of the project should be reported to its code host at all (cheap: no secret opened). */
export async function reportsToCodeHost(deps: Pick<Deps, 'db'>, projectId: string): Promise<boolean> {
  const stored = await row(deps, projectId);
  return Boolean(stored?.token) && (Number(stored?.commitStatus) === 1 || Number(stored?.prComment) === 1);
}

/**
 * Integrations of `provider` whose repository is `repository` (any case) and that have a webhook
 * secret, with their project slug. A secret that cannot be opened (SECRET_KEY changed) leaves that
 * one out.
 */
export async function integrationsForRepository(
  deps: IntegrationDeps,
  provider: Provider,
  repository: string,
): Promise<Array<IntegrationConfig & { slug: string }>> {
  const rows = await deps.db
    .selectFrom('integrations')
    .innerJoin('projects', 'projects.id', 'integrations.projectId')
    .selectAll('integrations')
    .select('projects.slug')
    .where('integrations.provider', '=', provider)
    .where(sql`lower(${sql.ref('integrations.repository')})`, '=', repository.toLowerCase())
    .where('integrations.webhookSecret', 'is not', null)
    .execute();
  const out: Array<IntegrationConfig & { slug: string }> = [];
  for (const { slug, ...stored } of rows) {
    try {
      out.push({ ...configOf(deps, stored), slug });
    } catch {
      // Unreadable secret: this project cannot verify the delivery.
    }
  }
  return out;
}
