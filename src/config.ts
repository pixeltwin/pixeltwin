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
  MAX_IMAGE_BYTES: z.coerce
    .number()
    .int()
    .min(1024)
    .default(10 * 1024 * 1024),
  MAX_IMAGE_PIXELS: z.coerce.number().int().min(1).default(40_000_000),
});

export type LogLevel = (typeof LOG_LEVELS)[number];

export interface Config {
  port: number;
  /** Origin plus optional path prefix, without a trailing slash, e.g. `https://vrt.example.com`. */
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
  maxImageBytes: number;
  maxImagePixels: number;
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
  const dataDir = resolve(e.DATA_DIR);
  // One core stays free for the main thread, which parses every request and runs every query.
  const diffWorkers = e.DIFF_WORKERS ?? Math.max(1, cpus().length - 1);
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
    maxImageBytes: e.MAX_IMAGE_BYTES,
    maxImagePixels: e.MAX_IMAGE_PIXELS,
  };
}
