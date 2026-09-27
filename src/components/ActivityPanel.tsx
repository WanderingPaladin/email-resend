import { useEffect, useRef } from 'react';
import type { LogEntry } from '@shared/types';
import { cn, formatTime } from '@/lib/utils';

/** Small live feed of campaign log entries shown on the Campaign page. */
export function ActivityPanel({ entries }: { entries: LogEntry[] }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.scrollTo({ top: ref.current.scrollHeight });
  }, [entries.length]);

  return (
    <div ref={ref} className="h-56 overflow-y-auto rounded-md bg-slate-900 p-3 font-mono text-xs leading-5 text-slate-200">
      {entries.length === 0 && <div className="text-slate-500">Campaign activity will appear here.</div>}
      {entries.map((e) => (
        <div key={e.id} className={cn(e.level === 'error' && 'text-red-300', e.level === 'warn' && 'text-amber-300')}>
          <span className="text-slate-500">{formatTime(e.timestamp)}</span> {e.message}
        </div>
      ))}
    </div>
  );
}
