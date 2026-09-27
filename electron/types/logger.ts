import type { LogCategory, LogEntry } from '../../shared/types';

/**
 * Logger contract used by services. The Electron-backed implementation lives in
 * logger.service.ts; tests use an in-memory implementation.
 */
export interface AppLogger {
  debug(category: LogCategory, message: string, fields?: Record<string, unknown>): void;
  info(category: LogCategory, message: string, fields?: Record<string, unknown>): void;
  warn(category: LogCategory, message: string, fields?: Record<string, unknown>): void;
  error(category: LogCategory, message: string, fields?: Record<string, unknown>): void;
}

export type LogListener = (entry: LogEntry) => void;
