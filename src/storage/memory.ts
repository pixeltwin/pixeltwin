import type { Storage } from './storage';

/** In-memory storage for tests. */
export class MemoryStorage implements Storage {
  readonly objects = new Map<string, Uint8Array>();
  puts = 0;

  async put(key: string, data: Uint8Array): Promise<void> {
    this.puts += 1;
    this.objects.set(key, new Uint8Array(data));
  }

  async get(key: string): Promise<Uint8Array | null> {
    const data = this.objects.get(key);
    return data ? new Uint8Array(data) : null;
  }

  async exists(key: string): Promise<boolean> {
    return this.objects.has(key);
  }

  async delete(key: string): Promise<void> {
    this.objects.delete(key);
  }

  async check(): Promise<void> {}
}
