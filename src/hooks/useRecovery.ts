import { useCallback, useState } from 'react';
import type { RecoveryApplyInput } from '@shared/schemas';
import type { RecoveryState } from '@shared/types';
import { api, errorMessage } from '@/lib/utils';

export function useRecovery() {
  const [state, setState] = useState<RecoveryState | null>(null);
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState('');

  const scan = useCallback(async () => {
    setScanning(true);
    try {
      setState(await api().recovery.scan());
      setError('');
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setScanning(false);
    }
  }, []);

  const apply = useCallback(
    async (input: RecoveryApplyInput) => {
      const result = await api().recovery.apply(input);
      await scan();
      return result;
    },
    [scan],
  );

  const dismiss = useCallback(
    async (id: string) => {
      await api().recovery.dismissReview(id);
      await scan();
    },
    [scan],
  );

  const attentionCount = state ? state.staleContacts.length + state.manualReview.length : 0;

  return { state, scanning, error, scan, apply, dismiss, attentionCount };
}

export type RecoveryHook = ReturnType<typeof useRecovery>;
