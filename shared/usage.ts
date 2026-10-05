/**
 * OpenAI cost estimates for Find Contacts. These are estimates from OpenAI's list prices and the token
 * counts OpenAI reports with each answer; the OpenAI billing page has the exact charges.
 */

/** Tokens and web searches used by one or more OpenAI requests. */
export interface SearchUsage {
  /** OpenAI requests that returned an answer (retries that failed before answering cost nothing). */
  requests: number;
  /** All input tokens, including cached ones and the web pages the model read. */
  inputTokens: number;
  cachedTokens: number;
  /** All output tokens, including reasoning. */
  outputTokens: number;
  webSearchCalls: number;
}

/** US dollars per 1 million tokens. */
export interface ModelPrice {
  input: number;
  cachedInput: number;
  output: number;
}

/** OpenAI list prices (standard tier, short context) as of October 2026. */
export const OPENAI_PRICES: Record<string, ModelPrice> = {
  'gpt-6-astra': { input: 10, cachedInput: 1, output: 50 },
  'gpt-6.1-sol': { input: 2, cachedInput: 0.1, output: 10 },
  'gpt-6-luna': { input: 0.1, cachedInput: 0.01, output: 0.5 },
  'gpt-5.6-sol': { input: 4, cachedInput: 0.4, output: 20 },
};

/** Models offered in the model pickers, cheapest first. Any other OpenAI model name can still be typed in. */
export const OPENAI_MODEL_CHOICES: { id: string; label: string }[] = [
  { id: 'gpt-6-luna', label: 'GPT-6 Luna: cheapest, fastest' },
  { id: 'gpt-6.1-sol', label: 'GPT-6.1 Sol: balanced (recommended)' },
  { id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol: previous generation' },
  { id: 'gpt-6-astra', label: 'GPT-6 Astra: most capable, most expensive' },
];

/** Web search tool calls, US dollars per call ($10 per 1,000 calls). */
export const WEB_SEARCH_PRICE_PER_CALL = 0.01;

export const PRICES_AS_OF = 'October 2026';

export function emptyUsage(): SearchUsage {
  return { requests: 0, inputTokens: 0, cachedTokens: 0, outputTokens: 0, webSearchCalls: 0 };
}

export function addUsage(a: SearchUsage, b: SearchUsage): SearchUsage {
  return {
    requests: a.requests + b.requests,
    inputTokens: a.inputTokens + b.inputTokens,
    cachedTokens: a.cachedTokens + b.cachedTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    webSearchCalls: a.webSearchCalls + b.webSearchCalls,
  };
}

/** The price for a model name, also matching dated snapshots such as "gpt-6.1-sol-2026-08-01". */
export function priceFor(model: string): ModelPrice | null {
  const name = model.trim().toLowerCase();
  let best: string | null = null;
  for (const key of Object.keys(OPENAI_PRICES)) {
    if ((name === key || name.startsWith(`${key}-`)) && (!best || key.length > best.length)) best = key;
  }
  return best ? OPENAI_PRICES[best]! : null;
}

/**
 * Estimated cost in US dollars. For a model without a known price only the web searches are
 * counted, and `complete` is false.
 */
export function estimateCost(model: string, usage: SearchUsage): { cost: number; complete: boolean } {
  const searches = usage.webSearchCalls * WEB_SEARCH_PRICE_PER_CALL;
  const price = priceFor(model);
  if (!price) return { cost: searches, complete: usage.inputTokens + usage.outputTokens === 0 };
  const cached = Math.min(usage.cachedTokens, usage.inputTokens);
  const tokens = ((usage.inputTokens - cached) * price.input + cached * price.cachedInput + usage.outputTokens * price.output) / 1_000_000;
  return { cost: tokens + searches, complete: true };
}

/** One Find Contacts run, saved on this computer. */
export interface FinderUsageRecord {
  id: string;
  /** ISO time the run finished. */
  at: string;
  query: string;
  model: string;
  target: number;
  found: number;
  rounds: number;
  stopped: 'done' | 'cancelled' | 'no_more_results' | 'error';
  usage: SearchUsage;
  /** Estimated US dollars. */
  estimatedCost: number;
  /** False when the model's token price is unknown, so only web searches are counted. */
  priceKnown: boolean;
}

export type UsagePeriod = 'day' | 'week' | 'month';

/** Start of the day, week (Monday) or month containing `date`, in local time. */
export function periodStart(date: Date, period: UsagePeriod): Date {
  const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  if (period === 'week') d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  if (period === 'month') d.setDate(1);
  return d;
}

export interface UsageTotal {
  /** Local start of the period. */
  start: Date;
  searches: number;
  cost: number;
  /** True when some run used a model without a known price. */
  partial: boolean;
}

/** Totals per day, week or month, newest first. Periods with no searches are left out. */
export function totalsBy(records: readonly FinderUsageRecord[], period: UsagePeriod): UsageTotal[] {
  const groups = new Map<number, UsageTotal>();
  for (const record of records) {
    const start = periodStart(new Date(record.at), period);
    const total = groups.get(start.getTime()) ?? { start, searches: 0, cost: 0, partial: false };
    total.searches++;
    total.cost += record.estimatedCost;
    total.partial ||= !record.priceKnown;
    groups.set(start.getTime(), total);
  }
  return [...groups.values()].sort((a, b) => b.start.getTime() - a.start.getTime());
}

/** The total for the period containing `now` (today, this week or this month). */
export function currentTotal(records: readonly FinderUsageRecord[], period: UsagePeriod, now = new Date()): UsageTotal {
  const start = periodStart(now, period);
  return totalsBy(records, period).find((t) => t.start.getTime() === start.getTime()) ?? { start, searches: 0, cost: 0, partial: false };
}

/** "$0.42", or "$0.0031" for small amounts so a cheap search does not read as free. */
export function formatUsd(amount: number): string {
  if (amount === 0) return '$0.00';
  if (amount < 0.01) return `$${amount.toFixed(4)}`;
  return `$${amount.toFixed(2)}`;
}
