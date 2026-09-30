import type { MailerValidationResult } from '../../shared/types';
import type { AppLogger } from '../types/logger';
import { redactText } from './log-format';
import {
  BaseMailer,
  cleanDisplayName,
  domainMatches,
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

const API = 'https://api.mailjet.com';

interface MailjetError {
  ErrorCode?: string;
  ErrorMessage?: string;
  ErrorRelatedTo?: string[];
  StatusCode?: number;
}

interface MailjetSendResponse {
  Messages?: {
    Status?: string;
    To?: { Email?: string; MessageUUID?: string; MessageID?: number | string }[];
    Errors?: MailjetError[];
  }[];
  ErrorMessage?: string;
}

export function classifyMailjetError(status: number, body: unknown): MailerError {
  const b = (body ?? {}) as MailjetSendResponse & { raw?: string };
  const errors = b.Messages?.[0]?.Errors ?? [];
  const first = errors[0];
  const message = redactText(first?.ErrorMessage ?? b.ErrorMessage ?? b.raw ?? '', { maskEmails: false }).slice(0, 500);
  // Problems with the sender affect every recipient.
  const senderProblem = errors.some((e) => (e.ErrorRelatedTo ?? []).some((f) => /^from/i.test(f)));
  if (status === 400 && senderProblem) {
    return mailerError('invalid_from_address', `Mailjet rejected the sender: ${message}. Use an address or domain validated in Mailjet.`, {
      fatal: true,
    });
  }
  if (status === 401) {
    return mailerError('invalid_api_key', `Mailjet rejected the API key or secret key, or the sender is not allowed. (${message})`, {
      fatal: true,
    });
  }
  return httpError(status, message, 'Mailjet');
}

/**
 * Mailjet (mailjet.com) Send API v3.1, authenticated with API key + secret key (HTTP Basic).
 * It has no idempotency key, so an ambiguous failure is never retried.
 */
export class MailjetService extends BaseMailer {
  readonly providerLabel = 'Mailjet';

  constructor(
    private readonly apiKey: string,
    private readonly secretKey: string,
    logger: AppLogger,
    options: MailerOptions,
    private readonly fetchFn: FetchLike = fetch,
  ) {
    super(logger, options);
  }

  private request(path: string, init: RequestInit = {}): Promise<Response> {
    const auth = Buffer.from(`${this.apiKey}:${this.secretKey}`, 'utf8').toString('base64');
    return this.fetchFn(`${API}${path}`, {
      ...init,
      headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  }

  protected async attempt(email: OutgoingEmail): Promise<AttemptResult> {
    const name = cleanDisplayName(email.fromName);
    const payload = {
      Messages: [
        {
          From: { Email: email.fromEmail.trim(), ...(name ? { Name: name } : {}) },
          To: [{ Email: email.to }],
          Subject: email.subject,
          TextPart: email.text,
          HTMLPart: email.html,
          ...(email.idempotencyKey ? { CustomID: email.idempotencyKey.slice(0, 255) } : {}),
        },
      ],
    };
    let response: Response;
    try {
      response = await this.request('/v3.1/send', { method: 'POST', body: JSON.stringify(payload) });
    } catch (thrown) {
      return { ok: false, error: networkError(thrown, this.providerLabel) };
    }
    const body = (await readJson(response)) as MailjetSendResponse | null;
    const message = body?.Messages?.[0];
    if (response.ok && message?.Status === 'success') {
      const to = message.To?.[0];
      // MessageUUID is a string; MessageID can exceed JavaScript's safe integer range.
      const id = to?.MessageUUID || (to?.MessageID !== undefined ? String(to.MessageID) : '');
      if (id) return { ok: true, id };
      return { ok: false, error: mailerError('unknown_error', 'Mailjet returned no message ID', { ambiguous: true }) };
    }
    if (response.ok) {
      return { ok: false, error: mailerError('unknown_error', `Mailjet returned status "${message?.Status ?? 'unknown'}"`, { ambiguous: true }) };
    }
    return { ok: false, error: classifyMailjetError(response.status, body) };
  }

  /** Lists the account's senders, which proves the keys work without sending anything. */
  async validateConfiguration(fromEmail: string): Promise<MailerValidationResult> {
    let response: Response;
    try {
      response = await this.request('/v3/REST/sender?Limit=1000', { method: 'GET' });
    } catch (thrown) {
      throw new Error(networkError(thrown, this.providerLabel).message);
    }
    const body = await readJson(response);
    if (!response.ok) {
      if (response.status === 401) throw new Error('Mailjet rejected the API key or secret key. Check both in Settings.');
      throw new Error(classifyMailjetError(response.status, body).message);
    }
    const senders = ((body as { Data?: { Email?: unknown; Status?: unknown }[] } | null)?.Data ?? []).filter(
      (s) => typeof s.Email === 'string' && s.Status === 'Active',
    );
    const active = senders.map((s) => String(s.Email).toLowerCase());
    const from = fromEmail.trim().toLowerCase();
    const fromDomainVerified = from
      ? active.some((s) => s === from || (s.startsWith('*@') && domainMatches(from, s.slice(2))))
      : null;
    let message = `API keys are valid. Active senders: ${active.join(', ') || 'none'}.`;
    if (fromDomainVerified === false) message += ` The From address "${fromEmail.trim()}" is not an active Mailjet sender.`;
    return { status: 'valid', message, verifiedDomains: active, fromDomainVerified };
  }
}
