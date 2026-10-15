import type { LogLevel } from './config';

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export type LogFields = Record<string, unknown>;

export interface Logger {
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
}

/** JSON lines: `{"time":…,"level":"info","msg":…,…fields}`. */
export function createLogger(level: LogLevel, write: (line: string) => void = (line) => console.log(line)): Logger {
  const emit = (at: LogLevel, msg: string, fields: LogFields = {}) => {
    if (ORDER[at] < ORDER[level]) return;
    write(JSON.stringify({ time: new Date().toISOString(), level: at, msg, ...fields }));
  };
  return {
    debug: (msg, fields) => emit('debug', msg, fields),
    info: (msg, fields) => emit('info', msg, fields),
    warn: (msg, fields) => emit('warn', msg, fields),
    error: (msg, fields) => emit('error', msg, fields),
  };
}

export const silentLogger: Logger = createLogger('error', () => {});
