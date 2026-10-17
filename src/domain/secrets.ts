import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';
import { AppError } from '../errors';

// Secrets pixeltwin must send again later (a GitHub token, webhook signing secrets) cannot be
// hashed like project tokens. With SECRET_KEY set they are sealed with AES-256-GCM under a key
// derived from it; without it they are stored as they are (`plain:`), which the settings page says.
// Every replica needs the same SECRET_KEY. Changing it makes sealed secrets unreadable: enter them again.

const SEALED = 'v1:';
const PLAIN = 'plain:';

function unreadable(): AppError {
  return new AppError(
    'secret_unreadable',
    500,
    'A stored secret cannot be read: SECRET_KEY is missing or changed since it was saved. Enter the secret again.',
  );
}

export class SecretBox {
  readonly #key: Buffer | null;

  constructor(secretKey: string | null) {
    this.#key = secretKey
      ? Buffer.from(hkdfSync('sha256', secretKey, 'pixeltwin', 'integration secrets v1', 32))
      : null;
  }

  /** True when secrets are encrypted at rest (SECRET_KEY is set). */
  get encrypts(): boolean {
    return this.#key !== null;
  }

  seal(secret: string): string {
    if (!this.#key) return `${PLAIN}${secret}`;
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.#key, iv);
    const data = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final(), cipher.getAuthTag()]);
    return `${SEALED}${iv.toString('base64url')}:${data.toString('base64url')}`;
  }

  /** The secret; throws 500 `secret_unreadable` (never with the stored value) when it cannot be opened. */
  open(stored: string): string {
    if (stored.startsWith(PLAIN)) return stored.slice(PLAIN.length);
    if (!stored.startsWith(SEALED) || !this.#key) throw unreadable();
    const [iv, data] = stored.slice(SEALED.length).split(':');
    try {
      const bytes = Buffer.from(data ?? '', 'base64url');
      if (bytes.length < 17) throw unreadable();
      const decipher = createDecipheriv('aes-256-gcm', this.#key, Buffer.from(iv ?? '', 'base64url'));
      decipher.setAuthTag(bytes.subarray(bytes.length - 16));
      return Buffer.concat([decipher.update(bytes.subarray(0, bytes.length - 16)), decipher.final()]).toString('utf8');
    } catch {
      throw unreadable();
    }
  }
}

/** Used when no SECRET_KEY is configured (and by tests). */
export const PLAIN_SECRETS = new SecretBox(null);

export function hmacSha256Hex(secret: string, body: Uint8Array | string): string {
  return createHmac('sha256', secret).update(body).digest('hex');
}

/** Checks a `sha256=<hex>` signature header (GitHub's X-Hub-Signature-256) in constant time. */
export function signatureMatches(secret: string, body: Uint8Array, header: string | undefined): boolean {
  const hex = /^sha256=([0-9a-f]{64})$/.exec(header ?? '')?.[1];
  if (!hex) return false;
  const expected = Buffer.from(hmacSha256Hex(secret, body), 'hex');
  return timingSafeEqual(expected, Buffer.from(hex, 'hex'));
}
