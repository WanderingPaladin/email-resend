import { useEffect, useMemo, useState } from 'react';
import {
  currentTotal,
  formatUsd,
  OPENAI_PRICES,
  PRICES_AS_OF,
  totalsBy,
  WEB_SEARCH_PRICE_PER_CALL,
  type FinderUsageRecord,
  type UsagePeriod,
  type UsageTotal,
} from '@shared/usage';
import { Alert, Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { Field, Select } from '@/components/ui/form';
import { api, errorMessage } from '@/lib/utils';

const STOPPED: Record<FinderUsageRecord['stopped'], string> = {
  done: 'Finished',
  cancelled: 'Cancelled',
  no_more_results: 'No more results',
  error: 'Error',
};

const PERIOD_LABEL: Record<UsagePeriod, string> = { day: 'Day', week: 'Week (starts Monday)', month: 'Month' };

function periodName(start: Date, period: UsagePeriod): string {
  if (period === 'month') return start.toLocaleDateString(undefined, { year: 'numeric', month: 'long' });
  const day = start.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric', weekday: period === 'day' ? 'short' : undefined });
  return period === 'week' ? `Week of ${day}` : day;
}

function money(total: { cost: number; partial: boolean }): string {
  return formatUsd(total.cost) + (total.partial ? '+' : '');
}

const n = (value: number) => value.toLocaleString();

export function SearchCostsPage() {
  const [records, setRecords] = useState<FinderUsageRecord[]>([]);
  const [period, setPeriod] = useState<UsagePeriod>('day');
  const [error, setError] = useState<string | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);

  const load = async () => {
    try {
      setRecords(await api().finder.usage());
      setError(null);
    } catch (e) {
      setError(errorMessage(e));
    }
  };
  useEffect(() => {
    void load();
  }, []);

  const totals = useMemo(() => totalsBy(records, period), [records, period]);
  const cards: { label: string; total: UsageTotal }[] = [
    { label: 'Today', total: currentTotal(records, 'day') },
    { label: 'This week', total: currentTotal(records, 'week') },
    { label: 'This month', total: currentTotal(records, 'month') },
    {
      label: 'All time',
      total: {
        start: new Date(0),
        searches: records.length,
        cost: records.reduce((sum, r) => sum + r.estimatedCost, 0),
        partial: records.some((r) => !r.priceKnown),
      },
    },
  ];
  const anyPartial = records.some((r) => !r.priceKnown);

  const clear = async () => {
    try {
      await api().finder.clearUsage();
      setConfirmClear(false);
      await load();
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  return (
    <>
      <h1 className="text-xl font-semibold">Search Costs</h1>
      <Alert tone="info">
        These are estimates. They are worked out from the tokens and web searches OpenAI reports for each search, at OpenAI&apos;s list
        prices ({PRICES_AS_OF}). Your OpenAI billing page shows the exact charges. Only searches run in this app on this computer are counted.
      </Alert>
      {error && <Alert tone="error">{error}</Alert>}

      <div className="grid grid-cols-4 gap-3">
        {cards.map(({ label, total }) => (
          <Card key={label}>
            <CardBody>
              <div className="text-xs text-slate-500">{label}</div>
              <div className="mt-1 text-2xl font-semibold">{money(total)}</div>
              <div className="text-xs text-slate-500">{`${total.searches} search run(s)`}</div>
            </CardBody>
          </Card>
        ))}
      </div>

      <Card>
        <CardHeader
          title="Totals"
          actions={
            <Field label="Group by" className="w-52">
              <Select value={period} onChange={(e) => setPeriod(e.target.value as UsagePeriod)}>
                {(Object.keys(PERIOD_LABEL) as UsagePeriod[]).map((p) => (
                  <option key={p} value={p}>
                    {PERIOD_LABEL[p]}
                  </option>
                ))}
              </Select>
            </Field>
          }
        />
        <CardBody>
          {totals.length === 0 ? (
            <p className="text-sm text-slate-500">No searches yet. Costs appear here after you run a search on the Find Contacts page.</p>
          ) : (
            <div className="max-h-72 overflow-y-auto rounded-md border border-slate-200">
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-slate-50 text-left text-xs text-slate-600">
                  <tr>
                    <th className="px-3 py-2 font-medium">{PERIOD_LABEL[period].replace(/ \(.*\)/, '')}</th>
                    <th className="px-3 py-2 text-right font-medium">Search runs</th>
                    <th className="px-3 py-2 text-right font-medium">Estimated cost</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {totals.map((t) => (
                    <tr key={t.start.getTime()}>
                      <td className="px-3 py-1.5">{periodName(t.start, period)}</td>
                      <td className="px-3 py-1.5 text-right">{t.searches}</td>
                      <td className="px-3 py-1.5 text-right font-medium">{money(t)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title="Each search"
          description="One row per click of Search, including every OpenAI request it made until it stopped."
          actions={
            records.length > 0 &&
            (confirmClear ? (
              <>
                <span className="text-xs text-slate-600">Delete the whole cost history?</span>
                <Button size="sm" variant="outline" onClick={() => setConfirmClear(false)}>
                  Keep
                </Button>
                <Button size="sm" onClick={() => void clear()}>
                  Delete
                </Button>
              </>
            ) : (
              <Button size="sm" variant="outline" onClick={() => setConfirmClear(true)}>
                Clear history
              </Button>
            ))
          }
        />
        <CardBody>
          {records.length === 0 ? (
            <p className="text-sm text-slate-500">No searches yet.</p>
          ) : (
            <div className="max-h-[28rem] overflow-y-auto rounded-md border border-slate-200">
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-slate-50 text-left text-xs text-slate-600">
                  <tr>
                    <th className="px-3 py-2 font-medium">When</th>
                    <th className="px-3 py-2 font-medium">Search</th>
                    <th className="px-3 py-2 font-medium">Found</th>
                    <th className="px-3 py-2 text-right font-medium">Tokens in / out</th>
                    <th className="px-3 py-2 text-right font-medium">Web searches</th>
                    <th className="px-3 py-2 text-right font-medium">Estimated cost</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {records.map((r) => (
                    <tr key={r.id}>
                      <td className="whitespace-nowrap px-3 py-1.5">{new Date(r.at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}</td>
                      <td className="px-3 py-1.5">
                        <div className="max-w-[18rem] truncate" title={r.query}>
                          {r.query}
                        </div>
                        <div className="text-xs text-slate-500">{`${r.model} · ${r.rounds} round(s)`}</div>
                      </td>
                      <td className="whitespace-nowrap px-3 py-1.5">
                        {`${r.found} of ${r.target}`}{' '}
                        {r.stopped !== 'done' && <Badge tone={r.stopped === 'error' ? 'error' : 'neutral'}>{STOPPED[r.stopped]}</Badge>}
                      </td>
                      <td className="whitespace-nowrap px-3 py-1.5 text-right">{`${n(r.usage.inputTokens)} / ${n(r.usage.outputTokens)}`}</td>
                      <td className="px-3 py-1.5 text-right">{r.usage.webSearchCalls}</td>
                      <td className="px-3 py-1.5 text-right font-medium" title={r.priceKnown ? undefined : 'Token price unknown for this model; only web searches are counted.'}>
                        {money({ cost: r.estimatedCost, partial: !r.priceKnown })}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {anyPartial && (
            <p className="mt-2 text-xs text-slate-500">
              + means the model&apos;s token price is not known to this app, so only its web searches are counted.
            </p>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Prices used" description={`OpenAI list prices, ${PRICES_AS_OF}. US dollars.`} />
        <CardBody className="text-xs text-slate-600">
          <table className="text-left">
            <thead>
              <tr>
                <th className="pr-6 font-medium">Model</th>
                <th className="pr-6 font-medium">Input / 1M tokens</th>
                <th className="pr-6 font-medium">Cached input / 1M</th>
                <th className="font-medium">Output / 1M</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(OPENAI_PRICES).map(([model, p]) => (
                <tr key={model}>
                  <td className="pr-6">{model}</td>
                  <td className="pr-6">{`$${p.input}`}</td>
                  <td className="pr-6">{`$${p.cachedInput}`}</td>
                  <td>{`$${p.output}`}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-2">
            {`Web search: $${(WEB_SEARCH_PRICE_PER_CALL * 1000).toFixed(0)} per 1,000 calls, plus the pages read, which OpenAI counts as input tokens.`}
          </p>
        </CardBody>
      </Card>
    </>
  );
}
