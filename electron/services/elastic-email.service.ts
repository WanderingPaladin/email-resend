import type { MailerValidationResult } from '../../shared/types';
import type { AppLogger } from '../types/logger';
import { redactText } from './log-format';
import {
  BaseMailer,
  domainMatches,
  formatFrom,
  httpError,
  mailerError,
  networkError,
  readJson,
  REQUEST_TIMEOUT_MS,
  type AttemptResult,
  type FetchLike,
  type MailerError,
  type MailerOptions,
  type OutgoingEmail,
} from './mailer';

const API = 'https://api.elasticemail.com/v4';

/** 400 errors that mention these repeat for every recipient (sender, domain, account limits). */
const FATAL_MESSAGE = /\b(from|sender|domain|credit|balance|daily limit|monthly limit|account)\b/i;

function errorMessage(body: unknown): string {
  if (body && typeof body === 'object') {
    const b = body as { Error?: unknown; error?: unknown; raw?: unknown };
    const value = b.Error ?? b.error ?? b.raw;
    if (typeof value === 'string') return value;
  }
  return '';
}

export function classifyElasticEmailError(status: number, body: unknown): MailerError {
  const message = redactText(errorMessage(body), { maskEmails: false }).slice(0, 500);
  if (status === 400 && FATAL_MESSAGE.test(message)) {
    return mailerError('sender_or_account_error', `Elastic Email rejected the request: ${message}`, { fatal: true });
  }
  return httpError(status, message, 'Elastic Email');
}

/**
 * Elastic Email (elasticemail.com) v4 transactional API, authenticated with an API key header.
 * It has no idempotency key, so an ambiguous failure is never retried.
 */
export class ElasticEmailService extends BaseMailer {
  readonly providerLabel = 'Elastic Email';

  constructor(
    private readonly apiKey: string,
    logger: AppLogger,
    options: MailerOptions,
    private readonly fetchFn: FetchLike = fetch,
  ) {
    super(logger, options);
  }

  private request(path: string, init: RequestInit = {}): Promise<Response> {
    return this.fetchFn(`${API}${path}`, {
      ...init,
      headers: { 'X-ElasticEmail-ApiKey': this.apiKey, 'Content-Type': 'application/json', Accept: 'application/json' },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  }

  protected async attempt(email: OutgoingEmail): Promise<AttemptResult> {
    const payload = {
      Recipients: { To: [email.to] },
      Content: {
        From: formatFrom(email.fromName, email.fromEmail),
        Subject: email.subject,
        Body: [
          { ContentType: 'HTML', Content: email.html, Charset: 'utf-8' },
          { ContentType: 'PlainText', Content: email.text, Charset: 'utf-8' },
        ],
      },
    };
    let response: Response;
    try {
      response = await this.request('/emails/transactional', { method: 'POST', body: JSON.stringify(payload) });
    } catch (thrown) {
      return { ok: false, error: networkError(thrown, this.providerLabel) };
    }
    const body = await readJson(response);
    if (response.ok) {
      const b = (body ?? {}) as { MessageID?: unknown; TransactionID?: unknown };
      const id = typeof b.MessageID === 'string' && b.MessageID ? b.MessageID : typeof b.TransactionID === 'string' ? b.TransactionID : '';
      if (id) return { ok: true, id };
      return { ok: false, error: mailerError('unknown_error', 'Elastic Email returned no message ID', { ambiguous: true }) };
    }
    return { ok: false, error: classifyElasticEmailError(response.status, body) };
  }

  /** Lists the account's sending domains, which proves the key works without sending anything. */
  async validateConfiguration(fromEmail: string): Promise<MailerValidationResult> {
    let response: Response;
    try {
      response = await this.request('/domains', { method: 'GET' });
    } catch (thrown) {
      throw new Error(networkError(thrown, this.providerLabel).message);
    }
    const body = await readJson(response);
    if (response.status === 403) {
      return {
        status: 'restricted',
        message: 'The API key is accepted but cannot list domains. Use Send Test Email to verify delivery.',
        verifiedDomains: [],
        fromDomainVerified: null,
      };
    }
    if (!response.ok) throw new Error(classifyElasticEmailError(response.status, body).message);
    const domains = Array.isArray(body) ? (body as { Domain?: unknown; Spf?: unknown; Dkim?: unknown }[]) : [];
    const verified = domains
      .filter((d) => typeof d.Domain === 'string' && d.Spf === true && d.Dkim === true)
      .map((d) => String(d.Domain).toLowerCase());
    const fromDomain = fromEmail.split('@')[1]?.toLowerCase() ?? '';
    const fromDomainVerified = fromDomain ? verified.some((d) => domainMatches(fromEmail, d)) : null;
    let message = `API key is valid. Domains with SPF and DKIM verified: ${verified.join(', ') || 'none'}.`;
    if (fromDomainVerified === false) message += ` The From address domain "${fromDomain}" is not verified in Elastic Email.`;
    return { status: 'valid', message, verifiedDomains: verified, fromDomainVerified };
  }
}
