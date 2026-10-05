import { describe, expect, it } from 'vitest';
import { ContactFinder, responseUsage } from '../electron/services/contact-finder.service';
import { FinderResultStore, FinderUsageLog, MAX_SAVED_SEARCHES, MAX_USAGE_RECORDS } from '../electron/services/finder-usage.service';
import type { FinderSearchResult } from '../shared/types';
import { createMemorySettingsRepository } from '../electron/repositories/settings.repository';
import { currentTotal, estimateCost, formatUsd, periodStart, priceFor, totalsBy, type FinderUsageRecord } from '../shared/usage';
import { FakeFetch, MemoryLogger } from './helpers';

const answer = (usage: object, searches = 1) => ({
  status: 'completed',
  usage,
  output: [
    ...Array.from({ length: searches }, (_, i) => ({ type: 'web_search_call', id: `ws_${i}`, status: 'completed' })),
    { type: 'message', content: [{ type: 'output_text', text: '{"contacts":[]}' }] },
  ],
});

const record = (at: string, estimatedCost: number, priceKnown = true): FinderUsageRecord => ({
  id: at,
  at,
  query: 'q',
  model: 'gpt-6.1-sol',
  target: 10,
  found: 10,
  rounds: 1,
  stopped: 'done',
  usage: { requests: 1, inputTokens: 0, cachedTokens: 0, outputTokens: 0, webSearchCalls: 0 },
  estimatedCost,
  priceKnown,
});

describe('estimating OpenAI cost', () => {
  it('reads tokens and web search calls from an answer', () => {
    expect(
      responseUsage(answer({ input_tokens: 12000, input_tokens_details: { cached_tokens: 2000 }, output_tokens: 3000 }, 3)),
    ).toEqual({ requests: 1, inputTokens: 12000, cachedTokens: 2000, outputTokens: 3000, webSearchCalls: 3 });
    expect(responseUsage({})).toEqual({ requests: 1, inputTokens: 0, cachedTokens: 0, outputTokens: 0, webSearchCalls: 0 });
  });

  it('prices tokens at list prices and web searches at $10 per 1,000', () => {
    // gpt-6.1-sol: $2 input, $0.10 cached, $10 output per 1M tokens.
    const usage = { requests: 1, inputTokens: 1_000_000, cachedTokens: 500_000, outputTokens: 100_000, webSearchCalls: 20 };
    const { cost, complete } = estimateCost('gpt-6.1-sol', usage);
    expect(complete).toBe(true);
    expect(cost).toBeCloseTo(1 + 0.05 + 1 + 0.2, 6);
    expect(priceFor('gpt-6.1-sol-2026-08-01')).toEqual(priceFor('gpt-6.1-sol'));
    expect(priceFor('gpt-6.1-solar')).toBeNull();
    // Unknown model: only the web searches can be priced.
    expect(estimateCost('my-custom-model', usage)).toEqual({ cost: 0.2, complete: false });
  });

  it('adds up every search a finder runs, including failed answers', async () => {
    const fake = new FakeFetch()
      .reply(200, answer({ input_tokens: 1000, output_tokens: 100 }, 2))
      .reply(200, { ...answer({ input_tokens: 500, output_tokens: 50 }, 1), status: 'failed' })
      .reply(500, { error: { message: 'server error' } });
    const finder = new ContactFinder('sk-test-key-123456789012', 'gpt-6.1-sol', new MemoryLogger(), fake.fetch);
    await finder.search('x y z', 5);
    await expect(finder.search('x y z', 5)).rejects.toThrow();
    await expect(finder.search('x y z', 5)).rejects.toThrow();
    expect(finder.usage()).toEqual({ requests: 2, inputTokens: 1500, cachedTokens: 0, outputTokens: 150, webSearchCalls: 3 });
  });

  it('formats small amounts so they do not read as free', () => {
    expect(formatUsd(0)).toBe('$0.00');
    expect(formatUsd(0.0031)).toBe('$0.0031');
    expect(formatUsd(1.234)).toBe('$1.23');
  });
});

describe('totals by day, week and month', () => {
  it('groups in local time, weeks starting on Monday', () => {
    // Sunday 4 Oct 2026 belongs to the week starting Monday 28 Sep; Monday 5 Oct starts a new week.
    expect(periodStart(new Date(2026, 9, 4, 23), 'week')).toEqual(new Date(2026, 8, 28));
    expect(periodStart(new Date(2026, 9, 5, 1), 'week')).toEqual(new Date(2026, 9, 5));
    expect(periodStart(new Date(2026, 9, 5, 15), 'month')).toEqual(new Date(2026, 9, 1));

    const records = [
      record(new Date(2026, 8, 30, 9).toISOString(), 0.5),
      record(new Date(2026, 9, 4, 9).toISOString(), 0.25),
      record(new Date(2026, 9, 5, 9).toISOString(), 1),
      record(new Date(2026, 9, 5, 18).toISOString(), 0.1, false),
    ];
    const now = new Date(2026, 9, 5, 20);
    expect(currentTotal(records, 'day', now)).toMatchObject({ searches: 2, partial: true });
    expect(currentTotal(records, 'day', now).cost).toBeCloseTo(1.1);
    expect(currentTotal(records, 'week', now).cost).toBeCloseTo(1.1);
    expect(totalsBy(records, 'week').map((t) => [t.start.getDate(), t.searches])).toEqual([
      [5, 2],
      [28, 2],
    ]);
    expect(currentTotal(records, 'month', now).cost).toBeCloseTo(1.35);
    expect(totalsBy(records, 'month').map((t) => [t.start.getMonth(), t.searches])).toEqual([
      [9, 3],
      [8, 1],
    ]);
    expect(currentTotal([], 'day', now)).toMatchObject({ searches: 0, cost: 0 });
  });
});

describe('saved cost history', () => {
  it('keeps runs on this computer, newest first, and can be cleared', () => {
    const repo = createMemorySettingsRepository();
    let n = 0;
    const log = new FinderUsageLog(repo, () => `id${++n}`);
    const { id: _a, ...first } = record('2026-10-01T10:00:00.000Z', 0.2);
    const { id: _b, ...second } = record('2026-10-02T10:00:00.000Z', 0.3);
    log.add(first);
    log.add(second);
    expect(log.list().map((r) => r.id)).toEqual(['id2', 'id1']);
    log.clear();
    expect(log.list()).toEqual([]);
  });

  it('drops the oldest runs beyond the limit', () => {
    const repo = createMemorySettingsRepository({
      finderUsage: Array.from({ length: MAX_USAGE_RECORDS }, (_, i) => record(`old${i}`, 0)),
    });
    new FinderUsageLog(repo, () => 'new').add(record('x', 1));
    const all = repo.get('finderUsage');
    expect(all).toHaveLength(MAX_USAGE_RECORDS);
    expect(all[0]?.id).toBe('old1');
    expect(all.at(-1)?.id).toBe('new');
  });
});

describe('keeping search results for later', () => {
  const result = (found: number): FinderSearchResult => ({
    contacts: Array.from({ length: found }, (_, i) => ({
      name: `P${i}`,
      email: `p${i}@acme.com`,
      organization: 'Acme',
      role: 'HR',
      sourceUrl: 'https://acme.com/team',
      emailOnPage: 'yes' as const,
    })),
    dropped: { invalid: 0, noSource: 0, duplicate: 0, alreadyInSheet: 0, notOnPage: 0 },
    rounds: 1,
    target: 5,
    found,
    stopped: 'done',
    checkedAgainstSheet: true,
    cost: { model: 'gpt-6.1-sol', usage: { requests: 1, inputTokens: 0, cachedTokens: 0, outputTokens: 0, webSearchCalls: 1 }, estimatedCost: 0.01, priceKnown: true },
  });

  it('lists recent searches newest first and reopens their contacts', () => {
    const store = new FinderResultStore(createMemorySettingsRepository());
    store.add({ id: 'a', at: '2026-10-05T10:00:00.000Z', query: 'HR in Austin', result: result(2) });
    store.add({ id: 'b', at: '2026-10-05T11:00:00.000Z', query: 'CTOs in Toronto', result: result(3) });
    expect(store.list().map((s) => [s.id, s.found, s.estimatedCost])).toEqual([
      ['b', 3, 0.01],
      ['a', 2, 0.01],
    ]);
    expect(store.get('a')?.result.contacts.map((c) => c.email)).toEqual(['p0@acme.com', 'p1@acme.com']);
    expect(store.get('missing')).toBeNull();
  });

  it('keeps only the latest searches', () => {
    const repo = createMemorySettingsRepository();
    const store = new FinderResultStore(repo);
    for (let i = 0; i < MAX_SAVED_SEARCHES + 3; i++) store.add({ id: `s${i}`, at: '2026-10-05T10:00:00.000Z', query: 'q', result: result(1) });
    expect(repo.get('finderResults')).toHaveLength(MAX_SAVED_SEARCHES);
    expect(store.list()[0]?.id).toBe(`s${MAX_SAVED_SEARCHES + 2}`);
    expect(store.get('s0')).toBeNull();
  });
});

describe('model choices', () => {
  it('offers only models with a known price, including the default', async () => {
    const { OPENAI_MODEL_CHOICES } = await import('../shared/usage');
    const { DEFAULT_OPENAI_MODEL } = await import('../shared/constants');
    expect(OPENAI_MODEL_CHOICES.map((m) => m.id)).toContain(DEFAULT_OPENAI_MODEL);
    for (const m of OPENAI_MODEL_CHOICES) expect(priceFor(m.id)).not.toBeNull();
  });
});
