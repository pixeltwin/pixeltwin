import { describe, expect, test } from 'bun:test';
import { openDatabase } from '../../src/db/database';
import { Metrics, metricsHandler } from '../../src/http/metrics';

describe('metrics', () => {
  test('histograms count into every bucket at or above the value', async () => {
    const metrics = new Metrics();
    metrics.request('GET', '/x', 200, 0.02);
    metrics.request('GET', '/x', 200, 3);
    const text = await metrics.render({ diffBacklog: () => 2, diffWorkers: 3 });
    expect(text).toContain('pixeltwin_http_request_duration_seconds_bucket{method="GET",route="/x",le="0.01"} 0');
    expect(text).toContain('pixeltwin_http_request_duration_seconds_bucket{method="GET",route="/x",le="0.025"} 1');
    expect(text).toContain('pixeltwin_http_request_duration_seconds_bucket{method="GET",route="/x",le="5"} 2');
    expect(text).toContain('pixeltwin_http_request_duration_seconds_bucket{method="GET",route="/x",le="+Inf"} 2');
    expect(text).toContain('pixeltwin_http_request_duration_seconds_sum{method="GET",route="/x"} 3.02');
    expect(text).toContain('pixeltwin_diff_queue_depth 2');
    // No database given: no outbox gauges.
    expect(text).not.toContain('pixeltwin_outbox_pending');
    expect(text.endsWith('\n')).toBe(true);
  });

  test('label values are escaped', async () => {
    const metrics = new Metrics();
    metrics.request('GET', 'a"b\\c\nd', 200, 0);
    expect(await metrics.render({ diffBacklog: () => 0, diffWorkers: 1 })).toContain('route="a\\"b\\\\c\\nd"');
  });

  test('an unreachable database is reported as a gauge, not a failed scrape', async () => {
    const handle = openDatabase('sqlite::memory:');
    await handle.close();
    const res = await metricsHandler(new Metrics(), { db: handle.db, diffBacklog: () => 0, diffWorkers: 1 })(
      new Request('http://x/metrics'),
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('pixeltwin_database_up 0');
  });

  test('only GET /metrics is served', async () => {
    const handler = metricsHandler(new Metrics(), { diffBacklog: () => 0, diffWorkers: 1 });
    expect((await handler(new Request('http://x/'))).status).toBe(404);
    expect((await handler(new Request('http://x/metrics', { method: 'POST' }))).status).toBe(405);
  });
});
