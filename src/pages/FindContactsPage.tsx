import { useEffect, useMemo, useState } from 'react';
import { DEFAULT_OPENAI_MODEL, MAX_FINDER_RESULTS } from '@shared/constants';
import type { SaveConfigInput } from '@shared/schemas';
import { formatUsd } from '@shared/usage';
import type { ConfigView, FinderProgress, FinderRunState, FinderSearchResult, FoundContact, SavedFinderSearchSummary } from '@shared/types';
import type { PageId } from '@/components/AppSidebar';
import { ModelSelect } from '@/components/ModelSelect';
import { Alert, Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { Field, Input, Select, Textarea } from '@/components/ui/form';
import { api, errorMessage } from '@/lib/utils';

const ON_PAGE: Record<FoundContact['emailOnPage'], { label: string; tone: 'success' | 'warning' | 'neutral'; title: string }> = {
  yes: { label: 'On page', tone: 'success', title: 'The email appears on the source page.' },
  no: { label: 'Not on page', tone: 'warning', title: 'The email was not found on the source page. It may be wrong.' },
  unknown: { label: 'Not checked', tone: 'neutral', title: 'The source page could not be opened.' },
};

function defaultTabName(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `Found ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}.${pad(d.getMinutes())}`;
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

type Message = { tone: 'success' | 'error' | 'warning'; text: string };

/**
 * What the page shows, kept outside the component so it survives switching to another page and back.
 * The search itself runs in the main process; this only remembers the form and the results on screen.
 */
const memory = {
  query: '',
  maxResults: '20',
  /** Id of the search whose results are on screen, so they are not reset when coming back. */
  shownId: null as string | null,
  result: null as FinderSearchResult | null,
  selected: new Set<string>(),
  tabName: defaultTabName(),
  destination: '',
  message: null as Message | null,
};

/** The message shown when a search ends. */
function outcomeMessage(result: FinderSearchResult): Message {
  const costNote = `Estimated OpenAI cost of this search: ${formatUsd(result.cost.estimatedCost)}${result.cost.priceKnown ? '' : ' (web searches only; token price unknown for this model)'}.`;
  if (result.found >= result.target) {
    return { tone: 'success', text: `Found ${result.found} of ${result.target} after ${result.rounds} search(es). ${costNote}` };
  }
  const why =
    result.stopped === 'cancelled'
      ? 'Search cancelled.'
      : result.stopped === 'error'
        ? `Stopped because of an OpenAI error: ${result.warning ?? 'unknown error'}`
        : 'The last 5 searches found nobody new, so the web seems to have no more matches. Try a broader description to find more.';
  return { tone: 'warning', text: `Found ${result.found} of ${result.target} after ${result.rounds} search(es). ${why} ${costNote}` };
}

export function FindContactsPage({
  config,
  saveConfig,
  onNavigate,
}: {
  config: ConfigView | null;
  saveConfig: (input: SaveConfigInput) => Promise<unknown>;
  onNavigate: (page: PageId) => void;
}) {
  const model = config?.settings.openaiModel || DEFAULT_OPENAI_MODEL;
  const [savingModel, setSavingModel] = useState(false);
  const chooseModel = async (next: string) => {
    if (next === model) return;
    setSavingModel(true);
    try {
      await saveConfig({ settings: { openaiModel: next } });
    } catch (e) {
      setMessage({ tone: 'error', text: errorMessage(e) });
    } finally {
      setSavingModel(false);
    }
  };
  const [query, setQuery] = useState(memory.query);
  const [maxResults, setMaxResults] = useState(memory.maxResults);
  const [searching, setSearching] = useState(false);
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<FinderSearchResult | null>(memory.result);
  const [selected, setSelected] = useState<Set<string>>(memory.selected);
  const [tabName, setTabName] = useState(memory.tabName);
  const [message, setMessage] = useState<Message | null>(memory.message);

  const hasKey = Boolean(config?.hasOpenAiApiKey);
  const googleReady = Boolean(config?.settings.spreadsheetId && config.settings.serviceAccountEmail && config.hasGooglePrivateKey);
  const chosen = useMemo(() => result?.contacts.filter((c) => selected.has(c.email)) ?? [], [result, selected]);

  /** '' means a new tab; otherwise the name of an existing tab to add rows to. */
  const [destination, setDestination] = useState(memory.destination);
  const [tabs, setTabs] = useState<string[]>([]);
  const [progress, setProgress] = useState<FinderProgress | null>(null);
  const [recent, setRecent] = useState<SavedFinderSearchSummary[]>([]);
  const [shownId, setShownId] = useState(memory.shownId);
  useEffect(() => api().finder.onProgress(setProgress), []);

  useEffect(() => {
    Object.assign(memory, { query, maxResults, result, selected, tabName, destination, message });
  }, [query, maxResults, result, selected, tabName, destination, message]);

  /** Puts a finished search's results on screen, with the usable contacts selected. */
  const show = (id: string, next: FinderSearchResult, note: Message | null) => {
    memory.shownId = id;
    setShownId(id);
    setResult(next);
    setSelected(new Set(next.contacts.filter((c) => c.emailOnPage !== 'no').map((c) => c.email)));
    setTabName(defaultTabName());
    setMessage(note);
  };

  const loadRecent = async () => {
    try {
      setRecent(await api().finder.recent());
    } catch {
      setRecent([]);
    }
  };

  // The search runs in the main process, so it keeps going when this page is closed. Pick it up again here.
  useEffect(() => {
    let alive = true;
    const apply = (run: FinderRunState | null) => {
      if (!alive || !run) return;
      if (run.running) {
        setSearching(true);
        setProgress(run.progress);
        setQuery(run.query);
        return;
      }
      setSearching(false);
      if (run.id === memory.shownId) return;
      memory.shownId = run.id;
      if (run.result) show(run.id, run.result, outcomeMessage(run.result));
      else if (run.error) {
        setShownId(run.id);
        setResult(null);
        setMessage({ tone: 'error', text: run.error });
      }
      void loadRecent();
    };
    void api().finder.state().then(apply, () => undefined);
    void loadRecent();
    const off = api().finder.onDone(apply);
    return () => {
      alive = false;
      off();
    };
  }, []);

  const search = async () => {
    setSearching(true);
    setMessage(null);
    setResult(null);
    setProgress(null);
    memory.shownId = null;
    setShownId(null);
    try {
      const requested = Math.round(Number(maxResults)) || 20;
      const count = Math.min(MAX_FINDER_RESULTS, Math.max(1, requested));
      if (count !== requested) setMaxResults(String(count));
      // The results arrive through onDone above, also when this page was closed and opened again meanwhile.
      await api().finder.search({ query, maxResults: count });
    } catch (e) {
      setMessage({ tone: 'error', text: errorMessage(e) });
    } finally {
      setSearching(false);
    }
  };

  const openSaved = async (id: string) => {
    try {
      const saved = await api().finder.openSaved(id);
      setQuery(saved.query);
      setDestination('');
      show(saved.id, saved.result, {
        tone: 'success',
        text: `Showing the results of your search from ${new Date(saved.at).toLocaleString()}. Contacts already in your spreadsheet are skipped when you save.`,
      });
    } catch (e) {
      setMessage({ tone: 'error', text: errorMessage(e) });
    }
  };

  const loadTabs = async () => {
    try {
      setTabs(await api().finder.listTabs());
    } catch {
      setTabs([]);
    }
  };
  useEffect(() => {
    if (result && result.contacts.length > 0 && googleReady) void loadTabs();
  }, [result, googleReady]);

  const save = async () => {
    setSaving(true);
    setMessage(null);
    try {
      const saved = await api().finder.save(
        destination ? { mode: 'existing', tabName: destination, contacts: chosen } : { mode: 'new', tabName, contacts: chosen },
      );
      void loadTabs();
      const skipped = [
        saved.skippedExisting && `${saved.skippedExisting} already in the spreadsheet`,
        saved.skippedDuplicate && `${saved.skippedDuplicate} repeated`,
      ].filter(Boolean);
      setMessage({
        tone: 'success',
        text:
          (saved.mode === 'new'
            ? `Saved ${saved.rows} contact(s) to the new tab "${saved.tabName}".`
            : `Added ${saved.rows} contact(s) below the last row of "${saved.tabName}".`) +
          (saved.addedColumns.length && saved.mode === 'existing' ? ` Added column(s): ${saved.addedColumns.join(', ')}.` : '') +
          (skipped.length ? ` Skipped ${skipped.join(' and ')}.` : '') +
          ' Their Batch Flag is New, so they will be included in the next campaign on that tab.',
      });
    } catch (e) {
      setMessage({ tone: 'error', text: errorMessage(e) });
    } finally {
      setSaving(false);
    }
  };

  const toggle = (email: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(email)) next.delete(email);
      else next.add(email);
      return next;
    });

  const dropped = result?.dropped;
  const droppedText = dropped
    ? [
        dropped.alreadyInSheet && `${dropped.alreadyInSheet} already in your spreadsheet`,
        dropped.duplicate && `${dropped.duplicate} repeated`,
        dropped.invalid && `${dropped.invalid} with an invalid email`,
        dropped.noSource && `${dropped.noSource} without a source page`,
        dropped.notOnPage && `${dropped.notOnPage} not on their source page (listed, not selected)`,
      ].filter(Boolean)
    : [];

  return (
    <>
      <h1 className="text-xl font-semibold">Find Contacts</h1>
      {(!hasKey || !googleReady) && (
        <Alert
          tone="warning"
          actions={
            <Button size="sm" variant="outline" onClick={() => onNavigate('settings')}>
              Open Settings
            </Button>
          }
        >
          {!hasKey ? 'Add your OpenAI API key in Settings to search. ' : ''}
          {!googleReady ? 'Set up Google Sheets in Settings to save results.' : ''}
        </Alert>
      )}
      <Card>
        <CardHeader
          title="Search the web"
          description="Finds people whose business email is published on a public web page, using OpenAI web search. Every result lists the page it came from."
        />
        <CardBody className="space-y-4">
          <Field label="Who are you looking for?" hint="For example: HR managers at software companies in Austin, Texas.">
            <Textarea rows={3} value={query} onChange={(e) => setQuery(e.target.value)} disabled={searching} />
          </Field>
          <div className="flex flex-wrap items-end gap-3">
            <Field label={`Number of people (up to ${MAX_FINDER_RESULTS})`} className="w-56">
              <Input type="number" min={1} max={MAX_FINDER_RESULTS} value={maxResults} onChange={(e) => setMaxResults(e.target.value)} disabled={searching} />
            </Field>
            <Field label="AI model" className="w-[34rem]">
              <ModelSelect value={model} onChange={(m) => void chooseModel(m)} disabled={searching || savingModel} />
            </Field>
            <Button loading={searching} disabled={!hasKey || savingModel || query.trim().length < 3} onClick={() => void search()}>
              Search
            </Button>
            {searching && (
              <Button variant="outline" onClick={() => void api().finder.cancel()}>
                Cancel
              </Button>
            )}
            {searching && (
              <span className="pb-2 text-xs text-slate-500">
                {progress
                  ? `Search ${progress.round + 1}: ${progress.found} of ${progress.target} found so far.` +
                    (progress.emptyInARow > 0 ? ` (${progress.emptyInARow} search(es) in a row found nobody new)` : '') +
                    (progress.estimatedCost !== undefined ? ` Estimated cost so far: ${formatUsd(progress.estimatedCost)}.` : '')
                  : 'Searching the web. Each search can take a minute or two.'}
              </span>
            )}
          </div>
          <p className="text-xs text-slate-500">
            Each search shows its estimated OpenAI cost.{' '}
            <button type="button" className="underline" onClick={() => onNavigate('costs')}>
              See totals by day, week and month
            </button>
            .{' '}
            Skipped results (already in your spreadsheet, repeated, invalid, or not on their page) do not count: the app keeps searching
            until it has your number (up to 100). It stops early only if you press Cancel or 5 searches in a row find nobody new. Saved contacts get Batch Flag New, so they are sent in the next campaign on that tab: untick anyone you are not authorized to email
            before saving.
          </p>
        </CardBody>
      </Card>

      {message && <Alert tone={message.tone}>{message.text}</Alert>}

      {result && result.contacts.length > 0 && (
        <Card>
          <CardHeader
            title={`${result.found} of ${result.target} contact(s) found in ${result.rounds} search(es) · estimated cost ${formatUsd(result.cost.estimatedCost)}${result.cost.priceKnown ? '' : '+'}`}
            description={
              [
                droppedText.length > 0 ? `Left out: ${droppedText.join(', ')}.` : '',
                result.checkedAgainstSheet ? '' : 'Your spreadsheet could not be read, so existing contacts were not left out. They are checked again when you save.',
              ]
                .filter(Boolean)
                .join(' ') || undefined
            }
          />
          <CardBody className="space-y-4">
            <div className="max-h-[28rem] overflow-y-auto rounded-md border border-slate-200">
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-slate-50 text-left text-xs text-slate-600">
                  <tr>
                    <th className="px-3 py-2">
                      <input
                        type="checkbox"
                        aria-label="Select all"
                        checked={chosen.length === result.contacts.length}
                        onChange={(e) => setSelected(e.target.checked ? new Set(result.contacts.map((c) => c.email)) : new Set())}
                      />
                    </th>
                    <th className="px-3 py-2 font-medium">Name</th>
                    <th className="px-3 py-2 font-medium">Email</th>
                    <th className="px-3 py-2 font-medium">Organization / Role</th>
                    <th className="px-3 py-2 font-medium">Source</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {result.contacts.map((c) => {
                    const onPage = ON_PAGE[c.emailOnPage];
                    return (
                      <tr key={c.email} className={selected.has(c.email) ? '' : 'text-slate-400'}>
                        <td className="px-3 py-1.5">
                          <input type="checkbox" aria-label={`Select ${c.email}`} checked={selected.has(c.email)} onChange={() => toggle(c.email)} />
                        </td>
                        <td className="px-3 py-1.5">{c.name || <span className="text-slate-400">(no name)</span>}</td>
                        <td className="px-3 py-1.5">{c.email}</td>
                        <td className="px-3 py-1.5">{[c.organization, c.role].filter(Boolean).join(' · ')}</td>
                        <td className="px-3 py-1.5">
                          <div className="flex items-center gap-2">
                            <span className="max-w-[12rem] truncate" title={c.sourceUrl}>
                              {hostOf(c.sourceUrl)}
                            </span>
                            <span title={onPage.title}>
                              <Badge tone={onPage.tone}>{onPage.label}</Badge>
                            </span>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div className="flex items-end gap-3">
              <Field label="Save to" className="w-64">
                <Select value={destination} onChange={(e) => setDestination(e.target.value)}>
                  <option value="">New tab…</option>
                  {tabs.map((t) => (
                    <option key={t} value={t}>
                      {`Existing tab: ${t}`}
                    </option>
                  ))}
                </Select>
              </Field>
              {!destination && (
                <Field label="New tab name" className="w-72">
                  <Input value={tabName} onChange={(e) => setTabName(e.target.value)} />
                </Field>
              )}
              <Button
                loading={saving}
                disabled={!googleReady || chosen.length === 0 || (!destination && !tabName.trim())}
                onClick={() => void save()}
              >
                {destination ? `Add ${chosen.length} to "${destination}"` : `Save ${chosen.length} to New Tab`}
              </Button>
            </div>
            <div className="text-xs text-slate-500">
              {destination
                ? 'Rows are added below the last row, matched to the tab’s own headers (Name or First/Last Name, Email). Missing Name, Email, Batch Flag or Source URL columns are added at the right. Existing rows are never changed.'
                : 'A new tab is created with Name, Email, Organization, Role, Source URL, Email on page, Batch Flag and the tracking columns.'}
            </div>
          </CardBody>
        </Card>
      )}

      {recent.length > 0 && (
        <Card>
          <CardHeader
            title="Recent searches"
            description="Results of your latest searches are kept on this computer, so you can open them again and save them to the sheet later."
          />
          <CardBody>
            <div className="max-h-72 overflow-y-auto rounded-md border border-slate-200">
              <table className="w-full text-sm">
                <tbody className="divide-y divide-slate-100">
                  {recent.map((r) => (
                    <tr key={r.id} className={shownId === r.id ? 'bg-slate-50' : ''}>
                      <td className="whitespace-nowrap px-3 py-1.5 text-slate-600">
                        {new Date(r.at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}
                      </td>
                      <td className="px-3 py-1.5">
                        <div className="max-w-[24rem] truncate" title={r.query}>
                          {r.query}
                        </div>
                      </td>
                      <td className="whitespace-nowrap px-3 py-1.5">{`${r.found} contact(s)`}</td>
                      <td className="whitespace-nowrap px-3 py-1.5 text-slate-600">{formatUsd(r.estimatedCost)}</td>
                      <td className="px-3 py-1.5 text-right">
                        <Button size="sm" variant="outline" disabled={searching || shownId === r.id} onClick={() => void openSaved(r.id)}>
                          {shownId === r.id ? 'Showing' : 'Open'}
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardBody>
        </Card>
      )}
    </>
  );
}
