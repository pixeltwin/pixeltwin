import { type FieldError, PixeltwinError, PixeltwinNetworkError } from './errors.js';
import { toPixelRect } from './png.js';
import type { TimingInput } from './timing.js';
import type {
  Area,
  Build,
  ChangeGroup,
  Check,
  CheckInput,
  CheckResult,
  CheckReview,
  GroupReview,
  OpenBuildInput,
  Page,
  PageElement,
  PromotionCandidate,
  Rect,
  ReviewEvent,
  ReviewOutcome,
  ScreenHistory,
} from './types.js';

export const SDK_VERSION = '0.1.0';

export interface ClientOptions {
  /** Server root, e.g. `https://pixeltwin.example.com` (with its path prefix, if any). */
  url: string;
  /** Project token: `read` and `write`; `review` to approve. */
  token: string;
  /** Retries after the first attempt on network errors, timeouts, 408, 429 and 5xx. Default 3. */
  retries?: number;
  /** First backoff delay; doubles per retry (capped at 10 s, ±25 % jitter). Default 500 ms. */
  retryDelayMs?: number;
  /** Per attempt. Default 60 s (the server compares before it answers). */
  timeoutMs?: number;
  /** Replaces the global `fetch` (tests, proxies). */
  fetch?: typeof fetch;
}

type Body = { json: unknown } | { form: FormData };

const MAX_BACKOFF_MS = 10_000;
const MAX_RETRY_AFTER_MS = 60_000;

function randomId(): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  return uuid ? uuid.replace(/-/g, '').slice(0, 20) : Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function retryable(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

/** `Retry-After` in seconds (an HTTP date is ignored); null when absent. */
function retryAfterMs(res: Response): number | null {
  const value = res.headers.get('retry-after');
  if (!value || !/^\d+$/.test(value.trim())) return null;
  return Math.min(Number(value) * 1000, MAX_RETRY_AFTER_MS);
}

async function problemOf(res: Response, text: string, method: string, path: string): Promise<PixeltwinError> {
  let problem: { code?: unknown; detail?: unknown; title?: unknown; errors?: unknown; requestId?: unknown } = {};
  try {
    problem = JSON.parse(text);
  } catch {
    // Not JSON: a proxy's error page, for example.
  }
  return new PixeltwinError({
    status: res.status,
    code: typeof problem.code === 'string' ? problem.code : `http_${res.status}`,
    detail:
      typeof problem.detail === 'string'
        ? problem.detail
        : typeof problem.title === 'string'
          ? problem.title
          : text.slice(0, 200) || res.statusText,
    errors: Array.isArray(problem.errors) ? (problem.errors as FieldError[]) : undefined,
    requestId:
      typeof problem.requestId === 'string' ? problem.requestId : (res.headers.get('x-request-id') ?? undefined),
    method,
    path,
  });
}

/** A framework-free client for the pixeltwin REST API (`/api/v1`). */
export class PixeltwinClient {
  readonly url: string;
  readonly #token: string;
  readonly #retries: number;
  readonly #retryDelayMs: number;
  readonly #timeoutMs: number;
  readonly #fetch: typeof fetch;
  /** The server refused `elements` (older than this SDK): later checks are posted without them. */
  #noElements = false;

  constructor(options: ClientOptions) {
    if (!options.url) throw new Error('pixeltwin: `url` is required.');
    if (!options.token) throw new Error('pixeltwin: `token` is required (a project token with read and write).');
    this.url = options.url.replace(/\/+$/, '');
    this.#token = options.token;
    this.#retries = options.retries ?? 3;
    this.#retryDelayMs = options.retryDelayMs ?? 500;
    this.#timeoutMs = options.timeoutMs ?? 60_000;
    this.#fetch = options.fetch ?? globalThis.fetch;
  }

  /** Opens a build, or returns the one with the same `externalId` (`created: false`). */
  async openBuild(project: string, input: OpenBuildInput = {}): Promise<Build & { created: boolean }> {
    const body = { ...input, externalId: input.externalId ?? `sdk-${randomId()}` };
    const { status, data } = await this.#request<Build>('POST', `/projects/${encodeURIComponent(project)}/builds`, {
      json: body,
    });
    return { ...data, created: status === 201 };
  }

  async getBuild(id: string): Promise<Build> {
    return (await this.#request<Build>('GET', `/builds/${encodeURIComponent(id)}`)).data;
  }

  /**
   * Posts a screenshot; the answer comes after the comparison. Same name + variant again replaces it.
   * A server older than this SDK refuses `elements`: the check is then posted again without them.
   */
  async postCheck(buildId: string, input: CheckInput): Promise<Check> {
    if (!input.name) throw new Error('pixeltwin: a check needs a name.');
    const ignoreRegions = (input.ignoreRegions ?? []).map((r) => toPixelRect(r)).filter((r) => r !== null);
    const meta = {
      name: input.name,
      variant: input.variant ?? {},
      ignoreRegions,
      ...(input.colorThreshold === undefined ? {} : { colorThreshold: input.colorThreshold }),
      ...(input.tolerancePercent === undefined ? {} : { tolerancePercent: input.tolerancePercent }),
    };
    const send = async (elements: PageElement[] | undefined) => {
      const form = new FormData();
      form.set('image', new Blob([input.image as Uint8Array<ArrayBuffer>], { type: 'image/png' }), 'image.png');
      form.set('meta', JSON.stringify(elements ? { ...meta, elements } : meta));
      return (await this.#request<Check>('POST', `/builds/${encodeURIComponent(buildId)}/checks`, { form })).data;
    };
    const elements = this.#noElements || !input.elements?.length ? undefined : input.elements;
    if (!elements) return send(undefined);
    try {
      return await send(elements);
    } catch (err) {
      const refused =
        err instanceof PixeltwinError &&
        err.code === 'validation_failed' &&
        (err.errors ?? []).some((e) => e.message.includes('"elements"'));
      if (!refused) throw err;
      this.#noElements = true;
      return send(undefined);
    }
  }

  async getCheck(id: string): Promise<Check> {
    return (await this.#request<Check>('GET', `/checks/${encodeURIComponent(id)}`)).data;
  }

  /** The page elements sent with the check and with the baseline it was compared with (null where none). */
  async checkElements(checkId: string): Promise<{ current: PageElement[] | null; baseline: PageElement[] | null }> {
    const path = `/checks/${encodeURIComponent(checkId)}/elements`;
    return (await this.#request<{ current: PageElement[] | null; baseline: PageElement[] | null }>('GET', path)).data;
  }

  /** The project's builds, newest first, optionally of one branch. */
  async listBuilds(
    project: string,
    query: { branch?: string; limit?: number; cursor?: string } = {},
  ): Promise<Page<Build>> {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) if (value !== undefined) params.set(key, String(value));
    const qs = params.size ? `?${params}` : '';
    return (await this.#request<Page<Build>>('GET', `/projects/${encodeURIComponent(project)}/builds${qs}`)).data;
  }

  /** Every approval, rejection, undo and suggestion of a check, newest first. */
  async listReviews(checkId: string): Promise<ReviewEvent[]> {
    const path = `/checks/${encodeURIComponent(checkId)}/reviews`;
    return (await this.#request<{ items: ReviewEvent[] }>('GET', path)).data.items;
  }

  /**
   * Approves or rejects a check (needs the `review` scope) with a reason, kept in its history. Under
   * the project's agent review policy the review may be recorded as a suggestion for a person
   * (`outcome: 'suggested'`), and a reason is required.
   */
  async review(
    checkId: string,
    action: 'approve' | 'reject',
    options: { reason?: string } = {},
  ): Promise<Check & { outcome: ReviewOutcome }> {
    const path = `/checks/${encodeURIComponent(checkId)}/${action}`;
    const body = options.reason ? { json: { reason: options.reason } } : undefined;
    return (await this.#request<Check & { outcome: ReviewOutcome }>('POST', path, body)).data;
  }

  /** The build's change groups (checks with exactly the same changes), biggest first. */
  async listGroups(buildId: string): Promise<ChangeGroup[]> {
    const path = `/builds/${encodeURIComponent(buildId)}/groups`;
    return (await this.#request<{ items: ChangeGroup[] }>('GET', path)).data.items;
  }

  /**
   * Approves or rejects every check of a change group that waits for review (of `checkIds`, when
   * given; needs the `review` scope). Under the project's agent review policy some members become
   * suggestions for a person (`suggested`), and a reason is required.
   */
  async reviewGroup(
    buildId: string,
    groupId: string,
    action: 'approve' | 'reject',
    options: { reason?: string; checkIds?: string[] } = {},
  ): Promise<GroupReview> {
    const path = `/builds/${encodeURIComponent(buildId)}/groups/${encodeURIComponent(groupId)}/${action}`;
    const body = {
      ...(options.reason ? { reason: options.reason } : {}),
      ...(options.checkIds ? { checkIds: options.checkIds } : {}),
    };
    return (await this.#request<GroupReview>('POST', path, Object.keys(body).length ? { json: body } : undefined)).data;
  }

  /** The check's screen over its last checks on the branch, and whether it is flaky. */
  async checkHistory(checkId: string): Promise<ScreenHistory> {
    return (await this.#request<ScreenHistory>('GET', `/checks/${encodeURIComponent(checkId)}/history`)).data;
  }

  /** The project's flaky screens, per branch, most flaky first. */
  async noisyScreens(project: string): Promise<ScreenHistory[]> {
    const path = `/projects/${encodeURIComponent(project)}/noisy-screens`;
    return (await this.#request<{ items: ScreenHistory[] }>('GET', path)).data.items;
  }

  /** Draws an ignore area on the check's snapshot (screenshot pixels); the check is compared again. */
  async addIgnoreArea(checkId: string, rect: Rect): Promise<{ area: Area; check: Check }> {
    const path = `/checks/${encodeURIComponent(checkId)}/areas`;
    return (await this.#request<{ area: Area; check: Check }>('POST', path, { json: { kind: 'ignore', ...rect } }))
      .data;
  }

  async listChecks(
    buildId: string,
    query: { result?: CheckResult; review?: CheckReview; limit?: number; cursor?: string } = {},
  ): Promise<Page<Check>> {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) if (value !== undefined) params.set(key, String(value));
    const qs = params.size ? `?${params}` : '';
    return (await this.#request<Page<Check>>('GET', `/builds/${encodeURIComponent(buildId)}/checks${qs}`)).data;
  }

  /** Closes the build to new checks and returns its verdict. Idempotent. */
  /**
   * Closes the build. A part of a parallel build passes its `part`: the build then stays open until
   * every part has finalized it (the answer says how many have).
   */
  async finalize(buildId: string, options: { part?: string } = {}): Promise<Build> {
    const path = `/builds/${encodeURIComponent(buildId)}/finalize`;
    return (await this.#request<Build>('POST', path, options.part ? { json: { part: options.part } } : undefined)).data;
  }

  /** Adds what one worker measured (screenshots, uploads, retakes) to the build's timing. */
  async addTimings(buildId: string, totals: TimingInput): Promise<Build> {
    const path = `/builds/${encodeURIComponent(buildId)}/timings`;
    return (await this.#request<Build>('POST', path, { json: totals })).data;
  }

  /** The branch's screens whose baseline differs from main's: what `promote` would copy. */
  async promotionCandidates(project: string, branch: string): Promise<PromotionCandidate[]> {
    const path = `/projects/${encodeURIComponent(project)}/branches/${encodeURIComponent(branch)}/promote`;
    return (await this.#request<{ items: PromotionCandidate[] }>('GET', path)).data.items;
  }

  /**
   * Copies the branch's baselines to main (after merging), all differing screens or only
   * `snapshotKeys`. Needs the `write` scope.
   */
  async promote(project: string, branch: string, snapshotKeys?: string[]): Promise<{ promoted: number }> {
    const path = `/projects/${encodeURIComponent(project)}/branches/${encodeURIComponent(branch)}/promote`;
    return (
      await this.#request<{ promoted: number }>('POST', path, snapshotKeys ? { json: { snapshotKeys } } : undefined)
    ).data;
  }

  /**
   * Approves every pending check of the build (needs the `review` scope). Under the project's agent
   * review policy some approvals become suggestions (`suggested`), and a reason is required.
   */
  async approveBuild(
    buildId: string,
    options: { reason?: string } = {},
  ): Promise<{ approved: number; suggested: number }> {
    const path = `/builds/${encodeURIComponent(buildId)}/approve`;
    return (
      await this.#request<{ approved: number; suggested: number }>(
        'POST',
        path,
        options.reason ? { json: { reason: options.reason } } : undefined,
      )
    ).data;
  }

  /** Polls the build while its verdict is `pending` (checks waiting for a review), up to `timeoutMs`. */
  async waitForVerdict(buildId: string, options: { timeoutMs: number; intervalMs?: number }): Promise<Build> {
    const deadline = Date.now() + options.timeoutMs;
    const interval = options.intervalMs ?? 5000;
    let build = await this.getBuild(buildId);
    while (build.verdict === 'pending' && Date.now() + interval <= deadline) {
      await sleep(interval);
      build = await this.getBuild(buildId);
    }
    return build;
  }

  /** The build's page in the web UI. */
  buildUrl(buildId: string): string {
    return `${this.url}/ui/builds/${encodeURIComponent(buildId)}`;
  }

  /** The check's review page in the web UI. */
  checkUrl(check: Pick<Check, 'links'>): string {
    return `${this.url}${check.links.review}`;
  }

  #backoff(attempt: number): number {
    const base = Math.min(MAX_BACKOFF_MS, this.#retryDelayMs * 2 ** attempt);
    return Math.round(base * (0.75 + Math.random() * 0.5));
  }

  /**
   * An image of a check (`check.links.image`, `.baseline`, `.diff`) or by sha, as PNG bytes. Uses the
   * client's token, so it works where the API needs one.
   */
  async fetchImage(linkOrSha: string): Promise<Uint8Array> {
    const path = linkOrSha.startsWith('/api/v1/') ? linkOrSha.slice('/api/v1'.length) : `/images/${linkOrSha}`;
    return (await this.#request<Uint8Array>('GET', path, undefined, true)).data;
  }

  async #request<T>(method: string, path: string, body?: Body, raw = false): Promise<{ status: number; data: T }> {
    const url = `${this.url}/api/v1${path}`;
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.#token}`,
      accept: 'application/json, application/problem+json',
      'user-agent': `pixeltwin-js/${SDK_VERSION}`,
    };
    if (body && 'json' in body) headers['content-type'] = 'application/json';
    const payload = body ? ('json' in body ? JSON.stringify(body.json) : body.form) : undefined;

    let lastError: unknown;
    for (let attempt = 0; ; attempt++) {
      const last = attempt >= this.#retries;
      let res: Response;
      let text: string;
      let bytes: Uint8Array | null = null;
      try {
        res = await this.#fetch(url, {
          method,
          headers,
          body: payload,
          signal: AbortSignal.timeout(this.#timeoutMs),
        });
        if (raw && res.ok) {
          bytes = new Uint8Array(await res.arrayBuffer());
          text = '';
        } else {
          text = await res.text();
        }
      } catch (err) {
        lastError = err;
        if (last) throw new PixeltwinNetworkError(method, path, attempt + 1, lastError);
        await sleep(this.#backoff(attempt));
        continue;
      }
      if (res.ok) return { status: res.status, data: (bytes ?? (text ? JSON.parse(text) : {})) as T };
      if (retryable(res.status) && !last) {
        await sleep(retryAfterMs(res) ?? this.#backoff(attempt));
        continue;
      }
      throw await problemOf(res, text, method, path);
    }
  }
}
