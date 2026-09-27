import { useMemo, useState } from 'react';
import type { LogEntry } from '@shared/types';
import { Badge, type Tone } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input, Select } from '@/components/ui/form';
import { cn, formatDateTime } from '@/lib/utils';

export const LOG_FILTERS = [
  { id: 'all', label: 'All' },
  { id: 'info', label: 'Info' },
  { id: 'warn', label: 'Warning' },
  { id: 'error', label: 'Error' },
  { id: 'campaign', label: 'Campaign' },
  { id: 'google', label: 'Google Sheets' },
  { id: 'resend', label: 'Resend' },
] as const;

const LEVEL_TONE: Record<LogEntry['level'], Tone> = { debug: 'neutral', info: 'info', warn: 'warning', error: 'error' };
const CATEGORY_LABEL: Record<LogEntry['category'], string> = {
  app: 'App',
  config: 'Config',
  google: 'Google Sheets',
  resend: 'Resend',
  campaign: 'Campaign',
  ipc: 'IPC',
};

function matchesFilter(entry: LogEntry, filter: string): boolean {
  switch (filter) {
    case 'info':
    case 'warn':
    case 'error':
      return entry.level === filter;
    case 'campaign':
    case 'google':
    case 'resend':
      return entry.category === filter;
    default:
      return true;
  }
}

export function LogViewer({
  entries,
  initialFilter,
  loading,
  onRefresh,
  onClear,
  onOpenFolder,
  onCopy,
}: {
  entries: LogEntry[];
  initialFilter: string;
  loading: boolean;
  onRefresh: () => void;
  onClear: () => void;
  onOpenFolder: () => void;
  onCopy: (text: string) => void;
}) {
  const [filter, setFilter] = useState(initialFilter);
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return entries
      .filter((e) => matchesFilter(e, filter))
      .filter((e) => !q || e.message.toLowerCase().includes(q) || e.category.includes(q))
      .slice()
      .reverse();
  }, [entries, filter, search]);

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const copySelected = () => {
    const lines = entries
      .filter((e) => selected.has(e.id))
      .map((e) => `${e.timestamp} ${e.level.toUpperCase()} [${e.category}] ${e.message}`);
    onCopy(lines.join('\n'));
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Select className="w-40" value={filter} onChange={(e) => setFilter(e.target.value)}>
          {LOG_FILTERS.map((f) => (
            <option key={f.id} value={f.id}>
              {f.label}
            </option>
          ))}
        </Select>
        <Input className="w-72" placeholder="Search logs..." value={search} onChange={(e) => setSearch(e.target.value)} />
        <div className="ml-auto flex gap-2">
          <Button size="sm" variant="outline" onClick={onRefresh} loading={loading}>
            Refresh
          </Button>
          <Button size="sm" variant="outline" onClick={copySelected} disabled={selected.size === 0}>
            Copy Selected{selected.size ? ` (${selected.size})` : ''}
          </Button>
          <Button size="sm" variant="outline" onClick={onOpenFolder}>
            Open Log Folder
          </Button>
          <Button size="sm" variant="destructive" onClick={onClear}>
            Clear Logs
          </Button>
        </div>
      </div>
      <div className="text-xs text-slate-500">
        Showing {visible.length.toLocaleString()} of {entries.length.toLocaleString()} entries (latest 1,000 kept in view, newest first). Click rows to
        select.
      </div>
      <div className="max-h-[calc(100vh-15rem)] overflow-auto rounded-md border border-slate-200 bg-white">
        <table className="w-full text-xs">
          <thead className="sticky top-0 bg-slate-50 text-left text-slate-600">
            <tr>
              <th className="w-44 px-3 py-2 font-medium">Timestamp</th>
              <th className="w-20 px-3 py-2 font-medium">Level</th>
              <th className="w-28 px-3 py-2 font-medium">Category</th>
              <th className="px-3 py-2 font-medium">Message</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 font-mono">
            {visible.map((e) => (
              <tr
                key={e.id}
                onClick={() => toggle(e.id)}
                className={cn('cursor-pointer align-top hover:bg-slate-50', selected.has(e.id) && 'bg-sky-50 hover:bg-sky-50')}
              >
                <td className="whitespace-nowrap px-3 py-1.5 text-slate-500">{formatDateTime(e.timestamp)}</td>
                <td className="px-3 py-1.5">
                  <Badge tone={LEVEL_TONE[e.level]}>{e.level === 'warn' ? 'WARN' : e.level.toUpperCase()}</Badge>
                </td>
                <td className="px-3 py-1.5 font-sans text-slate-600">{CATEGORY_LABEL[e.category]}</td>
                <td className="break-all px-3 py-1.5">{e.message}</td>
              </tr>
            ))}
            {visible.length === 0 && (
              <tr>
                <td colSpan={4} className="px-3 py-6 text-center font-sans text-slate-500">
                  No log entries match.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
