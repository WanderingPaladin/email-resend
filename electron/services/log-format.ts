import type { LogCategory, LogEntry, LogLevel } from '../../shared/types';

/**
 * Pure helpers for log formatting and redaction. No Electron imports so they can be unit tested.
 */

const LOG_CATEGORIES: readonly LogCategory[] = ['app', 'config', 'google', 'resend', 'campaign', 'ipc'];
const LOG_LEVELS: readonly LogLevel[] = ['debug', 'info', 'warn', 'error'];

/** `maria@example.com` → `ma***@example.com`. Anything that is not an email is returned masked entirely. */
export function maskEmail(email: string): string {
  const value = email.trim();
  const at = value.lastIndexOf('@');
  if (at <= 0) return value ? '***' : '';
  const local = value.slice(0, at);
  const domain = value.slice(at + 1);
  const visible = local.length <= 2 ? local.slice(0, 1) : local.slice(0, 2);
  return `${visible}***@${domain}`;
}

const EMAIL_PATTERN = /([A-Za-z0-9._%+-]+)@([A-Za-z0-9.-]+\.[A-Za-z]{2,})/g;
const PEM_PATTERN = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)/g;
// Resend keys start with `re_`. Match generously so partial keys are also hidden.
const RESEND_KEY_PATTERN = /\bre_[A-Za-z0-9_]{8,}\b/g;
const BEARER_PATTERN = /(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi;

const SECRET_KEY_NAMES = /^((resend|elastic_?email|mailjet)_?api_?key|(mailjet_?)?secret_?key|api_?key|private_?key|google_?private_?key|password|secret|token|authorization|access_?token|refresh_?token|client_?secret|credentials?)$/i;

/** Removes secrets (and optionally masks emails) from free text. */
export function redactText(text: string, options: { maskEmails?: boolean } = {}): string {
  let out = text
    .replace(PEM_PATTERN, '[REDACTED PRIVATE KEY]')
    .replace(RESEND_KEY_PATTERN, '[REDACTED API KEY]')
    .replace(BEARER_PATTERN, '$1[REDACTED]');
  if (options.maskEmails !== false) {
    out = out.replace(EMAIL_PATTERN, (match) => maskEmail(match));
  }
  return out;
}

/**
 * Deep-copies a value for logging, replacing secret-looking fields and redacting strings.
 * Handles cycles and bounds depth so a large object can never blow up the logger.
 */
export function sanitizeForLog(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return redactText(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'function' || typeof value === 'symbol') return undefined;
  if (value instanceof Error) {
    return { name: value.name, message: redactText(value.message) };
  }
  if (depth > 5) return '[Truncated]';
  if (typeof value === 'object') {
    if (seen.has(value)) return '[Circular]';
    seen.add(value);
    if (Array.isArray(value)) {
      return value.slice(0, 50).map((item) => sanitizeForLog(item, depth + 1, seen));
    }
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      if (SECRET_KEY_NAMES.test(key)) {
        out[key] = '[REDACTED]';
      } else {
        out[key] = sanitizeForLog(item, depth + 1, seen);
      }
    }
    return out;
  }
  return undefined;
}

/** Turns a message plus optional structured fields into one safe log line. */
export function formatLogMessage(message: string, fields?: Record<string, unknown>): string {
  let text = redactText(message);
  if (fields && Object.keys(fields).length > 0) {
    const safe = sanitizeForLog(fields) as Record<string, unknown>;
    const parts = Object.entries(safe)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => `${k}=${formatFieldValue(v)}`);
    if (parts.length) text += ` ${parts.join(' ')}`;
  }
  // One entry per line keeps the file parseable.
  return text.replace(/\r?\n/g, ' ⏎ ');
}

function formatFieldValue(value: unknown): string {
  if (typeof value === 'string') {
    return /[\s"=]/.test(value) || value === '' ? JSON.stringify(value) : value;
  }
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return String(value);
  return JSON.stringify(value);
}

/**
 * Line format written to disk:
 *   2026-09-27T14:30:01.123Z [info] [campaign] Campaign started campaignId=...
 */
export function formatLogLine(entry: Omit<LogEntry, 'id'>): string {
  return `${entry.timestamp} [${entry.level}] [${entry.category}] ${entry.message}`;
}

const LINE_PATTERN = /^(\S+) \[(debug|info|warn|error)\] \[([a-z]+)\] (.*)$/;

export function parseLogLine(line: string, id: string): LogEntry | null {
  const match = LINE_PATTERN.exec(line.trimEnd());
  if (!match) return null;
  const [, timestamp, level, category, message] = match;
  if (!LOG_LEVELS.includes(level as LogLevel)) return null;
  return {
    id,
    timestamp: timestamp ?? '',
    level: level as LogLevel,
    category: LOG_CATEGORIES.includes(category as LogCategory) ? (category as LogCategory) : 'app',
    message: message ?? '',
  };
}
