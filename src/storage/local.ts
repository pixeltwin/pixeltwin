import { randomUUID } from 'node:crypto';
import { access, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, resolve, sep } from 'node:path';
import type { Storage } from './storage';

/** Stores objects as files under `rootDir`. Writes are atomic (temp file + rename). */
export class LocalStorage implements Storage {
  readonly #root: string;

  constructor(rootDir: string) {
    this.#root = resolve(rootDir);
  }

  async put(key: string, data: Uint8Array): Promise<void> {
    const path = this.#pathFor(key);
    await mkdir(dirname(path), { recursive: true });
    const temp = `${path}.${randomUUID()}.tmp`;
    await writeFile(temp, data);
    await rename(temp, path);
  }

  async get(key: string): Promise<Uint8Array | null> {
    try {
      return new Uint8Array(await readFile(this.#pathFor(key)));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  }

  async exists(key: string): Promise<boolean> {
    try {
      await access(this.#pathFor(key));
      return true;
    } catch {
      return false;
    }
  }

  async delete(key: string): Promise<void> {
    await rm(this.#pathFor(key), { force: true });
  }

  /** Writes and removes a probe file: a full or read-only disk fails here, not on the next upload. */
  async check(): Promise<void> {
    await mkdir(this.#root, { recursive: true });
    const probe = resolve(this.#root, `.healthz-${randomUUID()}`);
    await writeFile(probe, 'ok');
    await rm(probe, { force: true });
  }

  #pathFor(key: string): string {
    const path = resolve(this.#root, key);
    if (isAbsolute(key) || key.split(/[\\/]/).includes('..') || !path.startsWith(this.#root + sep)) {
      throw new Error(`Invalid storage key: ${key}`);
    }
    return path;
  }
}
