// Test double for DiffPool: hangs or crashes depending on the job's colorThreshold.
declare var self: Worker;

self.onmessage = (event: MessageEvent<{ id: number; job: { colorThreshold: number } }>) => {
  const { id, job } = event.data;
  if (job.colorThreshold === 0.5) while (true) {}
  if (job.colorThreshold === 0.9) throw new Error('worker exploded');
  self.postMessage({ id, result: { kind: 'validated', width: 1, height: 1 } });
};
