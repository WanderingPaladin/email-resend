import { useCallback, useEffect, useState } from 'react';
import type { SaveConfigInput } from '@shared/schemas';
import type { ConfigView } from '@shared/types';
import { api, errorMessage } from '@/lib/utils';

export function useConfig() {
  const [config, setConfig] = useState<ConfigView | null>(null);
  const [error, setError] = useState('');

  const reload = useCallback(async () => {
    try {
      setConfig(await api().config.get());
      setError('');
    } catch (e) {
      setError(errorMessage(e));
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const save = useCallback(async (input: SaveConfigInput) => {
    const next = await api().config.save(input);
    setConfig(next);
    return next;
  }, []);

  const importServiceAccount = useCallback(async () => {
    const result = await api().config.importServiceAccount();
    if (result.imported) await reload();
    return result;
  }, [reload]);

  return { config, error, reload, save, importServiceAccount };
}

export type ConfigHook = ReturnType<typeof useConfig>;
