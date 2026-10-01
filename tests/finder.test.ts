import { describe, expect, it } from 'vitest';
import { FINDER_TAB_HEADERS, TRACKING_COLUMNS } from '../shared/constants';
import { finderSaveInputSchema, finderSearchInputSchema } from '../shared/schemas';
import {
  buildSearchInput,
  cleanFoundContacts,
  ContactFinder,
  findUntilTarget,
  maxRoundsFor,
  isPublicWebUrl,
  normalizePageText,
  parseContactsJson,
  responseText,
  type RawContact,
} from '../electron/services/contact-finder.service';
import { GoogleSheetsService } from '../electron/services/google-sheets.service';
import { redactText } from '../electron/services/log-format';
import { finderTabRows, removeKnownEmails } from '../electron/ipc/finder.ipc';
import { FakeFetch, FakeSheetsGateway, MemoryLogger, noSleep, sheetRows } from './helpers';

const raw = (email: string, extra: Partial<RawContact> = {}): RawContact => ({
  name: 'Ana Lopez',
  email,
  organization: 'Acme',
  role: 'HR Manager',
  sourceUrl: 'https://acme.example.com/team',
  ...extra,
});

function openAiAnswer(text: string) {
  return {
    id: 'resp_1',
    status: 'completed',
    output: [
      { type: 'web_search_call', id: 'ws_1', status: 'completed' },
      { type: 'message', content: [{ type: 'output_text', text, annotations: [] }] },
    ],
  };
}

describe('reading the model answer', () => {
  it('takes the text of the message output', () => {
    expect(responseText(openAiAnswer('{"contacts":[]}'))).toBe('{"contacts":[]}');
    expect(responseText({})).toBe('');
  });

  it('parses contacts from JSON, even inside a code fence or with text around it', () => {
    const text = 'Here you go:\n```json\n{"contacts":[{"name":"Ana Lopez","email":"mailto:ana@acme.com","company":"Acme","title":"HR","source_url":"https://acme.com/team"}]}\n```';
    expect(parseContactsJson(text)).toEqual([
      { name: 'Ana Lopez', email: 'ana@acme.com', organization: 'Acme', role: 'HR', sourceUrl: 'https://acme.com/team' },
    ]);
    expect(parseContactsJson('no json here')).toEqual([]);
    expect(parseContactsJson('{"contacts": "nope"}')).toEqual([]);
  });
});

describe('cleaning results', () => {
  it('drops invalid emails, results without a page, repeats and people already in the sheet', () => {
    const { contacts, dropped } = cleanFoundContacts(
      [
        raw('ana@acme.com'),
        raw('not-an-email'),
        raw('bo@acme.com', { sourceUrl: '' }),
        raw('ANA@acme.com'),
        raw('existing@acme.com'),
        raw('cy@acme.com'),
      ],
      new Set(['existing@acme.com']),
      10,
    );
    expect(contacts.map((c) => c.email)).toEqual(['ana@acme.com', 'cy@acme.com']);
    expect(dropped).toEqual({ invalid: 1, noSource: 1, duplicate: 1, alreadyInSheet: 1 });
  });

  it('keeps at most the requested number', () => {
    const { contacts } = cleanFoundContacts([raw('a@x.com'), raw('b@x.com'), raw('c@x.com')], new Set(), 2);
    expect(contacts).toHaveLength(2);
  });
});

describe('ContactFinder', () => {
  it('calls the Responses API with web search and returns the parsed contacts', async () => {
    const fake = new FakeFetch().reply(200, openAiAnswer(JSON.stringify({ contacts: [{ name: 'Ana', email: 'ana@acme.com', source_url: 'https://acme.com' }] })));
    const finder = new ContactFinder('sk-test-key-123456789012', 'gpt-test', new MemoryLogger(), fake.fetch);
    const found = await finder.search('HR managers in Austin', 5);
    expect(found.map((c) => c.email)).toEqual(['ana@acme.com']);
    const call = fake.calls[0];
    expect(call?.url).toBe('https://api.openai.com/v1/responses');
    expect(call?.headers['authorization']).toBe('Bearer sk-test-key-123456789012');
    expect(call?.body).toMatchObject({ model: 'gpt-test', tools: [{ type: 'web_search' }] });
    expect(JSON.stringify(call?.body)).toContain('HR managers in Austin');
    expect(JSON.stringify(call?.body)).toContain('Never guess');
  });

  it('turns API errors into messages without the key', async () => {
    const finder = (fake: FakeFetch) => new ContactFinder('sk-test-key-123456789012', 'gpt-test', new MemoryLogger(), fake.fetch);
    await expect(finder(new FakeFetch().reply(401, { error: { message: 'Incorrect API key provided: sk-test-key-123456789012' } })).search('x y z', 5)).rejects.toThrow(
      'OpenAI rejected the API key',
    );
    await expect(finder(new FakeFetch().reply(404, { error: { message: 'model not found' } })).validate()).rejects.toThrow('model "gpt-test" was not found');
    await expect(finder(new FakeFetch().reply(429, { error: { message: 'quota' } })).search('x y z', 5)).rejects.toThrow('quota');
    const offline = await finder(new FakeFetch().fail(new Error('net::ERR_INTERNET_DISCONNECTED'))).search('x y z', 5).catch((e: Error) => e.message);
    expect(offline).toContain('Could not reach OpenAI');
  });

  it('checks each source page for the email', async () => {
    const fake = new FakeFetch();
    fake.responses.push(
      new Response('<a href="mailto:ana&#64;acme.com">Email Ana</a> and bo [at] acme.com'),
      new Response('Nothing here'),
      new Response('gone', { status: 404 }),
    );
    const finder = new ContactFinder('sk-x', 'gpt-test', new MemoryLogger(), fake.fetch);
    const checked = await finder.checkOnPage([
      raw('ana@acme.com'),
      raw('bo@acme.com'),
      raw('cy@beta.com', { sourceUrl: 'https://beta.example.com/about' }),
      raw('dee@gamma.com', { sourceUrl: 'https://gamma.example.com/x' }),
      raw('local@intranet.com', { sourceUrl: 'http://192.168.1.10/staff' }),
    ]);
    expect(checked.map((c) => c.emailOnPage)).toEqual(['yes', 'yes', 'no', 'unknown', 'unknown']);
    // One request per page; the private address is never opened.
    expect(fake.calls.map((c) => c.url)).toEqual(['https://acme.example.com/team', 'https://beta.example.com/about', 'https://gamma.example.com/x']);
    expect(fake.calls.every((c) => !c.headers['authorization'])).toBe(true);
  });

  it('only opens public web pages', () => {
    expect(isPublicWebUrl('https://acme.com/team')).toBe(true);
    for (const url of ['http://localhost:3000', 'http://10.0.0.1/', 'http://[::1]/', 'file:///etc/passwd', 'http://printer.local/', 'https://intranet/']) {
      expect(isPublicWebUrl(url)).toBe(false);
    }
    expect(normalizePageText('Ana (at) Acme (dot) com')).toBe('ana@acme.com');
  });
});

describe('saving results to a new tab', () => {
  const contacts = [
    { name: 'Ana Lopez', email: 'ana@acme.com', organization: 'Acme', role: 'HR', sourceUrl: 'https://acme.com/team', emailOnPage: 'yes' as const },
    { name: '=HYPERLINK("x")', email: 'bo@acme.com', organization: '', role: '', sourceUrl: 'https://acme.com/b', emailOnPage: 'unknown' as const },
  ];

  it('creates the tab with a header, an empty Batch Flag and the tracking columns', async () => {
    const gateway = new FakeSheetsGateway(sheetRows([{ first_name: 'X', email: 'x@y.com', tag: 'New' }]));
    const sheets = new GoogleSheetsService(gateway, { spreadsheetId: 's', worksheetName: 'Emails', serviceAccountEmail: '' }, new MemoryLogger(), { sleepFn: noSleep });
    const saved = await sheets.createWorksheet('Found 1', finderTabRows(contacts));
    expect(saved).toEqual({ tabName: 'Found 1', rows: 2 });
    const tab = gateway.tabs.get('Found 1') ?? [];
    expect(tab[0]).toEqual([...FINDER_TAB_HEADERS, ...TRACKING_COLUMNS]);
    expect(tab[1]?.slice(0, 7)).toEqual(['Ana Lopez', 'ana@acme.com', 'Acme', 'HR', 'https://acme.com/team', 'Yes', '']);
    expect(tab[2]?.[5]).toBe('Could not check');
    // The Emails tab is not touched.
    expect(gateway.writeBatches).toHaveLength(0);
  });

  it('refuses to overwrite an existing tab', async () => {
    const gateway = new FakeSheetsGateway(sheetRows([]));
    const sheets = new GoogleSheetsService(gateway, { spreadsheetId: 's', worksheetName: 'Emails', serviceAccountEmail: '' }, new MemoryLogger(), { sleepFn: noSleep });
    await expect(sheets.createWorksheet('emails', finderTabRows(contacts))).rejects.toThrow('already exists');
  });

  it('validates the input', () => {
    expect(finderSaveInputSchema.safeParse({ tabName: 'Bad/Name', contacts }).success).toBe(false);
    expect(finderSaveInputSchema.safeParse({ tabName: 'Good', contacts: [] }).success).toBe(false);
    expect(finderSaveInputSchema.safeParse({ tabName: 'Good', contacts }).success).toBe(true);
    expect(finderSearchInputSchema.safeParse({ query: 'HR managers', maxResults: 101 }).success).toBe(false);
    expect(finderSearchInputSchema.safeParse({ query: 'HR managers', maxResults: 100 }).success).toBe(true);
    expect(finderSearchInputSchema.parse({ query: 'HR managers' }).maxResults).toBe(20);
  });

  it('never logs an OpenAI key', () => {
    expect(redactText('key sk-proj-abcdefghijklmnopqrstuvwxyz used')).toBe('key [REDACTED API KEY] used');
  });
});

describe('duplicate check across the whole spreadsheet', () => {
  const found = (email: string) => ({ name: 'X', email, organization: '', role: '', sourceUrl: 'https://x.com', emailOnPage: 'yes' as const });

  it('reads emails from every tab and any column', async () => {
    const gateway = new FakeSheetsGateway(sheetRows([{ first_name: 'A', email: 'Ana@Acme.com', tag: 'New' }]));
    gateway.tabs.set('Found 1', [['Name', 'Email'], ['Bo', 'bo@acme.com']]);
    gateway.tabs.set('Notes', [['Contact', 'Other'], ['mailto:cy@acme.com', 'not an email @ all']]);
    const sheets = new GoogleSheetsService(gateway, { spreadsheetId: 's', worksheetName: 'Emails', serviceAccountEmail: '' }, new MemoryLogger(), { sleepFn: noSleep });
    expect([...(await sheets.readAllEmails())].sort()).toEqual(['ana@acme.com', 'bo@acme.com', 'cy@acme.com']);
  });

  it('skips emails already in the spreadsheet and repeats in the selection', () => {
    const result = removeKnownEmails(
      [found('new@acme.com'), found('BO@acme.com'), found('New@Acme.com'), found('other@acme.com')],
      new Set(['bo@acme.com']),
    );
    expect(result.unique.map((c) => c.email)).toEqual(['new@acme.com', 'other@acme.com']);
    expect(result.skippedExisting).toBe(1);
    expect(result.skippedDuplicate).toBe(1);
  });
});

describe('searching again until the requested number is found', () => {
  /** Returns scripted rounds and marks listed emails as missing from their page. */
  function fakeSearcher(rounds: RawContact[][], notOnPage: string[] = []) {
    const calls: { need: number; exclude: string[] }[] = [];
    return {
      calls,
      search: async (_q: string, need: number, exclude: readonly string[] = []) => {
        calls.push({ need, exclude: [...exclude] });
        const next = rounds.shift();
        if (!next) throw new Error('OpenAI rate limit or quota reached.');
        return next;
      },
      checkOnPage: async (contacts: readonly RawContact[]) =>
        contacts.map((c) => ({ ...c, emailOnPage: notOnPage.includes(c.email) ? ('no' as const) : ('yes' as const) })),
    };
  }

  it('asks for the missing number, excluding everything seen, until the target is reached', async () => {
    const searcher = fakeSearcher(
      [
        [raw('a@x.com'), raw('in-sheet@x.com'), raw('bad-email'), raw('fake@x.com')],
        [raw('a@x.com'), raw('b@x.com')],
        [raw('c@x.com'), raw('d@x.com')],
      ],
      ['fake@x.com'],
    );
    const progress: number[] = [];
    const result = await findUntilTarget(searcher, 'HR', 3, new Set(['in-sheet@x.com']), { onProgress: (p) => progress.push(p.found) });
    expect(result.contacts.filter((c) => c.emailOnPage !== 'no').map((c) => c.email)).toEqual(['a@x.com', 'b@x.com', 'c@x.com']);
    expect(result.contacts.find((c) => c.email === 'fake@x.com')?.emailOnPage).toBe('no');
    expect(result).toMatchObject({ rounds: 3, target: 3, found: 3 });
    expect(result.dropped).toMatchObject({ alreadyInSheet: 1, invalid: 1, notOnPage: 1, duplicate: 1 });
    expect(searcher.calls.map((c) => c.need)).toEqual([3, 2, 1]);
    expect(searcher.calls[1]?.exclude).toEqual(expect.arrayContaining(['a@x.com', 'in-sheet@x.com', 'fake@x.com']));
    expect(progress).toEqual([1, 2, 3]);
  });

  it('stops after the round limit and reports the shortfall', async () => {
    const searcher = fakeSearcher([[raw('a@x.com')], [raw('b@x.com')], [raw('c@x.com')]]);
    const result = await findUntilTarget(searcher, 'HR', 10, new Set(), { maxRounds: 3 });
    expect(result).toMatchObject({ rounds: 3, found: 3, target: 10 });
    expect(searcher.calls).toHaveLength(3);
  });

  it('stops after two rounds in a row that add nobody', async () => {
    const searcher = fakeSearcher([[raw('a@x.com')], [raw('a@x.com')], [], [raw('b@x.com')]]);
    const result = await findUntilTarget(searcher, 'HR', 5, new Set());
    expect(result).toMatchObject({ rounds: 3, found: 1 });
  });

  it('keeps earlier results when a later round fails, and fails when there is nothing', async () => {
    const partial = await findUntilTarget(fakeSearcher([[raw('a@x.com')]]), 'HR', 5, new Set());
    expect(partial.found).toBe(1);
    expect(partial.warning).toContain('rate limit');
    await expect(findUntilTarget(fakeSearcher([]), 'HR', 5, new Set())).rejects.toThrow('rate limit');
  });

  it('reaches 100 by asking for at most 25 per search, with extra searches for skipped results', async () => {
    let n = 0;
    const batch = (size: number) => Array.from({ length: size }, () => raw(`p${++n}@x.com`));
    // Every search returns what was asked, but a fifth of each batch is already in the sheet.
    const existing = new Set<string>();
    const searcher = {
      needs: [] as number[],
      search: async (_q: string, need: number) => {
        searcher.needs.push(need);
        const found = batch(need);
        found.slice(0, Math.floor(need / 5)).forEach((c) => existing.add(c.email));
        return found;
      },
      checkOnPage: async (contacts: readonly RawContact[]) => contacts.map((c) => ({ ...c, emailOnPage: 'yes' as const })),
    };
    const result = await findUntilTarget(searcher, 'HR', 100, existing);
    expect(maxRoundsFor(20)).toBe(5);
    expect(maxRoundsFor(100)).toBe(8);
    expect(Math.max(...searcher.needs)).toBe(25);
    expect(result).toMatchObject({ found: 100, target: 100 });
    expect(result.contacts).toHaveLength(100);
    expect(searcher.needs.slice(0, 4)).toEqual([25, 25, 25, 25]);
    expect(result.dropped.alreadyInSheet).toBe(searcher.needs.reduce((sum, need) => sum + Math.floor(need / 5), 0));
  });

  it('tells the model which emails to leave out', () => {
    expect(buildSearchInput('HR', 2, ['a@x.com'])).toContain('Do not include them');
    expect(buildSearchInput('HR', 2)).not.toContain('Do not include');
  });
});
