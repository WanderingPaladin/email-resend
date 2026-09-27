import { useCallback, useEffect, useState } from 'react';
import { LOG_BUFFER_LIMIT } from '@shared/constants';
import type { LogEntry } from '@shared/types';
import { api } from '@/lib/utils';

/** Loads persisted logs once, then appends live `logger:event` entries, keeping the latest 1,000. */
export function useLogs() {
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [loading, setLoading] = useState(false);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      setEntries((await api().logs.get()).slice(-LOG_BUFFER_LIMIT));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
    return api().logs.onLog((entry) => {
      setEntries((prev) => {
        const next = prev.length >= LOG_BUFFER_LIMIT ? prev.slice(prev.length - LOG_BUFFER_LIMIT + 1) : prev.slice();
        next.push(entry);
        return next;
      });
    });
  }, [reload]);

  const clear = useCallback(async () => {
    await api().logs.clear();
    await reload();
  }, [reload]);

  return { entries, loading, reload, clear };
}

export type LogsHook = ReturnType<typeof useLogs>;
