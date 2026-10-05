import type { FinderSearchResult, FoundContact } from '../../shared/types';
import type { AppLogger } from '../types/logger';
import { redactText } from './log-format';
import { readJson, type FetchLike } from './mailer';
import { isValidEmail } from './sheet-parser';

const API = 'https://api.openai.com/v1';
/** A web-search response can take a few minutes: the model runs several searches and opens pages. */
const SEARCH_TIMEOUT_MS = 300_000;
const PAGE_TIMEOUT_MS = 15_000;
const PAGE_MAX_BYTES = 3_000_000;
const PAGE_CONCURRENCY = 4;

/** A contact as the model returned it, before any checks. */
export interface RawContact {
  name: string;
  email: string;
  organization: string;
  role: string;
  sourceUrl: string;
}

export class ContactFinderError extends Error {
  /**
   * @param retryable a temporary problem (timeout, network, rate limit, server error): the same
   *   search can be tried again after a pause.
   */
  constructor(
    message: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = 'ContactFinderError';
  }
}

/** The operator pressed Cancel. */
export class SearchCancelledError extends Error {
  constructor() {
    super('Search cancelled.');
    this.name = 'SearchCancelledError';
  }
}

export const FINDER_INSTRUCTIONS = [
  'You research publicly listed business contacts for professional outreach.',
  'Use web search to find individual people who match the request, with the business email address they or their organization publish.',
  'Rules:',
  '- Only include an email address that is written on a public web page you found (company website, team or staff page, press or media contact page, conference speaker page, professional directory). Put that page in source_url.',
  '- Never guess, construct or pattern-match an email address (for example first.last@company.com). If you did not see the exact address on the page, leave the person out.',
  '- Do not include personal addresses (gmail.com, yahoo.com and similar) unless the page lists it as the person\'s business contact.',
  '- Prefer named individuals. Skip generic inboxes such as info@, support@, sales@ or noreply@.',
  '- Do not repeat the same email address.',
  'Answer with JSON only, no other text, in this shape:',
  '{"contacts":[{"name":"Full Name","email":"name@company.com","organization":"Company","role":"Job title","source_url":"https://..."}]}',
  'If you find nobody, answer {"contacts":[]}.',
].join('\n');

/** Emails from earlier rounds sent back to the model so it looks for other people (bounded to keep the request small). */
const MAX_EXCLUDED_IN_PROMPT = 300;

const MAX_ORGANIZATIONS_IN_PROMPT = 150;

export interface SearchHints {
  /** Emails already seen: never return them. */
  exclude?: readonly string[];
  /** Organizations already used: look at other ones first. */
  organizations?: readonly string[];
  /** 1 for the first search; later searches are asked to look in new places. */
  round?: number;
}

export function buildSearchInput(query: string, maxResults: number, hints: SearchHints = {}): string {
  const parts = [`Find up to ${maxResults} people matching this description:\n${query.trim()}`];
  const exclude = (hints.exclude ?? []).slice(-MAX_EXCLUDED_IN_PROMPT);
  if (exclude.length > 0) {
    parts.push(`These email addresses were already found or cannot be used. Do not include them; find different people:\n${exclude.join('\n')}`);
  }
  const organizations = (hints.organizations ?? []).slice(-MAX_ORGANIZATIONS_IN_PROMPT);
  if (organizations.length > 0) {
    parts.push(`People from these organizations were already found. Prefer other organizations:\n${organizations.join('\n')}`);
  }
  if ((hints.round ?? 1) > 1) {
    parts.push(
      `This is search number ${hints.round}. Earlier searches already covered the obvious results, so search in different places: ` +
        'other companies and locations that fit the description, staff and team pages, professional association member directories, ' +
        'conference and event speaker lists, press and media contact pages.',
    );
  }
  return parts.join('\n\n');
}

/** Text of the assistant's final message in a Responses API result. */
export function responseText(body: unknown): string {
  const output = (body as { output?: unknown })?.output;
  if (!Array.isArray(output)) return '';
  const parts: string[] = [];
  for (const item of output) {
    const i = item as { type?: string; content?: unknown };
    if (i.type !== 'message' || !Array.isArray(i.content)) continue;
    for (const c of i.content) {
      const part = c as { type?: string; text?: unknown };
      if (part.type === 'output_text' && typeof part.text === 'string') parts.push(part.text);
    }
  }
  return parts.join('\n');
}

const str = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

/** Reads the contacts out of the model's answer. Tolerates code fences and text around the JSON. */
export function parseContactsJson(text: string): RawContact[] {
  const start = text.search(/[{[]/);
  const end = Math.max(text.lastIndexOf('}'), text.lastIndexOf(']'));
  if (start < 0 || end <= start) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return [];
  }
  const list = Array.isArray(parsed) ? parsed : (parsed as { contacts?: unknown })?.contacts;
  if (!Array.isArray(list)) return [];
  return list
    .filter((c): c is Record<string, unknown> => Boolean(c) && typeof c === 'object')
    .map((c) => ({
      name: str(c.name, 200),
      email: str(c.email, 320).replace(/^mailto:/i, ''),
      organization: str(c.organization ?? c.company, 300),
      role: str(c.role ?? c.title, 300),
      sourceUrl: str(c.source_url ?? c.sourceUrl ?? c.url, 2000),
    }));
}

/**
 * Drops results that cannot be used: invalid emails, results without a public source page,
 * repeats, and emails already in the Emails tab. Keeps at most `maxResults`.
 */
export function cleanFoundContacts(
  raw: readonly RawContact[],
  existingEmails: ReadonlySet<string>,
  maxResults: number,
): { contacts: RawContact[]; dropped: Omit<FinderSearchResult['dropped'], 'notOnPage'> } {
  const dropped = { invalid: 0, noSource: 0, duplicate: 0, alreadyInSheet: 0 };
  const seen = new Set<string>();
  const contacts: RawContact[] = [];
  for (const contact of raw) {
    const key = contact.email.trim().toLowerCase();
    if (!isValidEmail(contact.email)) dropped.invalid++;
    else if (!isHttpUrl(contact.sourceUrl)) dropped.noSource++;
    else if (seen.has(key)) dropped.duplicate++;
    else if (existingEmails.has(key)) dropped.alreadyInSheet++;
    else if (contacts.length < maxResults) {
      seen.add(key);
      contacts.push({ ...contact, email: contact.email.trim() });
    }
  }
  return { contacts, dropped };
}

export function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
}

/**
 * Only public web pages are opened: a URL from the model never reaches this computer, the local
 * network or an IP address directly.
 */
export function isPublicWebUrl(value: string): boolean {
  if (!isHttpUrl(value)) return false;
  const host = new URL(value).hostname.toLowerCase();
  if (!host.includes('.') || host.startsWith('[') || /^\d+(\.\d+){3}$/.test(host)) return false;
  return !/(^|\.)(localhost|local|internal|lan|home|corp|intranet)$/.test(host);
}

/** Page text with common email obfuscations undone, lowercased, for a plain substring check. */
export function normalizePageText(html: string): string {
  return html
    .replace(/&#0*64;|&#x0*40;|&commat;/gi, '@')
    .replace(/&#0*46;|&#x0*2e;|&period;/gi, '.')
    .replace(/%40/g, '@')
    .replace(/\s*[[(]\s*at\s*[\])]\s*/gi, '@')
    .replace(/\s*[[(]\s*dot\s*[\])]\s*/gi, '.')
    .toLowerCase();
}

function apiErrorMessage(body: unknown): string {
  const error = (body as { error?: { message?: unknown } | string })?.error;
  const message = typeof error === 'string' ? error : error?.message;
  return typeof message === 'string' ? redactText(message, { maskEmails: false }).slice(0, 500) : '';
}

/**
 * Finds publicly listed business contacts with OpenAI's Responses API and its web_search tool,
 * then opens each source page to check the email is really there.
 */
export class ContactFinder {
  constructor(
    private readonly apiKey: string,
    private readonly model: string,
    private readonly logger: AppLogger,
    private readonly fetchFn: FetchLike = fetch,
  ) {}

  private async api(path: string, init: RequestInit, timeoutMs: number, cancel?: AbortSignal): Promise<{ status: number; body: unknown }> {
    if (cancel?.aborted) throw new SearchCancelledError();
    let response: Response;
    try {
      const timeout = AbortSignal.timeout(timeoutMs);
      response = await this.fetchFn(`${API}${path}`, {
        ...init,
        headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
        signal: cancel ? AbortSignal.any([timeout, cancel]) : timeout,
      });
    } catch (error) {
      if (cancel?.aborted) throw new SearchCancelledError();
      const name = (error as { name?: string })?.name;
      if (name === 'TimeoutError' || name === 'AbortError') {
        throw new ContactFinderError('OpenAI did not answer in time.', true);
      }
      throw new ContactFinderError(
        `Could not reach OpenAI (${redactText(String((error as Error)?.message ?? error)).slice(0, 200)}). Check that this computer can open https://api.openai.com.`,
        true,
      );
    }
    return { status: response.status, body: await readJson(response) };
  }

  private fail(status: number, body: unknown): never {
    const message = apiErrorMessage(body);
    if (status === 401) throw new ContactFinderError('OpenAI rejected the API key. Check it in Settings.');
    if (status === 404) {
      throw new ContactFinderError(`OpenAI model "${this.model}" was not found for this key. Change the model in Settings.${message ? ` (${message})` : ''}`);
    }
    if (status === 429) {
      // "insufficient_quota" (no credits) does not go away by waiting; a rate limit does.
      const quota = /quota|billing|credit/i.test(message);
      throw new ContactFinderError(
        quota
          ? `OpenAI quota reached. Check your OpenAI plan and billing.${message ? ` (${message})` : ''}`
          : `OpenAI rate limit reached.${message ? ` (${message})` : ''}`,
        !quota,
      );
    }
    throw new ContactFinderError(`OpenAI error (HTTP ${status})${message ? `: ${message}` : ''}`, status >= 500);
  }

  /** Checks the key and model without running a search. */
  async validate(): Promise<{ message: string }> {
    const { status, body } = await this.api(`/models/${encodeURIComponent(this.model)}`, { method: 'GET' }, 30_000);
    if (status !== 200) this.fail(status, body);
    return { message: `OpenAI key works and model "${this.model}" is available.` };
  }

  async search(query: string, maxResults: number, hints: SearchHints = {}, cancel?: AbortSignal): Promise<RawContact[]> {
    this.logger.info('finder', 'Contact search started', {
      model: this.model,
      maxResults,
      round: hints.round ?? 1,
      excluded: hints.exclude?.length ?? 0,
    });
    const { status, body } = await this.api(
      '/responses',
      {
        method: 'POST',
        body: JSON.stringify({
          model: this.model,
          instructions: FINDER_INSTRUCTIONS,
          input: buildSearchInput(query, maxResults, hints),
          tools: [{ type: 'web_search' }],
        }),
      },
      SEARCH_TIMEOUT_MS,
      cancel,
    );
    if (status !== 200) this.fail(status, body);
    const state = (body as { status?: string })?.status;
    if (state === 'failed') {
      throw new ContactFinderError(`OpenAI could not finish the search${apiErrorMessage(body) ? `: ${apiErrorMessage(body)}` : '.'}`, true);
    }
    const text = responseText(body);
    const contacts = parseContactsJson(text);
    if (contacts.length === 0 && text && !/"contacts"\s*:\s*\[\s*\]/.test(text)) {
      this.logger.warn('finder', 'OpenAI answer did not contain a contact list', { status: state });
    }
    this.logger.info('finder', `OpenAI returned ${contacts.length} contact(s)`, { status: state });
    return contacts;
  }

  /** Opens each source page once and records whether each email appears on it. */
  async checkOnPage(contacts: readonly RawContact[]): Promise<FoundContact[]> {
    const urls = [...new Set(contacts.map((c) => c.sourceUrl))];
    const pages = new Map<string, string | null>();
    let next = 0;
    const worker = async () => {
      while (next < urls.length) {
        const url = urls[next++] as string;
        pages.set(url, await this.readPage(url));
      }
    };
    await Promise.all(Array.from({ length: Math.min(PAGE_CONCURRENCY, urls.length) }, worker));
    const result = contacts.map((c): FoundContact => {
      const page = pages.get(c.sourceUrl);
      const emailOnPage = page == null ? 'unknown' : page.includes(c.email.toLowerCase()) ? 'yes' : 'no';
      return { ...c, emailOnPage };
    });
    this.logger.info('finder', 'Checked source pages', {
      pages: urls.length,
      onPage: result.filter((c) => c.emailOnPage === 'yes').length,
      notOnPage: result.filter((c) => c.emailOnPage === 'no').length,
      unknown: result.filter((c) => c.emailOnPage === 'unknown').length,
    });
    return result;
  }

  private async readPage(url: string): Promise<string | null> {
    if (!isPublicWebUrl(url)) return null;
    try {
      const response = await this.fetchFn(url, {
        method: 'GET',
        redirect: 'follow',
        headers: { Accept: 'text/html,text/plain;q=0.9,*/*;q=0.5' },
        signal: AbortSignal.timeout(PAGE_TIMEOUT_MS),
      });
      if (!response.ok) return null;
      const text = await response.text();
      return normalizePageText(text.slice(0, PAGE_MAX_BYTES));
    } catch {
      return null;
    }
  }
}

/** Most people asked for in one search; larger requests are split over several searches. */
export const PER_SEARCH_LIMIT = 25;
/** Searches in a row that add nobody new before the run stops: the web has no more matches. */
export const STALL_LIMIT = 5;
/** Tries per search when OpenAI has a temporary problem. */
const MAX_TRIES = 4;
const RETRY_BASE_MS = 5_000;

export interface FinderRoundProgress {
  round: number;
  found: number;
  target: number;
  /** Searches in a row that found nobody new. */
  emptyInARow: number;
}

type Searcher = Pick<ContactFinder, 'search' | 'checkOnPage'>;

export interface FindOptions {
  onProgress?: (p: FinderRoundProgress) => void;
  logger?: AppLogger;
  /** Aborted when the operator presses Cancel. */
  signal?: AbortSignal;
  stallLimit?: number;
  sleepFn?: (ms: number) => Promise<void>;
}

function domainOf(email: string): string {
  return email.split('@')[1]?.toLowerCase() ?? '';
}

/**
 * Searches until `target` usable contacts are found, with no fixed number of searches. Results that
 * are invalid, repeated, already in the spreadsheet or not on their source page do not count; each
 * new search asks for the missing number, excludes every email seen so far and is steered to other
 * organizations and sources. Temporary OpenAI errors are retried. The run ends only when the target
 * is reached, the operator cancels, a permanent error occurs, or `stallLimit` searches in a row add
 * nobody new. Whatever was found is always returned.
 */
export async function findUntilTarget(
  finder: Searcher,
  query: string,
  target: number,
  existing: ReadonlySet<string>,
  options: FindOptions = {},
): Promise<Omit<FinderSearchResult, 'checkedAgainstSheet'>> {
  const stallLimit = options.stallLimit ?? STALL_LIMIT;
  const sleepFn = options.sleepFn ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const accepted: FoundContact[] = [];
  const notOnPage: FoundContact[] = [];
  const dropped = { invalid: 0, noSource: 0, duplicate: 0, alreadyInSheet: 0, notOnPage: 0 };
  const seen = new Set<string>(); // every email returned so far, in any round
  const organizations = new Set<string>();
  let rounds = 0;
  let emptyRounds = 0;
  let warning: string | undefined;
  let stopped: FinderSearchResult['stopped'] = 'done';

  const pause = async (ms: number) => {
    if (options.signal?.aborted) throw new SearchCancelledError();
    await sleepFn(ms);
    if (options.signal?.aborted) throw new SearchCancelledError();
  };

  try {
    while (accepted.length < target) {
      if (options.signal?.aborted) throw new SearchCancelledError();
      rounds++;
      const need = Math.min(target - accepted.length, PER_SEARCH_LIMIT);
      const hints: SearchHints = { exclude: [...seen], organizations: [...organizations], round: rounds };

      let raw: RawContact[] = [];
      for (let attempt = 1; ; attempt++) {
        try {
          raw = await finder.search(query, need, hints, options.signal);
          break;
        } catch (error) {
          if (error instanceof SearchCancelledError) throw error;
          const retryable = error instanceof ContactFinderError && error.retryable;
          if (retryable && attempt < MAX_TRIES) {
            options.logger?.warn('finder', `Search ${rounds} failed; trying again`, { attempt, reason: (error as Error).message });
            await pause(RETRY_BASE_MS * 2 ** (attempt - 1));
            continue;
          }
          throw error;
        }
      }

      const fresh: RawContact[] = [];
      for (const contact of raw) {
        const key = contact.email.trim().toLowerCase();
        if (key && seen.has(key)) dropped.duplicate++;
        else fresh.push(contact);
        if (key) seen.add(key);
      }
      const cleaned = cleanFoundContacts(fresh, existing, Number.MAX_SAFE_INTEGER);
      dropped.invalid += cleaned.dropped.invalid;
      dropped.noSource += cleaned.dropped.noSource;
      dropped.duplicate += cleaned.dropped.duplicate;
      dropped.alreadyInSheet += cleaned.dropped.alreadyInSheet;

      const before = accepted.length;
      for (const contact of await finder.checkOnPage(cleaned.contacts)) {
        organizations.add(contact.organization.trim() || domainOf(contact.email));
        if (contact.emailOnPage === 'no') {
          dropped.notOnPage++;
          notOnPage.push(contact);
        } else if (accepted.length < target) {
          accepted.push(contact);
        }
      }
      emptyRounds = accepted.length === before ? emptyRounds + 1 : 0;
      options.onProgress?.({ round: rounds, found: accepted.length, target, emptyInARow: emptyRounds });
      options.logger?.info('finder', `Search ${rounds}: ${accepted.length} of ${target} found`);
      if (accepted.length < target && emptyRounds >= stallLimit) {
        stopped = 'no_more_results';
        break;
      }
    }
  } catch (error) {
    if (error instanceof SearchCancelledError) {
      stopped = 'cancelled';
    } else {
      // Keep what earlier searches found; fail only when there is nothing to show.
      if (accepted.length + notOnPage.length === 0) throw error;
      stopped = 'error';
      warning = error instanceof Error ? error.message : String(error);
    }
  }

  return { contacts: [...accepted, ...notOnPage], dropped, rounds, target, found: accepted.length, stopped, warning };
}
