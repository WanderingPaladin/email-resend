import { describe, expect, it } from 'vitest';
import { FINDER_TAB_HEADERS, TRACKING_COLUMNS } from '../shared/constants';
import { finderSaveInputSchema, finderSearchInputSchema } from '../shared/schemas';
import {
  cleanFoundContacts,
  ContactFinder,
  isPublicWebUrl,
  normalizePageText,
  parseContactsJson,
  responseText,
  type RawContact,
} from '../electron/services/contact-finder.service';
import { GoogleSheetsService } from '../electron/services/google-sheets.service';
import { redactText } from '../electron/services/log-format';
import { finderTabRows } from '../electron/ipc/finder.ipc';
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
    expect(finderSearchInputSchema.safeParse({ query: 'HR managers', maxResults: 51 }).success).toBe(false);
    expect(finderSearchInputSchema.parse({ query: 'HR managers' }).maxResults).toBe(20);
  });

  it('never logs an OpenAI key', () => {
    expect(redactText('key sk-proj-abcdefghijklmnopqrstuvwxyz used')).toBe('key [REDACTED API KEY] used');
  });
});
