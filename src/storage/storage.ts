export interface Storage {
  put(key: string, data: Uint8Array): Promise<void>;
  /** Returns null when the key does not exist. */
  get(key: string): Promise<Uint8Array | null>;
  exists(key: string): Promise<boolean>;
  /** Deleting a missing key is not an error. */
  delete(key: string): Promise<void>;
  /** Throws when the storage cannot be written to (for /healthz). */
  check(): Promise<void>;
}

const SHA256_HEX = /^[0-9a-f]{64}$/;

/** Storage key for a content-addressed PNG: `images/ab/cd/abcd….png`. */
export function imageKey(sha: string): string {
  if (!SHA256_HEX.test(sha)) throw new Error(`Invalid image sha: ${sha}`);
  return `images/${sha.slice(0, 2)}/${sha.slice(2, 4)}/${sha}.png`;
}
