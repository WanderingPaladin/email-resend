import { useCallback, useEffect, useState } from 'react';
import type { CampaignStartInput } from '@shared/schemas';
import type { CampaignProgress, CampaignSummary } from '@shared/types';
import { api } from '@/lib/utils';

/** Live campaign state. Lives at the app root so progress survives page changes. */
export function useCampaign(onFinished?: () => void) {
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<CampaignProgress | null>(null);
  const [summary, setSummary] = useState<CampaignSummary | null>(null);
  const [startedAt, setStartedAt] = useState<string>('');

  useEffect(() => {
    // Pick up a campaign that is already running (e.g. after a renderer reload).
    void api()
      .campaign.getState()
      .then((state) => {
        setRunning(state.running);
        setProgress(state.progress);
        setSummary(state.lastSummary);
      })
      .catch(() => undefined);

    const offProgress = api().campaign.onProgress((p) => setProgress(p));
    const offComplete = api().campaign.onComplete((s) => {
      setSummary(s);
      setRunning(false);
      onFinished?.();
    });
    return () => {
      offProgress();
      offComplete();
    };
  }, [onFinished]);

  const start = useCallback(async (input: CampaignStartInput) => {
    setSummary(null);
    setProgress(null);
    setStartedAt(new Date().toISOString());
    const result = await api().campaign.start(input);
    setRunning(true);
    return result;
  }, []);

  const cancel = useCallback(() => api().campaign.cancel(), []);

  const reset = useCallback(() => {
    setSummary(null);
    setProgress(null);
  }, []);

  return { running, progress, summary, startedAt, start, cancel, reset };
}

export type CampaignHook = ReturnType<typeof useCampaign>;
