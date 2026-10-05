import { useEffect, useState } from 'react';
import { DEFAULT_OPENAI_MODEL } from '@shared/constants';
import type { SaveConfigInput } from '@shared/schemas';
import { Alert } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { ModelSelect } from '@/components/ModelSelect';
import { Field, Input } from '@/components/ui/form';
import type { ConfigHook } from '@/hooks/useConfig';
import { api, errorMessage } from '@/lib/utils';

/** OpenAI key and model used by Find Contacts. */
export function OpenAiSettings({ configHook }: { configHook: ConfigHook }) {
  const { config, save } = configHook;
  const [apiKey, setApiKey] = useState('');
  const [model, setModel] = useState(DEFAULT_OPENAI_MODEL);
  const [busy, setBusy] = useState<'' | 'save' | 'validate' | 'remove'>('');
  const [message, setMessage] = useState<{ tone: 'success' | 'error'; text: string } | null>(null);
  const stored = Boolean(config?.hasOpenAiApiKey);

  const storedModel = config?.settings.openaiModel;
  useEffect(() => {
    if (storedModel) setModel(storedModel);
  }, [storedModel]);

  const run = async (kind: typeof busy, fn: () => Promise<void>) => {
    setBusy(kind);
    setMessage(null);
    try {
      await fn();
    } catch (e) {
      setMessage({ tone: 'error', text: errorMessage(e) });
    } finally {
      setBusy('');
    }
  };

  return (
    <Card>
      <CardHeader
        title="OpenAI (Find Contacts)"
        description="Used to search the web for publicly listed business contacts. Create a key at platform.openai.com → API keys."
      />
      <CardBody className="space-y-4">
        <div className="grid grid-cols-2 gap-4">
          <Field label="OpenAI API Key" hint={stored ? 'Stored (encrypted). Enter a new one only to replace it.' : undefined}>
            <Input
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder={stored ? '•••••••• stored' : 'sk-…'}
              autoComplete="off"
              spellCheck={false}
            />
          </Field>
          <Field label="Model for searching" hint="You can also change it on the Find Contacts page. Other models must support web search.">
            <ModelSelect value={model} onChange={setModel} />
          </Field>
        </div>
        {message && <Alert tone={message.tone}>{message.text}</Alert>}
        <div className="flex gap-2">
          <Button
            loading={busy === 'save'}
            onClick={() =>
              run('save', async () => {
                const input: SaveConfigInput = { settings: { openaiModel: model.trim() || DEFAULT_OPENAI_MODEL } };
                if (apiKey.trim()) input.openaiApiKey = apiKey.trim();
                await save(input);
                setApiKey('');
                setMessage({ tone: 'success', text: 'OpenAI settings saved.' });
              })
            }
          >
            Save
          </Button>
          <Button
            variant="outline"
            loading={busy === 'validate'}
            disabled={!stored}
            onClick={() =>
              run('validate', async () => {
                const result = await api().finder.validate();
                setMessage({ tone: 'success', text: result.message });
              })
            }
          >
            Check OpenAI Key
          </Button>
          {stored && (
            <Button
              variant="ghost"
              loading={busy === 'remove'}
              onClick={() =>
                run('remove', async () => {
                  await save({ openaiApiKey: null });
                  setMessage({ tone: 'success', text: 'OpenAI key removed.' });
                })
              }
            >
              Remove OpenAI Key
            </Button>
          )}
        </div>
      </CardBody>
    </Card>
  );
}
