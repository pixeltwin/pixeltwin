import { OutboundError, outboundFetch } from './outbound';

// The one place pixeltwin talks to GitHub's REST API: commit statuses and pull request comments.
// Each call has a timeout and is retried on 5xx, 429 and network errors. Errors carry GitHub's
// message and the request line, never the token (it only ever goes into the Authorization header).

export const GITHUB_API_URL = 'https://api.github.com';

export interface GitHubAuth {
  /** `https://api.github.com`, or a GitHub Enterprise Server's `https://host/api/v3`. */
  apiUrl: string;
  token: string;
}

export interface GitHubOptions {
  blockPrivate?: boolean;
  /** Per attempt; default 10 s. */
  timeoutMs?: number;
  /** Default 3. */
  attempts?: number;
  sleep?: (ms: number) => Promise<void>;
  fetch?: typeof fetch;
}

export class GitHubError extends Error {
  readonly status: number | null;
  /** Worth another try later: a 5xx, 429, timeout or network error. */
  readonly retryable: boolean;

  constructor(message: string, status: number | null, retryable: boolean) {
    super(message);
    this.name = 'GitHubError';
    this.status = status;
    this.retryable = retryable;
  }
}

function repoPath(repository: string): string {
  const [owner = '', name = ''] = repository.split('/');
  return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
}

/** Seconds from Retry-After, as milliseconds, at most 10 s; null without one. */
function retryAfterMs(res: Response): number | null {
  const seconds = Number(res.headers.get('retry-after'));
  return Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds, 10) * 1000 : null;
}

async function githubMessage(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { message?: unknown };
    return typeof body.message === 'string' ? body.message.slice(0, 300) : res.statusText;
  } catch {
    return res.statusText;
  }
}

async function request<T>(
  auth: GitHubAuth,
  method: string,
  path: string,
  body: unknown,
  options: GitHubOptions,
): Promise<{ status: number; data: T }> {
  const attempts = options.attempts ?? 3;
  const sleep = options.sleep ?? ((ms: number) => Bun.sleep(ms));
  const scrub = (text: string) => (auth.token ? text.replaceAll(auth.token, '***') : text);
  const what = `${method} ${path}`;
  let last: GitHubError | null = null;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    let res: Response;
    try {
      res = await outboundFetch(
        `${auth.apiUrl.replace(/\/+$/, '')}${path}`,
        {
          method,
          headers: {
            accept: 'application/vnd.github+json',
            authorization: `Bearer ${auth.token}`,
            'x-github-api-version': '2022-11-28',
            ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        },
        { blockPrivate: options.blockPrivate ?? false, timeoutMs: options.timeoutMs ?? 10_000, fetch: options.fetch },
      );
    } catch (err) {
      const message = scrub(err instanceof Error ? err.message : String(err));
      const retryable = err instanceof OutboundError ? err.retryable : true;
      last = new GitHubError(`GitHub ${what}: ${message}`, null, retryable);
      if (!retryable) throw last;
      if (attempt < attempts) await sleep(500 * 2 ** (attempt - 1));
      continue;
    }
    if (res.ok) {
      const text = await res.text();
      return { status: res.status, data: (text ? JSON.parse(text) : null) as T };
    }
    const retryable = res.status >= 500 || res.status === 429;
    last = new GitHubError(
      `GitHub answered ${res.status} to ${what}: ${scrub(await githubMessage(res))}`,
      res.status,
      retryable,
    );
    if (!retryable) throw last;
    if (attempt < attempts) await sleep(retryAfterMs(res) ?? 500 * 2 ** (attempt - 1));
  }
  throw last ?? new GitHubError(`GitHub ${what} failed`, null, true);
}

export interface CommitStatus {
  state: 'pending' | 'success' | 'failure' | 'error';
  /** At most 140 characters. */
  description: string;
  context: string;
  target_url: string;
}

export async function postCommitStatus(
  auth: GitHubAuth,
  repository: string,
  sha: string,
  status: CommitStatus,
  options: GitHubOptions = {},
): Promise<void> {
  await request(auth, 'POST', `${repoPath(repository)}/statuses/${encodeURIComponent(sha)}`, status, options);
}

/** Pages of a pull request's comments searched for the marker; older ones beyond are not. */
const MAX_COMMENT_PAGES = 10;

/**
 * Creates the pull request comment, or edits it in place: by `knownId` when given and still there,
 * else the comment containing `marker`. Returns the comment's id.
 */
export async function upsertComment(
  auth: GitHubAuth,
  repository: string,
  pullRequest: number,
  marker: string,
  body: string,
  knownId: string | null,
  options: GitHubOptions = {},
): Promise<string> {
  const repo = repoPath(repository);
  const edit = (id: string) =>
    request(auth, 'PATCH', `${repo}/issues/comments/${encodeURIComponent(id)}`, { body }, options);
  if (knownId) {
    try {
      await edit(knownId);
      return knownId;
    } catch (err) {
      // Deleted on GitHub: look for it by its marker (or make a new one) below.
      if (!(err instanceof GitHubError) || err.status !== 404) throw err;
    }
  }
  for (let page = 1; page <= MAX_COMMENT_PAGES; page++) {
    const { data } = await request<Array<{ id: number; body?: string }>>(
      auth,
      'GET',
      `${repo}/issues/${pullRequest}/comments?per_page=100&page=${page}`,
      undefined,
      options,
    );
    const found = data?.find((c) => c.body?.includes(marker));
    if (found) {
      await edit(String(found.id));
      return String(found.id);
    }
    if (!data || data.length < 100) break;
  }
  const { data } = await request<{ id: number }>(
    auth,
    'POST',
    `${repo}/issues/${pullRequest}/comments`,
    { body },
    options,
  );
  return String(data.id);
}
