import type { MailerValidationResult } from '../../shared/types';
import type { AppLogger } from '../types/logger';
import { maskEmail } from './log-format';
import { sleep } from './retry';

/**
 * Provider-neutral sending layer. Resend, Elastic Email and Mailjet each implement one
 * `attempt`; throttling, retries and the SendResult shape are shared here, so the campaign
 * code does not care which provider is selected.
 */

export interface OutgoingEmail {
  fromName: string;
  fromEmail: string;
  to: string;
  subject: string;
  html: string;
  text: string;
  /**
   * Stable key for this send (campaignId:row). Providers that support idempotency use it so a
   * retried request cannot produce a second email; others ignore it.
   */
  idempotencyKey?: string;
}

export type SendResult =
  | { success: true; id: string }
  | {
      success: false;
      error: string;
      code: string;
      /** The provider may have accepted the email; never resend automatically. */
      ambiguous: boolean;
      /** Every following send would fail the same way (bad key, quota, sender not allowed). */
      fatal: boolean;
    };

/** A classified provider error. Messages are sanitized and never contain credentials. */
export interface MailerError {
  code: string;
  message: string;
  /** Rejected before sending (rate limit): safe to retry after a pause. */
  retryable: boolean;
  /** The request may have been accepted (timeout, 5xx, dropped connection). */
  ambiguous: boolean;
  fatal: boolean;
}

export type AttemptResult = { ok: true; id: string } | { ok: false; error: MailerError };

/** What the campaign code needs from a provider. */
export interface Mailer {
  readonly providerLabel: string;
  sendEmail(email: OutgoingEmail): Promise<SendResult>;
  /** Checks the credentials without sending an email. Throws a user-facing error when they are rejected. */
  validateConfiguration(fromEmail: string): Promise<MailerValidationResult>;
}

export interface MailerOptions {
  sendsPerSecond: number;
  maxAttempts?: number;
  sleepFn?: (ms: number) => Promise<void>;
  now?: () => number;
}

export function mailerError(code: string, message: string, kind: Partial<Pick<MailerError, 'retryable' | 'ambiguous' | 'fatal'>> = {}): MailerError {
  return { code, message, retryable: false, ambiguous: false, fatal: false, ...kind };
}

/** A thrown fetch/network error: the request may or may not have reached the provider. */
export function networkError(thrown: unknown, providerLabel: string): MailerError {
  const detail = thrown instanceof Error ? thrown.message : String(thrown);
  return mailerError('network_error', `Could not reach ${providerLabel} (${detail})`, { ambiguous: true });
}

/**
 * Throttles request starts to `sendsPerSecond`, retries only when a retry cannot cause a
 * duplicate (rate limits; ambiguous errors only with provider-side idempotency) and turns
 * each provider's answer into a SendResult.
 */
export abstract class BaseMailer implements Mailer {
  abstract readonly providerLabel: string;
  /** True when the provider deduplicates requests carrying the same idempotency key. */
  protected readonly supportsIdempotency: boolean = false;

  private nextSlot = 0;
  private readonly sleepFn: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly intervalMs: number;

  constructor(
    protected readonly logger: AppLogger,
    private readonly options: MailerOptions,
  ) {
    this.sleepFn = options.sleepFn ?? sleep;
    this.now = options.now ?? Date.now;
    this.intervalMs = Math.ceil(1000 / Math.max(1, options.sendsPerSecond));
  }

  protected abstract attempt(email: OutgoingEmail): Promise<AttemptResult>;
  abstract validateConfiguration(fromEmail: string): Promise<MailerValidationResult>;

  /** Serializes request start times so at most `sendsPerSecond` requests start per second. */
  private async throttle(): Promise<void> {
    const now = this.now();
    const slot = Math.max(now, this.nextSlot);
    this.nextSlot = slot + this.intervalMs;
    if (slot > now) await this.sleepFn(slot - now);
  }

  async sendEmail(email: OutgoingEmail): Promise<SendResult> {
    const maxAttempts = this.options.maxAttempts ?? 4;
    const idempotent = this.supportsIdempotency && Boolean(email.idempotencyKey);
    let last: MailerError | null = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      await this.throttle();
      let result: AttemptResult;
      try {
        result = await this.attempt(email);
      } catch (thrown) {
        result = { ok: false, error: networkError(thrown, this.providerLabel) };
      }
      if (result.ok) return { success: true, id: result.id };
      last = result.error;

      // Ambiguous failures are only retried with provider-side idempotency, which makes the retry safe.
      const canRetry = last.retryable || (last.ambiguous && idempotent);
      if (!canRetry || attempt === maxAttempts) break;
      const delay = last.code === 'rate_limit_exceeded' ? 1000 * attempt : 500 * 2 ** attempt;
      this.logger.warn('resend', `${this.providerLabel} request failed; retrying`, {
        email: maskEmail(email.to),
        code: last.code,
        attempt,
        delayMs: delay,
      });
      await this.sleepFn(delay);
    }

    const error = last ?? mailerError('unknown_error', `Unknown ${this.providerLabel} error`, { ambiguous: true });
    return { success: false, error: error.message, code: error.code, ambiguous: error.ambiguous, fatal: error.fatal };
  }
}

/** True when `email`'s domain equals `domain` or is a subdomain of it. */
/**
 * The bare domain from a provider's domain label. Elastic Email can return labels such as
 * "example.com (hi@example.com)", which must not be compared as a whole.
 */
export function normalizeDomain(label: string): string {
  const head = label.split('(')[0] ?? '';
  const host = head.includes('@') ? head.slice(head.lastIndexOf('@') + 1) : head;
  return host.trim().replace(/\.$/, '').toLowerCase();
}

export function domainMatches(email: string, domain: string): boolean {
  const from = email.trim().split('@')[1]?.trim().replace(/\.$/, '').toLowerCase() ?? '';
  const d = normalizeDomain(domain);
  return Boolean(from) && (from === d || from.endsWith(`.${d}`));
}

/** Builds a From header. Quotes and angle brackets are stripped from the display name. */
export function formatFrom(fromName: string, fromEmail: string): string {
  const name = cleanDisplayName(fromName);
  return name ? `${name} <${fromEmail.trim()}>` : fromEmail.trim();
}

export function cleanDisplayName(fromName: string): string {
  return fromName.replace(/["<>\r\n]/g, '').trim();
}

export type FetchLike = typeof fetch;

/** Timeout per provider request. A timed-out send is treated as ambiguous (it may have been accepted). */
export const REQUEST_TIMEOUT_MS = 30_000;

/** Reads a JSON body without throwing; returns null for empty or non-JSON bodies. */
export async function readJson(response: Response): Promise<unknown> {
  const text = await response.text().catch(() => '');
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { raw: text.slice(0, 300) };
  }
}

/** Classifies an HTTP failure that carries no provider-specific detail. */
export function httpError(status: number, message: string, providerLabel: string): MailerError {
  if (status === 401) return mailerError('invalid_api_key', `${providerLabel} rejected the API key. Check it in Settings. (${message})`, { fatal: true });
  if (status === 403) return mailerError('forbidden', `${providerLabel} refused the request: ${message}`, { fatal: true });
  if (status === 429) return mailerError('rate_limit_exceeded', `${providerLabel} rate limit reached.`, { retryable: true });
  if (status >= 500) return mailerError('server_error', `${providerLabel} server error (${status}): ${message}`, { ambiguous: true });
  return mailerError('validation_error', message || `${providerLabel} rejected the email (HTTP ${status})`);
}
