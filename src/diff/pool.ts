import type { DiffJob, DiffJobResult } from './types';

/**
 * Where the worker module lives. Inside a `bun build --compile` binary, modules sit under
 * `/$bunfs/` and the worker must be named by its bundle-root-relative entrypoint path;
 * the build passes `src/diff/worker.ts` as an extra entrypoint.
 */
export function defaultWorkerSpecifier(): string {
  return import.meta.url.includes('$bunfs') ? './diff/worker.ts' : new URL('./worker.ts', import.meta.url).href;
}

export interface DiffPoolOptions {
  size: number;
  timeoutMs: number;
  workerSpecifier?: string;
}

interface Job {
  id: number;
  job: DiffJob;
  resolve: (result: DiffJobResult) => void;
}

interface Slot {
  /** null after a crash or timeout; a new worker is spawned when the next job needs this slot. */
  worker: Worker | null;
  current: (Job & { timer: ReturnType<typeof setTimeout> }) | null;
}

const CLOSED: DiffJobResult = { kind: 'error', code: 'diff_failed', message: 'Diff pool is closed.' };

/**
 * Runs diff jobs on a fixed set of Bun workers. A job that exceeds `timeoutMs`, or whose
 * worker crashes, resolves to an error result and its worker is discarded. Replacements are
 * spawned only when a job is waiting, so a worker that cannot load fails each job quickly
 * instead of respawning in a loop. `run` never rejects.
 */
export class DiffPool {
  readonly #options: DiffPoolOptions;
  readonly #slots: Slot[] = [];
  readonly #queue: Job[] = [];
  #nextId = 1;
  #closed = false;

  constructor(options: DiffPoolOptions) {
    this.#options = options;
    for (let i = 0; i < options.size; i++) {
      const slot: Slot = { worker: null, current: null };
      slot.worker = this.#spawn(slot);
      this.#slots.push(slot);
    }
  }

  run = (job: DiffJob): Promise<DiffJobResult> =>
    new Promise((resolve) => {
      if (this.#closed) {
        resolve(CLOSED);
        return;
      }
      this.#queue.push({ id: this.#nextId++, job, resolve });
      this.#dispatch();
    });

  async close(): Promise<void> {
    this.#closed = true;
    for (const slot of this.#slots) {
      if (slot.current) {
        clearTimeout(slot.current.timer);
        slot.current.resolve(CLOSED);
      }
      slot.worker?.terminate();
    }
    this.#slots.length = 0;
    for (const queued of this.#queue.splice(0)) queued.resolve(CLOSED);
  }

  #spawn(slot: Slot): Worker {
    const worker = new Worker(this.#options.workerSpecifier ?? defaultWorkerSpecifier());
    worker.onmessage = (event: MessageEvent<{ id: number; result: DiffJobResult }>) => {
      if (slot.worker !== worker) return;
      const current = slot.current;
      if (!current || current.id !== event.data.id) return;
      clearTimeout(current.timer);
      slot.current = null;
      current.resolve(event.data.result);
      this.#dispatch();
    };
    worker.onerror = (event: ErrorEvent) => {
      event.preventDefault();
      if (slot.worker !== worker) return;
      // The raw message can contain source code and paths; keep the stored message generic.
      this.#discard(slot, { kind: 'error', code: 'diff_failed', message: 'Diff worker crashed.' });
    };
    return worker;
  }

  #discard(slot: Slot, result: DiffJobResult): void {
    const current = slot.current;
    slot.current = null;
    if (current) {
      clearTimeout(current.timer);
      current.resolve(result);
    }
    slot.worker?.terminate();
    slot.worker = null;
    if (!this.#closed) this.#dispatch();
  }

  #dispatch(): void {
    for (const slot of this.#slots) {
      if (slot.current) continue;
      const next = this.#queue.shift();
      if (!next) return;
      slot.worker ??= this.#spawn(slot);
      const timer = setTimeout(
        () =>
          this.#discard(slot, {
            kind: 'error',
            code: 'diff_timeout',
            message: `Diff took longer than ${this.#options.timeoutMs} ms.`,
          }),
        this.#options.timeoutMs,
      );
      slot.current = { ...next, timer };
      slot.worker.postMessage({ id: next.id, job: next.job });
    }
  }
}
