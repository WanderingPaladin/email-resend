import { Resend } from 'resend';
import type { MailerValidationResult } from '../../shared/types';
import type { AppLogger } from '../types/logger';
import { redactText } from './log-format';
import { BaseMailer, formatFrom, type AttemptResult, type MailerError, type MailerOptions, type OutgoingEmail } from './mailer';

export type { OutgoingEmail, SendResult } from './mailer';

export interface ResendErrorLike {
  name?: string;
  message?: string;
  statusCode?: number | null;
}

/** The subset of the Resend SDK we use. Mocked in tests. */
export interface ResendClientLike {
  emails: {
    send(
      payload: { from: string; to: string; subject: string; html: string; text: string },
      options?: { idempotencyKey?: string },
    ): Promise<{ data: { id: string } | null; error: ResendErrorLike | null }>;
  };
  domains: {
    list(): Promise<{ data: { data: { name: string; status: string }[] } | null; error: ResendErrorLike | null }>;
  };
}

export function createResendClient(apiKey: string): ResendClientLike {
  return new Resend(apiKey) as unknown as ResendClientLike;
}

/** Errors meaning the request was rejected before sending and can be retried after a pause. */
const RETRYABLE_CODES = new Set(['rate_limit_exceeded', 'concurrent_idempotent_requests']);
/** Errors after which Resend may or may not have accepted the email. */
const AMBIGUOUS_CODES = new Set(['application_error', 'internal_server_error', 'network_error']);
/** Errors that will repeat for every recipient; the campaign should stop scheduling sends. */
const FATAL_CODES = new Set([
  'missing_api_key',
  'invalid_api_key',
  'restricted_api_key',
  'invalid_from_address',
  'daily_quota_exceeded',
  'monthly_quota_exceeded',
  'security_error',
  'invalid_access',
]);

export type NormalizedResendError = MailerError;

/** Turns an SDK error object or a thrown exception into a sanitized, classified error. */
export function normalizeResendError(error: unknown): NormalizedResendError {
  let code = 'unknown_error';
  let message = 'Unknown Resend error';
  if (error instanceof Error) {
    // A thrown exception (e.g. fetch failure) rather than an API error object: the request
    // may or may not have reached Resend.
    const known = RETRYABLE_CODES.has(error.name) || AMBIGUOUS_CODES.has(error.name) || FATAL_CODES.has(error.name);
    code = known ? error.name : 'network_error';
    message = error.message;
  } else if (error && typeof error === 'object' && typeof (error as ResendErrorLike).name === 'string') {
    const e = error as ResendErrorLike;
    code = e.name ?? code;
    message = e.message ?? message;
  } else if (typeof error === 'string') {
    message = error;
  }
  const friendly: Record<string, string> = {
    invalid_api_key: 'Resend rejected the API key. Check it in Settings.',
    missing_api_key: 'Resend API key is missing. Add it in Settings.',
    restricted_api_key: 'This Resend API key is not allowed to perform this action.',
    invalid_from_address: 'The From address is not allowed. Use an address on a domain verified in Resend.',
    rate_limit_exceeded: 'Resend rate limit reached.',
    daily_quota_exceeded: 'Resend daily sending quota exceeded.',
    monthly_quota_exceeded: 'Resend monthly sending quota exceeded.',
  };
  const text = redactText(friendly[code] ? `${friendly[code]} (${message})` : message, { maskEmails: false }).slice(0, 500);
  return {
    code,
    message: text,
    retryable: RETRYABLE_CODES.has(code),
    ambiguous: AMBIGUOUS_CODES.has(code) || code === 'unknown_error',
    fatal: FATAL_CODES.has(code),
  };
}

export type ResendServiceOptions = MailerOptions;

/** Resend (resend.com). Supports idempotency keys, so ambiguous failures can be retried safely. */
export class ResendService extends BaseMailer {
  readonly providerLabel = 'Resend';
  protected override readonly supportsIdempotency = true;

  constructor(
    private readonly client: ResendClientLike,
    logger: AppLogger,
    options: ResendServiceOptions,
  ) {
    super(logger, options);
  }

  protected async attempt(email: OutgoingEmail): Promise<AttemptResult> {
    let response: Awaited<ReturnType<ResendClientLike['emails']['send']>>;
    try {
      response = await this.client.emails.send(
        { from: formatFrom(email.fromName, email.fromEmail), to: email.to, subject: email.subject, html: email.html, text: email.text },
        email.idempotencyKey ? { idempotencyKey: email.idempotencyKey } : undefined,
      );
    } catch (thrown) {
      return { ok: false, error: normalizeResendError(thrown) };
    }
    const { data, error } = response;
    if (data?.id && !error) return { ok: true, id: data.id };
    return { ok: false, error: normalizeResendError(error ?? { name: 'unknown_error', message: 'Resend returned no email ID' }) };
  }

  /**
   * Checks the API key without sending an email by listing domains.
   * Sending-only keys cannot list domains; that still proves the key exists.
   */
  async validateConfiguration(fromEmail: string): Promise<MailerValidationResult> {
    let response: Awaited<ReturnType<ResendClientLike['domains']['list']>>;
    try {
      response = await this.client.domains.list();
    } catch (thrown) {
      throw new Error(normalizeResendError(thrown).message);
    }
    if (response.error) {
      const e = normalizeResendError(response.error);
      if (e.code === 'restricted_api_key') {
        return {
          status: 'restricted',
          message:
            'The API key is accepted but restricted to sending, so domains cannot be checked. Use Send Test Email to verify delivery.',
          verifiedDomains: [],
          fromDomainVerified: null,
        };
      }
      throw new Error(e.message);
    }
    const domains = response.data?.data ?? [];
    const verified = domains.filter((d) => d.status === 'verified').map((d) => d.name.toLowerCase());
    const fromDomain = fromEmail.split('@')[1]?.toLowerCase() ?? '';
    const fromDomainVerified = fromDomain ? verified.some((d) => fromDomain === d || fromDomain.endsWith(`.${d}`)) : null;
    let message = `API key is valid. Verified domains: ${verified.join(', ') || 'none'}.`;
    if (fromDomainVerified === false) message += ` The From address domain "${fromDomain}" is not verified.`;
    return { status: 'valid', message, verifiedDomains: verified, fromDomainVerified };
  }
}
