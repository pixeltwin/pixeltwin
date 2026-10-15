import type { Context } from 'hono';
import { getConnInfo } from 'hono/bun';

/** The connection's address. X-Forwarded-For is ignored on purpose: clients can forge it. */
export function clientIp(c: Context): string {
  try {
    return getConnInfo(c).remote.address ?? 'unknown';
  } catch {
    return 'unknown';
  }
}
