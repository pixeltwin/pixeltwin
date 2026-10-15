import type { FieldError } from '../errors';

/** `build_finalized` → `Build finalized`. */
export function titleFor(code: string): string {
  const words = code.replace(/_/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** RFC 9457 problem response (spec §4.1). */
export function problemResponse(
  status: number,
  code: string,
  detail: string,
  requestId: string,
  errors?: FieldError[],
): Response {
  const body = {
    type: 'about:blank',
    title: titleFor(code),
    status,
    code,
    detail,
    requestId,
    ...(errors ? { errors } : {}),
  };
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/problem+json', 'x-request-id': requestId },
  });
}
