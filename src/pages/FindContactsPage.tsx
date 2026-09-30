import { useMemo, useState } from 'react';
import { MAX_FINDER_RESULTS } from '@shared/constants';
import type { ConfigView, FinderSearchResult, FoundContact } from '@shared/types';
import type { PageId } from '@/components/AppSidebar';
import { Alert, Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { Field, Input, Textarea } from '@/components/ui/form';
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

export function FindContactsPage({ config, onNavigate }: { config: ConfigView | null; onNavigate: (page: PageId) => void }) {
  const [query, setQuery] = useState('');
  const [maxResults, setMaxResults] = useState('20');
  const [searching, setSearching] = useState(false);
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<FinderSearchResult | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [tabName, setTabName] = useState(defaultTabName);
  const [message, setMessage] = useState<{ tone: 'success' | 'error' | 'warning'; text: string } | null>(null);

  const hasKey = Boolean(config?.hasOpenAiApiKey);
  const googleReady = Boolean(config?.settings.spreadsheetId && config.settings.serviceAccountEmail && config.hasGooglePrivateKey);
  const chosen = useMemo(() => result?.contacts.filter((c) => selected.has(c.email)) ?? [], [result, selected]);

  const search = async () => {
    setSearching(true);
    setMessage(null);
    setResult(null);
    try {
      const count = Math.min(MAX_FINDER_RESULTS, Math.max(1, Math.round(Number(maxResults)) || 20));
      const next = await api().finder.search({ query, maxResults: count });
      setResult(next);
      // Pre-select only contacts whose email was seen on the source page.
      setSelected(new Set(next.contacts.filter((c) => c.emailOnPage === 'yes').map((c) => c.email)));
      setTabName(defaultTabName());
      if (next.contacts.length === 0) setMessage({ tone: 'warning', text: 'No new contacts were found. Try describing the people differently.' });
    } catch (e) {
      setMessage({ tone: 'error', text: errorMessage(e) });
    } finally {
      setSearching(false);
    }
  };

  const save = async () => {
    setSaving(true);
    setMessage(null);
    try {
      const saved = await api().finder.save({ tabName, contacts: chosen });
      const skipped = [
        saved.skippedExisting && `${saved.skippedExisting} already in the spreadsheet`,
        saved.skippedDuplicate && `${saved.skippedDuplicate} repeated`,
      ].filter(Boolean);
      setMessage({
        tone: 'success',
        text: `Saved ${saved.rows} contact(s) to the new tab "${saved.tabName}".${skipped.length ? ` Skipped ${skipped.join(' and ')}.` : ''} Their Batch Flag is empty: set it to New for each contact you are authorized to email, then choose that tab in Settings (or copy the rows into your Emails tab) to send.`,
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
          <div className="flex items-end gap-3">
            <Field label="Maximum results" className="w-40">
              <Input type="number" min={1} max={MAX_FINDER_RESULTS} value={maxResults} onChange={(e) => setMaxResults(e.target.value)} disabled={searching} />
            </Field>
            <Button loading={searching} disabled={!hasKey || query.trim().length < 3} onClick={() => void search()}>
              Search
            </Button>
            {searching && <span className="pb-2 text-xs text-slate-500">Searching the web. This can take a minute or two.</span>}
          </div>
          <p className="text-xs text-slate-500">
            Only email contacts you are authorized to email. Results are saved with an empty Batch Flag, so nothing is sent until you review
            them and set Batch Flag to New.
          </p>
        </CardBody>
      </Card>

      {message && <Alert tone={message.tone}>{message.text}</Alert>}

      {result && result.contacts.length > 0 && (
        <Card>
          <CardHeader
            title={`${result.contacts.length} contact(s) found`}
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
              <Field label="New tab name" className="w-72">
                <Input value={tabName} onChange={(e) => setTabName(e.target.value)} />
              </Field>
              <Button loading={saving} disabled={!googleReady || chosen.length === 0 || !tabName.trim()} onClick={() => void save()}>
                Save {chosen.length} to New Tab
              </Button>
            </div>
          </CardBody>
        </Card>
      )}
    </>
  );
}
