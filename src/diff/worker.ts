import { compareImages } from './compare';
import type { DiffJob, DiffJobResult } from './types';

declare var self: Worker;

self.onmessage = (event: MessageEvent<{ id: number; job: DiffJob }>) => {
  const { id, job } = event.data;
  let result: DiffJobResult;
  try {
    result = compareImages(job);
  } catch (err) {
    result = { kind: 'error', code: 'diff_failed', message: err instanceof Error ? err.message : String(err) };
  }
  const transfer = result.kind === 'compared' && result.diffPng ? [result.diffPng.buffer as ArrayBuffer] : [];
  self.postMessage({ id, result }, transfer);
};
