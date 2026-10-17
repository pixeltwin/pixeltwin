import { compareImages } from './compare';
import { makeThumb, type ThumbJob, type ThumbJobResult } from './thumb';
import type { DiffJob, DiffJobResult } from './types';

declare var self: Worker;

self.onmessage = (event: MessageEvent<{ id: number; job: DiffJob | ThumbJob }>) => {
  const { id, job } = event.data;
  let result: DiffJobResult | ThumbJobResult;
  try {
    result = 'thumb' in job ? makeThumb(job) : compareImages(job);
  } catch (err) {
    result = { kind: 'error', code: 'diff_failed', message: err instanceof Error ? err.message : String(err) };
  }
  const png = result.kind === 'compared' ? result.diffPng : result.kind === 'thumb' ? result.png : null;
  self.postMessage({ id, result }, png ? [png.buffer as ArrayBuffer] : []);
};
