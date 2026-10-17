import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { VERSION } from '../version';

// Every request pixeltwin makes to an address an admin typed (a webhook, a GitHub API URL) goes
// through here. Only http(s), never with credentials in the URL, never following redirects, with
// a timeout. Link-local addresses (cloud metadata such as 169.254.169.254) are always refused;
// loopback and private networks only with OUTBOUND_BLOCK_PRIVATE=1, because a self-hosted
// pixeltwin often reports to a chat server or GitHub Enterprise on the same network. The address
// is checked when the request is made; a DNS answer that changes between the check and the
// connection (rebinding) is not caught.

export const USER_AGENT = `pixeltwin/${VERSION}`;

/** Why a URL cannot be used for outgoing requests; null when it can. */
export function outboundUrlProblem(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return 'Enter a full URL, e.g. https://example.com/hook';
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return 'Only http:// and https:// URLs can be used';
  if (url.username || url.password) return 'Leave the user name and password out of the URL';
  if (!url.hostname) return 'Enter a full URL, e.g. https://example.com/hook';
  return null;
}

function ipv4Parts(ip: string): number[] | null {
  const parts = ip.split('.').map(Number);
  return parts.length === 4 && parts.every((n) => Number.isInteger(n) && n >= 0 && n <= 255) ? parts : null;
}

/** `link-local`, `private` (loopback, RFC 1918, CGNAT, unique local, unspecified) or `public`. */
export function addressKind(ip: string): 'link-local' | 'private' | 'public' {
  const lower = ip.toLowerCase();
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower)?.[1];
  const v4 = ipv4Parts(mapped ?? lower);
  if (v4) {
    const [a = 0, b = 0] = v4;
    if (a === 169 && b === 254) return 'link-local';
    if (a === 0 || a === 10 || a === 127) return 'private';
    if (a === 172 && b >= 16 && b <= 31) return 'private';
    if (a === 192 && b === 168) return 'private';
    if (a === 100 && b >= 64 && b <= 127) return 'private';
    return 'public';
  }
  if (lower === 'fd00:ec2::254') return 'link-local';
  if (/^fe[89ab]/.test(lower)) return 'link-local';
  if (lower === '::1' || lower === '::' || /^f[cd]/.test(lower)) return 'private';
  return 'public';
}

/** Why the URL's host may not be contacted; null when it may. Resolves the name. */
export async function addressProblem(url: URL, blockPrivate: boolean): Promise<string | null> {
  const host = url.hostname.replace(/^\[|\]$/g, '');
  let addresses: string[];
  if (isIP(host)) addresses = [host];
  else {
    try {
      addresses = (await lookup(host, { all: true })).map((a) => a.address);
    } catch {
      return `cannot resolve ${host}`;
    }
  }
  for (const address of addresses) {
    const kind = addressKind(address);
    if (kind === 'link-local') return `${host} is a link-local address, which pixeltwin never contacts`;
    if (kind === 'private' && blockPrivate) {
      return `${host} is a private or loopback address and OUTBOUND_BLOCK_PRIVATE is on`;
    }
  }
  return null;
}

export interface OutboundOptions {
  blockPrivate: boolean;
  timeoutMs: number;
  fetch?: typeof fetch;
}

export class OutboundError extends Error {
  /** A timeout or a network failure: worth another attempt. */
  readonly retryable: boolean;

  constructor(message: string, retryable: boolean) {
    super(message);
    this.name = 'OutboundError';
    this.retryable = retryable;
  }
}

/**
 * One request to an admin-entered URL: checked, with a timeout, without following redirects. The
 * response body is the caller's to read or cancel.
 */
export async function outboundFetch(raw: string, init: RequestInit, options: OutboundOptions): Promise<Response> {
  const problem = outboundUrlProblem(raw);
  if (problem) throw new OutboundError(problem, false);
  const url = new URL(raw);
  const refused = await addressProblem(url, options.blockPrivate);
  if (refused) throw new OutboundError(refused, false);
  const headers = new Headers(init.headers);
  headers.set('user-agent', USER_AGENT);
  try {
    return await (options.fetch ?? fetch)(url, {
      ...init,
      headers,
      redirect: 'manual',
      signal: AbortSignal.timeout(options.timeoutMs),
    });
  } catch (err) {
    const name = (err as { name?: string }).name;
    if (name === 'TimeoutError' || name === 'AbortError') {
      throw new OutboundError(`timed out after ${options.timeoutMs} ms`, true);
    }
    throw new OutboundError(`could not connect to ${url.host}`, true);
  }
}
