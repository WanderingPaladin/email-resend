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
  constructor(message: string) {
    super(message);
    this.name = 'ContactFinderError';
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

export function buildSearchInput(query: string, maxResults: number, exclude: readonly string[] = []): string {
  const base = `Find up to ${maxResults} people matching this description:\n${query.trim()}`;
  const list = exclude.slice(-MAX_EXCLUDED_IN_PROMPT);
  if (list.length === 0) return base;
  return `${base}\n\nThese email addresses were already found or cannot be used. Do not include them; find different people:\n${list.join('\n')}`;
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

  private async api(path: string, init: RequestInit, timeoutMs: number): Promise<{ status: number; body: unknown }> {
    let response: Response;
    try {
      response = await this.fetchFn(`${API}${path}`, {
        ...init,
        headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      const name = (error as { name?: string })?.name;
      if (name === 'TimeoutError' || name === 'AbortError') {
        throw new ContactFinderError('OpenAI did not answer in time. Try a narrower search or fewer results.');
      }
      throw new ContactFinderError(
        `Could not reach OpenAI (${redactText(String((error as Error)?.message ?? error)).slice(0, 200)}). Check that this computer can open https://api.openai.com.`,
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
      throw new ContactFinderError(`OpenAI rate limit or quota reached. Check your OpenAI plan and billing.${message ? ` (${message})` : ''}`);
    }
    throw new ContactFinderError(`OpenAI error (HTTP ${status})${message ? `: ${message}` : ''}`);
  }

  /** Checks the key and model without running a search. */
  async validate(): Promise<{ message: string }> {
    const { status, body } = await this.api(`/models/${encodeURIComponent(this.model)}`, { method: 'GET' }, 30_000);
    if (status !== 200) this.fail(status, body);
    return { message: `OpenAI key works and model "${this.model}" is available.` };
  }

  async search(query: string, maxResults: number, exclude: readonly string[] = []): Promise<RawContact[]> {
    this.logger.info('finder', 'Contact search started', { model: this.model, maxResults, excluded: exclude.length });
    const { status, body } = await this.api(
      '/responses',
      {
        method: 'POST',
        body: JSON.stringify({
          model: this.model,
          instructions: FINDER_INSTRUCTIONS,
          input: buildSearchInput(query, maxResults, exclude),
          tools: [{ type: 'web_search' }],
        }),
      },
      SEARCH_TIMEOUT_MS,
    );
    if (status !== 200) this.fail(status, body);
    const state = (body as { status?: string })?.status;
    if (state === 'failed') throw new ContactFinderError(`OpenAI could not finish the search${apiErrorMessage(body) ? `: ${apiErrorMessage(body)}` : '.'}`);
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

/** How many searches Find Contacts runs at most to reach the requested number. */
export const MAX_SEARCH_ROUNDS = 5;

export interface FinderRoundProgress {
  round: number;
  maxRounds: number;
  found: number;
  target: number;
}

type Searcher = Pick<ContactFinder, 'search' | 'checkOnPage'>;

/**
 * Searches repeatedly until `target` usable contacts are found. Results that are invalid, repeated,
 * already in the spreadsheet or not on their source page do not count, and the next round asks for
 * the missing number while excluding every email seen so far. Stops after `maxRounds`, or after two
 * rounds in a row that add nobody.
 */
export async function findUntilTarget(
  finder: Searcher,
  query: string,
  target: number,
  existing: ReadonlySet<string>,
  options: { maxRounds?: number; onProgress?: (p: FinderRoundProgress) => void; logger?: AppLogger } = {},
): Promise<Omit<FinderSearchResult, 'checkedAgainstSheet'>> {
  const maxRounds = options.maxRounds ?? MAX_SEARCH_ROUNDS;
  const accepted: FoundContact[] = [];
  const notOnPage: FoundContact[] = [];
  const dropped = { invalid: 0, noSource: 0, duplicate: 0, alreadyInSheet: 0, notOnPage: 0 };
  const seen = new Set<string>(); // every email returned so far, in any round
  let rounds = 0;
  let emptyRounds = 0;
  let warning: string | undefined;

  while (accepted.length < target && rounds < maxRounds) {
    rounds++;
    const need = target - accepted.length;
    let raw: RawContact[];
    try {
      raw = await finder.search(query, need, [...seen]);
    } catch (error) {
      // Keep what earlier rounds found; fail only when there is nothing to show.
      if (accepted.length + notOnPage.length === 0) throw error;
      warning = error instanceof Error ? error.message : String(error);
      break;
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
      if (contact.emailOnPage === 'no') {
        dropped.notOnPage++;
        notOnPage.push(contact);
      } else if (accepted.length < target) {
        accepted.push(contact);
      }
    }
    options.onProgress?.({ round: rounds, maxRounds, found: accepted.length, target });
    options.logger?.info('finder', `Search round ${rounds}: ${accepted.length} of ${target} found`);
    emptyRounds = accepted.length === before ? emptyRounds + 1 : 0;
    if (emptyRounds >= 2) break;
  }

  return { contacts: [...accepted, ...notOnPage], dropped, rounds, target, found: accepted.length, warning };
}
