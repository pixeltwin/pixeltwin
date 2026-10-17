import type { Db } from '../db/database';

// Prometheus metrics (METRICS=1), served on their own port (METRICS_PORT) so the Ingress, which
// routes the Service's http port, never exposes them. Counters are per process: Prometheus sums
// the pods. The outbox gauges are read from the database at scrape time, so every pod reports the
// same cluster-wide backlog: take max(), not sum(), across pods.

/** Seconds; uploads wait for their diff, so the top buckets are long. */
const DURATION_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60];

type Labels = Record<string, string>;

function escapeLabel(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

function labelText(labels: Labels): string {
  const parts = Object.entries(labels).map(([k, v]) => `${k}="${escapeLabel(v)}"`);
  return parts.length > 0 ? `{${parts.join(',')}}` : '';
}

class Counter {
  readonly #values = new Map<string, { labels: Labels; value: number }>();

  constructor(
    readonly name: string,
    readonly help: string,
  ) {}

  inc(labels: Labels = {}, by = 1): void {
    const key = labelText(labels);
    const entry = this.#values.get(key);
    if (entry) entry.value += by;
    else this.#values.set(key, { labels, value: by });
  }

  render(): string[] {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} counter`];
    for (const { labels, value } of this.#values.values()) lines.push(`${this.name}${labelText(labels)} ${value}`);
    return lines;
  }
}

class Histogram {
  readonly #series = new Map<string, { labels: Labels; buckets: number[]; sum: number; count: number }>();

  constructor(
    readonly name: string,
    readonly help: string,
    readonly bounds: number[],
  ) {}

  observe(labels: Labels, value: number): void {
    const key = labelText(labels);
    let series = this.#series.get(key);
    if (!series) {
      series = { labels, buckets: this.bounds.map(() => 0), sum: 0, count: 0 };
      this.#series.set(key, series);
    }
    for (let i = 0; i < this.bounds.length; i++) if (value <= (this.bounds[i] as number)) series.buckets[i]++;
    series.sum += value;
    series.count++;
  }

  render(): string[] {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} histogram`];
    for (const { labels, buckets, sum, count } of this.#series.values()) {
      this.bounds.forEach((bound, i) => {
        lines.push(`${this.name}_bucket${labelText({ ...labels, le: String(bound) })} ${buckets[i]}`);
      });
      lines.push(`${this.name}_bucket${labelText({ ...labels, le: '+Inf' })} ${count}`);
      lines.push(`${this.name}_sum${labelText(labels)} ${sum}`);
      lines.push(`${this.name}_count${labelText(labels)} ${count}`);
    }
    return lines;
  }
}

function gauge(name: string, help: string, samples: Array<[Labels, number]>): string[] {
  return [
    `# HELP ${name} ${help}`,
    `# TYPE ${name} gauge`,
    ...samples.map(([labels, value]) => `${name}${labelText(labels)} ${value}`),
  ];
}

export interface MetricsSources {
  /** The database the outbox gauges are read from; omitted, they are left out. */
  db?: Db;
  /** Diffs and thumbnails waiting for a worker. */
  diffBacklog: () => number;
  diffWorkers: number;
}

/** Counts rows the outboxes still have to send (webhooks, code host syncs, mail). */
async function outboxBacklog(db: Db): Promise<Array<[Labels, number]>> {
  const count = async (query: Promise<{ n: number | string | bigint } | undefined>) => Number((await query)?.n ?? 0);
  const [webhooks, codeHost, mail] = await Promise.all([
    count(
      db
        .selectFrom('webhookDeliveries')
        .select((eb) => eb.fn.countAll<number>().as('n'))
        .where('state', '=', 'pending')
        .executeTakeFirst(),
    ),
    count(
      db
        .selectFrom('integrationSyncs')
        .select((eb) => eb.fn.countAll<number>().as('n'))
        .whereRef('requested', '>', 'done')
        .executeTakeFirst(),
    ),
    count(
      db
        .selectFrom('mailOutbox')
        .select((eb) => eb.fn.countAll<number>().as('n'))
        .where('state', '=', 'pending')
        .executeTakeFirst(),
    ),
  ]);
  return [
    [{ outbox: 'webhooks' }, webhooks],
    [{ outbox: 'code_host' }, codeHost],
    [{ outbox: 'mail' }, mail],
  ];
}

export class Metrics {
  readonly #requests = new Counter('pixeltwin_http_requests_total', 'HTTP requests by method, route and status.');
  readonly #duration = new Histogram(
    'pixeltwin_http_request_duration_seconds',
    'HTTP request duration by method and route, including the wait for the diff on uploads.',
    DURATION_BUCKETS,
  );
  readonly #checks = new Counter('pixeltwin_checks_total', 'Checks posted, by result.');
  readonly #builds = new Counter('pixeltwin_builds_finalized_total', 'Builds finalized, by verdict.');

  /** `route` is the route pattern (`/api/v1/builds/:id/checks`), never the raw path. */
  request(method: string, route: string, status: number, seconds: number): void {
    this.#requests.inc({ method, route, status: String(status) });
    this.#duration.observe({ method, route }, seconds);
  }

  checkPosted(result: string): void {
    this.#checks.inc({ result });
  }

  buildFinalized(verdict: string): void {
    this.#builds.inc({ verdict });
  }

  /** The Prometheus text exposition format (version 0.0.4). */
  async render(sources: MetricsSources): Promise<string> {
    const lines = [
      ...this.#requests.render(),
      ...this.#duration.render(),
      ...this.#checks.render(),
      ...this.#builds.render(),
      ...gauge('pixeltwin_diff_queue_depth', 'Diffs and thumbnails waiting for a free diff worker.', [
        [{}, sources.diffBacklog()],
      ]),
      ...gauge('pixeltwin_diff_workers', 'Diff worker threads in this process.', [[{}, sources.diffWorkers]]),
    ];
    if (sources.db) {
      let backlog: Array<[Labels, number]> = [];
      let marks = 0;
      let up = 1;
      try {
        backlog = await outboxBacklog(sources.db);
        const row = await sources.db
          .selectFrom('insightMarks')
          .select((eb) => eb.fn.countAll<number>().as('n'))
          .executeTakeFirst();
        marks = Number(row?.n ?? 0);
      } catch {
        up = 0;
      }
      lines.push(
        ...gauge(
          'pixeltwin_outbox_pending',
          'Rows waiting to be sent, across all replicas (the same on every pod: use max, not sum).',
          backlog,
        ),
        ...gauge(
          'pixeltwin_insight_marks_pending',
          'Days of Insights marked out of date and not yet recomputed, across all replicas (use max).',
          [[{}, marks]],
        ),
        ...gauge('pixeltwin_database_up', '1 when the last scrape could query the database.', [[{}, up]]),
      );
    }
    return `${lines.join('\n')}\n`;
  }
}

/** The metrics endpoint: GET /metrics, nothing else. */
export function metricsHandler(metrics: Metrics, sources: MetricsSources): (req: Request) => Promise<Response> {
  return async (req) => {
    const { pathname } = new URL(req.url);
    if (pathname !== '/metrics') return new Response('Not found\n', { status: 404 });
    if (req.method !== 'GET' && req.method !== 'HEAD') return new Response('Method not allowed\n', { status: 405 });
    return new Response(await metrics.render(sources), {
      headers: { 'content-type': 'text/plain; version=0.0.4; charset=utf-8' },
    });
  };
}
