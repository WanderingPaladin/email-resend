import { useCallback, useEffect, useState } from 'react';
import type { AppStatus } from '@shared/types';
import { api } from '@/lib/utils';

export function useAppStatus() {
  const [status, setStatus] = useState<AppStatus | null>(null);

  const reload = useCallback(async () => {
    try {
      setStatus(await api().app.getStatus());
    } catch {
      // Status is informational; the dashboard shows placeholders until it loads.
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { status, reload };
}
