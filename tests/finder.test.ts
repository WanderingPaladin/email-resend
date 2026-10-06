import { describe, expect, it } from 'vitest';
import { FINDER_TAB_HEADERS, TRACKING_COLUMNS } from '../shared/constants';
import { finderSaveInputSchema, finderSearchInputSchema } from '../shared/schemas';
import {
  buildSearchInput,
  cleanFoundContacts,
  ContactFinder,
  ContactFinderError,
  findUntilTarget,
  isPublicWebUrl,
  normalizePageText,
  parseContactsJson,
  responseText,
  type RawContact,
  type SearchHints,
} from '../electron/services/contact-finder.service';
import { GoogleSheetsService } from '../electron/services/google-sheets.service';
import { redactText } from '../electron/services/log-format';
import { removeKnownEmails } from '../electron/ipc/finder.ipc';
import { finderTabRows, planAppend } from '../electron/services/finder-sheet';
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

  it('creates the tab with a header, Batch Flag New and the tracking columns', async () => {
    const gateway = new FakeSheetsGateway(sheetRows([{ first_name: 'X', email: 'x@y.com', tag: 'New' }]));
    const sheets = new GoogleSheetsService(gateway, { spreadsheetId: 's', worksheetName: 'Emails', serviceAccountEmail: '' }, new MemoryLogger(), { sleepFn: noSleep });
    const saved = await sheets.createWorksheet('Found 1', finderTabRows(contacts));
    expect(saved).toEqual({ tabName: 'Found 1', rows: 2 });
    const tab = gateway.tabs.get('Found 1') ?? [];
    expect(tab[0]).toEqual([...FINDER_TAB_HEADERS, ...TRACKING_COLUMNS]);
    expect(tab[1]?.slice(0, 7)).toEqual(['Ana Lopez', 'ana@acme.com', 'Acme', 'HR', 'https://acme.com/team', 'Yes', 'New']);
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
    expect(finderSearchInputSchema.safeParse({ query: 'HR managers', maxResults: 1001 }).success).toBe(false);
    expect(finderSearchInputSchema.safeParse({ query: 'HR managers', maxResults: 500 }).success).toBe(true);
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

describe('searching until the requested number is found', () => {
  /** Returns scripted rounds (an Error entry is thrown) and marks listed emails as missing from their page. */
  function fakeSearcher(rounds: (RawContact[] | Error)[], notOnPage: string[] = []) {
    const calls: { need: number; hints: SearchHints }[] = [];
    return {
      calls,
      search: async (_q: string, need: number, hints: SearchHints = {}) => {
        calls.push({ need, hints });
        const next = rounds.shift();
        if (next === undefined) return [];
        if (next instanceof Error) throw next;
        return next;
      },
      checkOnPage: async (contacts: readonly RawContact[]) =>
        contacts.map((c) => ({ ...c, emailOnPage: notOnPage.includes(c.email) ? ('no' as const) : ('yes' as const) })),
    };
  }
  const opts = { sleepFn: noSleep };

  it('asks for the missing number, excluding everything seen, until the target is reached', async () => {
    const searcher = fakeSearcher(
      [
        [raw('a@x.com'), raw('in-sheet@x.com'), raw('bad-email'), raw('fake@x.com')],
        [raw('a@x.com'), raw('b@x.com', { organization: 'Beta' })],
        [raw('c@x.com'), raw('d@x.com')],
      ],
      ['fake@x.com'],
    );
    const progress: number[] = [];
    const result = await findUntilTarget(searcher, 'HR', 3, new Set(['in-sheet@x.com']), { ...opts, onProgress: (p) => progress.push(p.found) });
    expect(result.contacts.filter((c) => c.emailOnPage !== 'no').map((c) => c.email)).toEqual(['a@x.com', 'b@x.com', 'c@x.com']);
    expect(result).toMatchObject({ rounds: 3, target: 3, found: 3, stopped: 'done' });
    expect(result.dropped).toMatchObject({ alreadyInSheet: 1, invalid: 1, notOnPage: 1, duplicate: 1 });
    expect(searcher.calls.map((c) => c.need)).toEqual([3, 2, 1]);
    expect(searcher.calls[1]?.hints.exclude).toEqual(expect.arrayContaining(['a@x.com', 'in-sheet@x.com', 'fake@x.com']));
    expect(searcher.calls[2]?.hints.organizations).toEqual(expect.arrayContaining(['Acme', 'Beta']));
    expect(searcher.calls.map((c) => c.hints.round)).toEqual([1, 2, 3]);
    expect(progress).toEqual([1, 2, 3]);
  });

  it('has no fixed number of searches: keeps going while searches still add people', async () => {
    // One new person per search: 30 searches for 30 people.
    const rounds = Array.from({ length: 30 }, (_, i) => [raw(`p${i}@x.com`)]);
    const searcher = fakeSearcher(rounds);
    const result = await findUntilTarget(searcher, 'HR', 30, new Set(), opts);
    expect(result).toMatchObject({ found: 30, rounds: 30, stopped: 'done' });
  });

  it('reaches 100 by asking for at most 25 per search, even when many results are skipped', async () => {
    let n = 0;
    const existing = new Set<string>();
    const searcher = {
      needs: [] as number[],
      search: async (_q: string, need: number) => {
        searcher.needs.push(need);
        const found = Array.from({ length: need }, () => raw(`p${++n}@x.com`));
        // Half of every batch is already in the sheet.
        found.slice(0, Math.floor(need / 2)).forEach((c) => existing.add(c.email));
        return found;
      },
      checkOnPage: async (contacts: readonly RawContact[]) => contacts.map((c) => ({ ...c, emailOnPage: 'yes' as const })),
    };
    const result = await findUntilTarget(searcher, 'HR', 100, existing, opts);
    expect(Math.max(...searcher.needs)).toBe(25);
    expect(result).toMatchObject({ found: 100, target: 100, stopped: 'done' });
    expect(result.contacts).toHaveLength(100);
  });

  it('stops only after 5 searches in a row that add nobody, and reports the shortfall', async () => {
    const searcher = fakeSearcher([[raw('a@x.com')], [raw('a@x.com')], [], [], [raw('b@x.com')], [], [], [], [], []]);
    const result = await findUntilTarget(searcher, 'HR', 10, new Set(), opts);
    // a (1), 3 empty, b (5), then 5 empty in a row → 10 searches.
    expect(result).toMatchObject({ found: 2, rounds: 10, stopped: 'no_more_results' });
  });

  it('retries temporary OpenAI errors and continues', async () => {
    const temporary = new ContactFinderError('OpenAI did not answer in time.', true);
    const sleeps: number[] = [];
    const searcher = fakeSearcher([temporary, temporary, [raw('a@x.com')]]);
    const result = await findUntilTarget(searcher, 'HR', 1, new Set(), { sleepFn: async (ms) => void sleeps.push(ms) });
    expect(result).toMatchObject({ found: 1, rounds: 1, stopped: 'done' });
    expect(sleeps).toEqual([5000, 10000]);
  });

  it('keeps earlier results on a permanent error, and fails when there is nothing', async () => {
    const quota = new ContactFinderError('OpenAI quota reached.', false);
    const partial = await findUntilTarget(fakeSearcher([[raw('a@x.com')], quota]), 'HR', 5, new Set(), opts);
    expect(partial).toMatchObject({ found: 1, stopped: 'error', warning: 'OpenAI quota reached.' });
    await expect(findUntilTarget(fakeSearcher([quota]), 'HR', 5, new Set(), opts)).rejects.toThrow('quota');
  });

  it('stops on Cancel and returns what was found', async () => {
    const controller = new AbortController();
    const searcher = fakeSearcher([[raw('a@x.com')], [raw('b@x.com')], [raw('c@x.com')]]);
    const result = await findUntilTarget(searcher, 'HR', 10, new Set(), {
      ...opts,
      signal: controller.signal,
      onProgress: (p) => {
        if (p.found === 2) controller.abort();
      },
    });
    expect(result).toMatchObject({ found: 2, rounds: 2, stopped: 'cancelled' });
  });

  it('steers later searches to new places', () => {
    const input = buildSearchInput('HR', 2, { exclude: ['a@x.com'], organizations: ['Acme'], round: 3 });
    expect(input).toContain('Do not include them');
    expect(input).toContain('Prefer other organizations:\nAcme');
    expect(input).toContain('search number 3');
    expect(buildSearchInput('HR', 2)).not.toContain('Do not include');
  });
});

describe('adding found contacts to an existing tab', () => {
  const found = (name: string, email: string) => ({
    name,
    email,
    organization: 'Acme',
    role: 'HR',
    sourceUrl: `https://acme.com/${email}`,
    emailOnPage: 'yes' as const,
  });
  const service = (gateway: FakeSheetsGateway) =>
    new GoogleSheetsService(gateway, { spreadsheetId: 's', worksheetName: 'Emails', serviceAccountEmail: '' }, new MemoryLogger(), { sleepFn: noSleep });

  it("uses the tab's own headers and adds only the missing Source URL column", async () => {
    const gateway = new FakeSheetsGateway([
      ['Name', 'Email', 'Location', 'Country', 'Role / Profile', 'Batch Flag', 'send_status'],
      ['Ana Lopez', 'ana@x.com', 'Austin', 'US', 'CTO', 'Sent', 'sent'],
      ['Bo Chen', 'bo@x.com', '', '', '', 'New', ''],
    ]);
    const sheets = service(gateway);
    const plan = planAppend(await sheets.readWorksheet('Emails'), [found('Cy Diaz', 'cy@x.com'), found('Dee Eng', 'dee@x.com')]);
    const saved = await sheets.appendToWorksheet('Emails', plan);
    expect(saved).toEqual({ tabName: 'Emails', rows: 2, addedColumns: ['Source URL'] });
    expect(gateway.rows[0]).toEqual(['Name', 'Email', 'Location', 'Country', 'Role / Profile', 'Batch Flag', 'send_status', 'Source URL']);
    // Existing rows are untouched; new rows start below the last one, Batch Flag New.
    expect(gateway.rows[1]).toEqual(['Ana Lopez', 'ana@x.com', 'Austin', 'US', 'CTO', 'Sent', 'sent']);
    expect(gateway.rows[3]).toEqual(['Cy Diaz', 'cy@x.com', '', '', 'HR', 'New', '', 'https://acme.com/cy@x.com']);
    expect(gateway.rows[4]?.[1]).toBe('dee@x.com');
    expect(gateway.rowWrites[0]?.startRow).toBe(4);
  });

  it('splits the name for First/Last Name columns and adds missing Email and Batch Flag columns', () => {
    const plan = planAppend([['First Name', 'Last Name', 'Company', 'Notes']], [found('Ana Maria Lopez', 'ana@x.com')]);
    expect(plan.addedColumns).toEqual([
      { index: 4, label: 'Email' },
      { index: 5, label: 'Batch Flag' },
      { index: 6, label: 'Source URL' },
    ]);
    expect(plan.rows[0]).toEqual(['Ana', 'Maria Lopez', 'Acme', '', 'ana@x.com', 'New', 'https://acme.com/ana@x.com']);
    expect(plan.firstRow).toBe(2);
  });

  it('never places a new column over data that has no header', () => {
    const plan = planAppend([['Name', 'Email'], ['A', 'a@x.com', 'stray note']], [found('B', 'b@x.com')]);
    expect(plan.addedColumns.map((c) => c.index)).toEqual([3, 4]);
    expect(plan.firstRow).toBe(3);
  });

  it('accepts the existing mode in the save input', () => {
    const input = finderSaveInputSchema.parse({ mode: 'existing', tabName: 'Emails', contacts: [found('A', 'a@x.com')] });
    expect(input.mode).toBe('existing');
    expect(finderSaveInputSchema.parse({ tabName: 'X', contacts: [found('A', 'a@x.com')] }).mode).toBe('new');
  });
});
