import { useEffect, useState } from 'react';
import { Alert } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { Field, Input } from '@/components/ui/form';
import type { ConfigHook } from '@/hooks/useConfig';
import { api, errorMessage } from '@/lib/utils';

export function ResendSettings({ configHook, onSaved }: { configHook: ConfigHook; onSaved: () => void }) {
  const { config, save } = configHook;
  const [apiKey, setApiKey] = useState('');
  const [fromName, setFromName] = useState('');
  const [fromEmail, setFromEmail] = useState('');
  const [busy, setBusy] = useState<'' | 'save' | 'validate' | 'remove'>('');
  const [message, setMessage] = useState<{ tone: 'success' | 'error' | 'warning'; text: string } | null>(null);

  useEffect(() => {
    if (!config) return;
    setFromName(config.settings.fromName);
    setFromEmail(config.settings.fromEmail);
  }, [config]);

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
      <CardHeader title="Resend" description="Emails are sent from a domain you have verified in Resend." />
      <CardBody className="space-y-4">
        <Field
          label="API Key"
          hint={config?.hasResendApiKey ? 'An API key is stored (encrypted). Enter a new one only to replace it.' : 'Starts with re_'}
        >
          <Input
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder={config?.hasResendApiKey ? '•••••••• stored' : 're_…'}
            autoComplete="off"
            spellCheck={false}
          />
        </Field>
        <div className="grid grid-cols-2 gap-4">
          <Field label="From Name">
            <Input value={fromName} onChange={(e) => setFromName(e.target.value)} placeholder="Julio" />
          </Field>
          <Field label="From Email">
            <Input value={fromEmail} onChange={(e) => setFromEmail(e.target.value)} placeholder="julio@yourdomain.com" />
          </Field>
        </div>
        {message && <Alert tone={message.tone}>{message.text}</Alert>}
        <div className="flex gap-2">
          <Button
            loading={busy === 'save'}
            onClick={() =>
              run('save', async () => {
                await save({ settings: { fromName, fromEmail }, ...(apiKey.trim() ? { resendApiKey: apiKey } : {}) });
                setApiKey('');
                setMessage({ tone: 'success', text: 'Resend settings saved.' });
                onSaved();
              })
            }
          >
            Save
          </Button>
          <Button
            variant="outline"
            loading={busy === 'validate'}
            onClick={() =>
              run('validate', async () => {
                const result = await api().resend.validate();
                setMessage({ tone: result.fromDomainVerified === false ? 'warning' : 'success', text: result.message });
              })
            }
          >
            Validate Resend Configuration
          </Button>
          {config?.hasResendApiKey && (
            <Button
              variant="ghost"
              loading={busy === 'remove'}
              onClick={() =>
                run('remove', async () => {
                  await save({ resendApiKey: null });
                  setMessage({ tone: 'success', text: 'API key removed.' });
                  onSaved();
                })
              }
            >
              Remove Key
            </Button>
          )}
        </div>
      </CardBody>
    </Card>
  );
}
