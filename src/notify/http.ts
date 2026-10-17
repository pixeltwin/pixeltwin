import { OutboundError, outboundFetch } from './outbound';

// Calls to a code host's REST API (GitHub, GitLab), shared by both adapters: a timeout per attempt,
// retries on 5xx, 429 and network errors (honouring Retry-After), and errors that carry the host's
// message and the request line but never the token, which only ever goes into a request header.

export interface ApiOptions {
  blockPrivate?: boolean;
  /** Per attempt; default 10 s. */
  timeoutMs?: number;
  /** Default 3. */
  attempts?: number;
  sleep?: (ms: number) => Promise<void>;
  fetch?: typeof fetch;
}

export class CodeHostError extends Error {
  readonly status: number | null;
  /** Worth another try later: a 5xx, 429, timeout or network error. */
  readonly retryable: boolean;
  /** The host's own message, when it answered. */
  readonly hostMessage: string | null;

  constructor(message: string, status: number | null, retryable: boolean, hostMessage: string | null = null) {
    super(message);
    this.name = 'CodeHostError';
    this.status = status;
    this.retryable = retryable;
    this.hostMessage = hostMessage;
  }
}

export interface ApiTarget {
  /** `GitHub` or `GitLab`, for messages. */
  host: string;
  /** Prefix of every path, without a trailing slash. */
  base: string;
  token: string;
  /** Headers of every request, the token's among them. */
  headers: Record<string, string>;
}

/** Seconds from Retry-After, as milliseconds, at most 10 s; null without one. */
function retryAfterMs(res: Response): number | null {
  const seconds = Number(res.headers.get('retry-after'));
  return Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds, 10) * 1000 : null;
}

/** GitHub: `{ message }`; GitLab: `{ message }` (text or field errors) or `{ error }`. */
async function hostMessage(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { message?: unknown; error?: unknown };
    const message = body.message ?? body.error;
    if (typeof message === 'string') return message.slice(0, 300);
    return message ? JSON.stringify(message).slice(0, 300) : res.statusText;
  } catch {
    return res.statusText;
  }
}

export async function apiRequest<T>(
  target: ApiTarget,
  method: string,
  path: string,
  body: unknown,
  options: ApiOptions,
): Promise<{ status: number; data: T }> {
  const attempts = options.attempts ?? 3;
  const sleep = options.sleep ?? ((ms: number) => Bun.sleep(ms));
  const scrub = (text: string) => (target.token ? text.replaceAll(target.token, '***') : text);
  const what = `${method} ${path.replace(/\?.*$/, '')}`;
  let last: CodeHostError | null = null;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    let res: Response;
    try {
      res = await outboundFetch(
        `${target.base}${path}`,
        {
          method,
          headers: { ...target.headers, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        },
        { blockPrivate: options.blockPrivate ?? false, timeoutMs: options.timeoutMs ?? 10_000, fetch: options.fetch },
      );
    } catch (err) {
      const message = scrub(err instanceof Error ? err.message : String(err));
      const retryable = err instanceof OutboundError ? err.retryable : true;
      last = new CodeHostError(`${target.host} ${what}: ${message}`, null, retryable);
      if (!retryable) throw last;
      if (attempt < attempts) await sleep(500 * 2 ** (attempt - 1));
      continue;
    }
    if (res.ok) {
      const text = await res.text();
      return { status: res.status, data: (text ? JSON.parse(text) : null) as T };
    }
    const retryable = res.status >= 500 || res.status === 429;
    const message = scrub(await hostMessage(res));
    last = new CodeHostError(
      `${target.host} answered ${res.status} to ${what}: ${message}`,
      res.status,
      retryable,
      message,
    );
    if (!retryable) throw last;
    if (attempt < attempts) await sleep(retryAfterMs(res) ?? 500 * 2 ** (attempt - 1));
  }
  throw last ?? new CodeHostError(`${target.host} ${what} failed`, null, true);
}

/** What the notifier needs from a code host; GitHub and GitLab are the two adapters. */
export interface StatusUpdate {
  state: 'pending' | 'success' | 'failure';
  /** At most 140 characters (GitHub's limit). */
  description: string;
  /** `pixeltwin/<project slug>`. */
  context: string;
  targetUrl: string;
}

export interface CodeHost {
  readonly name: string;
  postStatus(repository: string, sha: string, status: StatusUpdate): Promise<void>;
  /**
   * Creates the pull (merge) request comment, or edits it in place: by `knownId` when given and
   * still there, else the comment containing `marker`. Returns the comment's id.
   */
  upsertComment(
    repository: string,
    number: number,
    marker: string,
    body: string,
    knownId: string | null,
  ): Promise<string>;
}

/** Pages of comments searched for the marker; older ones beyond are not. */
export const MAX_COMMENT_PAGES = 10;

/** The shared comment logic: edit the known one, else find it by marker page by page, else create. */
export async function upsertByMarker(ops: {
  edit(id: string): Promise<unknown>;
  page(n: number): Promise<Array<{ id: number | string; body?: string }> | null>;
  create(): Promise<string>;
  knownId: string | null;
  marker: string;
}): Promise<string> {
  if (ops.knownId) {
    try {
      await ops.edit(ops.knownId);
      return ops.knownId;
    } catch (err) {
      // Deleted on the host: look for it by its marker (or make a new one) below.
      if (!(err instanceof CodeHostError) || err.status !== 404) throw err;
    }
  }
  for (let n = 1; n <= MAX_COMMENT_PAGES; n++) {
    const items = await ops.page(n);
    const found = items?.find((c) => c.body?.includes(ops.marker));
    if (found) {
      await ops.edit(String(found.id));
      return String(found.id);
    }
    if (!items || items.length < 100) break;
  }
  return ops.create();
}
