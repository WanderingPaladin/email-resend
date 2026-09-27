import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import log from 'electron-log/main';
import { LOG_BUFFER_LIMIT } from '../../shared/constants';
import type { LogCategory, LogEntry, LogLevel } from '../../shared/types';
import type { AppLogger, LogListener } from '../types/logger';
import { formatLogLine, formatLogMessage, parseLogLine } from './log-format';

const MAX_LOG_FILE_BYTES = 5 * 1024 * 1024;

/**
 * Application logger backed by electron-log.
 * - <userData>/logs/main.log     every entry
 * - <userData>/logs/campaign.log campaign entries only
 * Files rotate to *.old.log at 5 MB. Every message passes through redaction first, so secrets
 * never reach disk and email addresses are masked.
 */
export class LoggerService implements AppLogger {
  private readonly mainLog = log.create({ logId: 'main-file' });
  private readonly campaignLog = log.create({ logId: 'campaign-file' });
  private readonly listeners = new Set<LogListener>();
  private buffer: LogEntry[] = [];
  private sequence = 0;

  constructor(
    readonly logDirectory: string,
    private readonly options: { console: boolean },
  ) {
    this.configure(this.mainLog, 'main.log', options.console);
    this.configure(this.campaignLog, 'campaign.log', false);
  }

  private configure(instance: typeof log, fileName: string, console: boolean): void {
    instance.transports.file.resolvePathFn = () => join(this.logDirectory, fileName);
    instance.transports.file.format = '{text}';
    instance.transports.file.level = 'debug';
    instance.transports.file.maxSize = MAX_LOG_FILE_BYTES;
    instance.transports.console.level = console ? 'debug' : false;
    instance.transports.console.format = '{text}';
    // Do not forward logs to renderer processes: live logs go through our own typed IPC event.
    instance.transports.ipc.level = false;
  }

  get mainLogPath(): string {
    return join(this.logDirectory, 'main.log');
  }

  onLog(listener: LogListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  debug(category: LogCategory, message: string, fields?: Record<string, unknown>): void {
    this.write('debug', category, message, fields);
  }
  info(category: LogCategory, message: string, fields?: Record<string, unknown>): void {
    this.write('info', category, message, fields);
  }
  warn(category: LogCategory, message: string, fields?: Record<string, unknown>): void {
    this.write('warn', category, message, fields);
  }
  error(category: LogCategory, message: string, fields?: Record<string, unknown>): void {
    this.write('error', category, message, fields);
  }

  private write(level: LogLevel, category: LogCategory, message: string, fields?: Record<string, unknown>): void {
    const entry: LogEntry = {
      id: `live-${++this.sequence}`,
      timestamp: new Date().toISOString(),
      level,
      category,
      message: formatLogMessage(message, fields),
    };
    const line = formatLogLine(entry);
    try {
      this.mainLog[level](line);
      if (category === 'campaign') this.campaignLog[level](line);
    } catch {
      // A logging failure must never break the app.
    }
    this.buffer.push(entry);
    if (this.buffer.length > LOG_BUFFER_LIMIT) this.buffer = this.buffer.slice(-LOG_BUFFER_LIMIT);
    for (const listener of this.listeners) {
      try {
        listener(entry);
      } catch {
        // Ignore listener errors (e.g. a destroyed window).
      }
    }
  }

  /** Latest entries from disk (current + rotated file), newest last. Falls back to memory. */
  getLogs(limit = LOG_BUFFER_LIMIT): LogEntry[] {
    try {
      const lines: string[] = [];
      for (const file of [join(this.logDirectory, 'main.old.log'), this.mainLogPath]) {
        if (existsSync(file)) lines.push(...readFileSync(file, 'utf8').split('\n'));
      }
      const tail = lines.filter(Boolean).slice(-limit * 2);
      const entries = tail
        .map((line, i) => parseLogLine(line, `file-${i}`))
        .filter((e): e is LogEntry => e !== null);
      return entries.slice(-limit);
    } catch {
      return this.buffer.slice(-limit);
    }
  }

  clear(): void {
    for (const name of ['main.log', 'campaign.log']) {
      const file = join(this.logDirectory, name);
      if (existsSync(file)) writeFileSync(file, '');
      const old = join(this.logDirectory, name.replace('.log', '.old.log'));
      if (existsSync(old)) unlinkSync(old);
    }
    this.buffer = [];
    this.info('app', 'Logs cleared');
  }
}
