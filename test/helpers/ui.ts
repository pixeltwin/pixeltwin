import { type As, PUBLIC_URL, type TestApp } from './app';

/** Submits a form the way a browser does: urlencoded, with this site's Origin. */
export function postForm(
  t: TestApp,
  path: string,
  fields: Record<string, string | string[]>,
  as?: As,
): Promise<Response> {
  const body = new URLSearchParams();
  for (const [name, value] of Object.entries(fields)) {
    for (const v of ([] as string[]).concat(value)) body.append(name, v);
  }
  return t.request('POST', path, {
    as: as ?? null,
    body: body.toString(),
    headers: { 'content-type': 'application/x-www-form-urlencoded', origin: PUBLIC_URL },
  });
}

/** The page's HTML; fails loudly when the response is not a page. */
export async function html(res: Response): Promise<string> {
  const type = res.headers.get('content-type') ?? '';
  if (!type.startsWith('text/html')) throw new Error(`expected HTML, got ${res.status} ${type}: ${await res.text()}`);
  return res.text();
}

export function location(res: Response): string {
  return res.headers.get('location') ?? '';
}
