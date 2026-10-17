import { readFileSync } from 'node:fs';
import { cpus } from 'node:os';
import { join, resolve } from 'node:path';
import { z } from 'zod';

const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;

const envSchema = z.object({
  PORT: z.coerce.number().int().min(0).max(65_535).default(8080),
  PUBLIC_URL: z.url({ protocol: /^https?$/ }).optional(),
  LOG_LEVEL: z.enum(LOG_LEVELS).default('info'),
  DATA_DIR: z.string().default('./data'),
  DATABASE_URL: z
    .string()
    .regex(/^postgres(ql)?:\/\//, 'must start with postgres:// or postgresql://')
    .optional(),
  DIFF_WORKERS: z.coerce.number().int().min(1).max(64).optional(),
  DIFF_TIMEOUT_MS: z.coerce.number().int().min(100).default(30_000),
  DIFF_QUEUE_MAX: z.coerce.number().int().min(0).optional(),
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(500).default(20),
  SHUTDOWN_GRACE_MS: z.coerce.number().int().min(0).default(20_000),
  STORAGE: z.enum(['local', 'postgres']).default('local'),
  SETUP_TOKEN: z.string().min(16, 'must be at least 16 characters').optional(),
  SECRET_KEY: z.string().min(32, 'must be at least 32 characters').optional(),
  OUTBOUND_BLOCK_PRIVATE: z
    .enum(['1', 'true', 'yes', 'on', '0', 'false', 'no', 'off'])
    .transform((value) => ['1', 'true', 'yes', 'on'].includes(value))
    .default(false),
  MAX_IMAGE_BYTES: z.coerce
    .number()
    .int()
    .min(1024)
    .default(10 * 1024 * 1024),
  MAX_IMAGE_PIXELS: z.coerce.number().int().min(1).default(40_000_000),
  SMTP_URL: z.url({ protocol: /^smtps?$/ }).optional(),
  SMTP_FROM: z.string().min(3).optional(),
  METRICS: z
    .enum(['1', 'true', 'yes', 'on', '0', 'false', 'no', 'off'])
    .transform((value) => ['1', 'true', 'yes', 'on'].includes(value))
    .default(false),
  METRICS_PORT: z.coerce.number().int().min(0).max(65_535).default(9464),
});

export type LogLevel = (typeof LOG_LEVELS)[number];

export interface Config {
  port: number;
  /** Origin plus optional path prefix, without a trailing slash, e.g. `https://pixeltwin.example.com`. */
  publicUrl: string;
  logLevel: LogLevel;
  dataDir: string;
  /** `postgres://…` or `sqlite:<path>`. */
  databaseUrl: string;
  diffWorkers: number;
  diffTimeoutMs: number;
  /** Uploads get 503 + Retry-After while this many diffs wait for a worker; 0 never refuses. */
  diffQueueMax: number;
  /** Connections in the Postgres pool (ignored for SQLite). */
  databasePoolMax: number;
  /** On SIGTERM, how long requests in flight may finish before the rest are cut off. */
  shutdownGraceMs: number;
  /** Where image bytes live: files under DATA_DIR, or the Postgres database (no shared disk needed). */
  storage: 'local' | 'postgres';
  /** The first-run setup token, fixed (e.g. from a Kubernetes Secret); null makes a random one. */
  setupToken: string | null;
  /** Encrypts the secrets integrations keep (GitHub token, webhook secrets); null stores them as they are. */
  secretKey: string | null;
  /** Webhooks and GitHub calls refuse loopback and private addresses too (link-local always is). */
  outboundBlockPrivate: boolean;
  maxImageBytes: number;
  maxImagePixels: number;
  /** `smtp://user:pass@host:587` (STARTTLS) or `smtps://…:465`; null sends no mail. */
  smtpUrl: string | null;
  /** The From of mails, e.g. `pixeltwin <pixeltwin@example.com>`. */
  smtpFrom: string | null;
  /** METRICS=1: Prometheus metrics at GET /metrics on `metricsPort`, a port of its own; null when off. */
  metricsPort: number | null;
}

/**
 * The CPU limit of this container from cgroup files (v2 `cpu.max`, or v1 quota and period),
 * rounded up; null when unlimited or unknown. `files` maps a file name to its content.
 */
export function cpuLimitFrom(files: Record<string, string | undefined>): number | null {
  const max = files['cpu.max']?.trim().split(/\s+/);
  if (max && max[0] !== 'max') {
    const quota = Number(max[0]);
    const period = Number(max[1] ?? 100_000);
    return quota > 0 && period > 0 ? Math.ceil(quota / period) : null;
  }
  const quota = Number(files['cpu.cfs_quota_us']);
  const period = Number(files['cpu.cfs_period_us']);
  return quota > 0 && period > 0 ? Math.ceil(quota / period) : null;
}

function readCgroupCpuLimit(): number | null {
  const read = (path: string) => {
    try {
      return readFileSync(path, 'utf8');
    } catch {
      return undefined;
    }
  };
  return cpuLimitFrom({
    'cpu.max': read('/sys/fs/cgroup/cpu.max'),
    'cpu.cfs_quota_us': read('/sys/fs/cgroup/cpu/cpu.cfs_quota_us'),
    'cpu.cfs_period_us': read('/sys/fs/cgroup/cpu/cpu.cfs_period_us'),
  });
}

export class ConfigError extends Error {
  readonly problems: string[];

  constructor(problems: string[]) {
    super(`Invalid configuration:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
    this.name = 'ConfigError';
    this.problems = problems;
  }
}

/** Parses configuration from environment variables. Empty values count as unset. */
export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const present = Object.fromEntries(Object.entries(env).filter(([, value]) => value !== undefined && value !== ''));
  const parsed = envSchema.safeParse(present);
  if (!parsed.success) {
    throw new ConfigError(parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`));
  }
  const e = parsed.data;
  if (e.SMTP_URL && !e.SMTP_FROM) throw new ConfigError(['SMTP_URL needs SMTP_FROM (the From of the mails)']);
  if (e.METRICS && e.METRICS_PORT !== 0 && e.METRICS_PORT === e.PORT) {
    throw new ConfigError(['METRICS_PORT must differ from PORT (metrics are kept off the public port)']);
  }
  const dataDir = resolve(e.DATA_DIR);
  if (e.STORAGE === 'postgres' && !e.DATABASE_URL) {
    throw new ConfigError(['STORAGE=postgres needs DATABASE_URL=postgres://… (images are kept in that database)']);
  }
  // One core stays free for the main thread, which parses every request and runs every query.
  // In a container the CPU limit counts, not the machine's cores.
  const available = Math.min(cpus().length, readCgroupCpuLimit() ?? Number.POSITIVE_INFINITY);
  const diffWorkers = e.DIFF_WORKERS ?? Math.max(1, available - 1);
  return {
    port: e.PORT,
    publicUrl: (e.PUBLIC_URL ?? `http://localhost:${e.PORT}`).replace(/\/+$/, ''),
    logLevel: e.LOG_LEVEL,
    dataDir,
    databaseUrl: e.DATABASE_URL ?? `sqlite:${join(dataDir, 'pixeltwin.db')}`,
    diffWorkers,
    diffTimeoutMs: e.DIFF_TIMEOUT_MS,
    diffQueueMax: e.DIFF_QUEUE_MAX ?? diffWorkers * 20,
    databasePoolMax: e.DATABASE_POOL_MAX,
    shutdownGraceMs: e.SHUTDOWN_GRACE_MS,
    storage: e.STORAGE,
    setupToken: e.SETUP_TOKEN ?? null,
    secretKey: e.SECRET_KEY ?? null,
    outboundBlockPrivate: e.OUTBOUND_BLOCK_PRIVATE,
    maxImageBytes: e.MAX_IMAGE_BYTES,
    maxImagePixels: e.MAX_IMAGE_PIXELS,
    smtpUrl: e.SMTP_URL ?? null,
    smtpFrom: e.SMTP_FROM ?? null,
    metricsPort: e.METRICS ? e.METRICS_PORT : null,
  };
}
