// `fetch` for /api/v1 with the session cookie (UI spec §3.3). Problems become ApiError.

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly detail: string,
  ) {
    super(detail);
  }
}

/** PUBLIC_URL's path (`""` or `/vrt`), from the layout's `<body data-base>`. */
export function basePath(): string {
  return document.body.dataset.base ?? '';
}

/** This page's path and query without the base path: the `next` for the login page. */
export function here(): string {
  const base = basePath();
  const path = location.pathname.startsWith(base) ? location.pathname.slice(base.length) : location.pathname;
  return path + location.search;
}

export async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${basePath()}/api/v1${path}`, {
      method,
      credentials: 'same-origin',
      headers: body === undefined ? { accept: 'application/json' } : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, 'network_error', 'The server could not be reached.');
  }
  if (res.status === 401) {
    location.assign(`${basePath()}/ui/login?next=${encodeURIComponent(here())}`);
    throw new ApiError(401, 'unauthenticated', 'Log in again.');
  }
  const text = await res.text();
  const data = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  if (!res.ok) {
    throw new ApiError(res.status, String(data.code ?? 'error'), String(data.detail ?? res.statusText));
  }
  return data as T;
}

/** Fetches another UI page and parses it, for swapping parts of this page in place. */
export async function fetchPage(url: string): Promise<Document> {
  let res: Response;
  try {
    res = await fetch(url, { credentials: 'same-origin', headers: { accept: 'text/html' } });
  } catch {
    throw new ApiError(0, 'network_error', 'The server could not be reached.');
  }
  if (res.redirected && new URL(res.url).pathname.endsWith('/ui/login')) {
    location.assign(res.url);
    throw new ApiError(401, 'unauthenticated', 'Log in again.');
  }
  if (!res.ok) throw new ApiError(res.status, 'page_error', res.statusText);
  return new DOMParser().parseFromString(await res.text(), 'text/html');
}
