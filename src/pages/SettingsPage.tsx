import { useEffect, useState } from 'react';
import {
  MAX_BATCH_SIZE,
  MAX_CONCURRENCY,
  MAX_SENDS_PER_SECOND,
  MIN_BATCH_SIZE,
  MIN_CONCURRENCY,
  MIN_SENDS_PER_SECOND,
} from '@shared/constants';
import { ConnectionStatus } from '@/components/ConnectionStatus';
import { GoogleSheetSettings } from '@/components/GoogleSheetSettings';
import { ResendSettings } from '@/components/ResendSettings';
import { Alert } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { Field, Input } from '@/components/ui/form';
import type { ConfigHook } from '@/hooks/useConfig';
import { errorMessage } from '@/lib/utils';

export function SettingsPage({ configHook, onSaved }: { configHook: ConfigHook; onSaved: () => void }) {
  const { config } = configHook;
  const googleReady = Boolean(
    config?.settings.spreadsheetId && config.settings.serviceAccountEmail && config.hasGooglePrivateKey,
  );
  return (
    <>
      <h1 className="text-xl font-semibold">Settings</h1>
      {config && !config.encryptionAvailable && (
        <Alert tone="error" title="Secure storage unavailable">
          This system cannot encrypt credentials, so API keys and private keys cannot be saved. On Linux, install and unlock a keyring
          such as gnome-keyring or KWallet.
        </Alert>
      )}
      <Card>
        <CardBody>
          <ConnectionStatus
            rows={[
              {
                label: 'Google Sheets',
                value: googleReady ? 'Configured' : 'Not configured',
                tone: googleReady ? 'success' : 'warning',
              },
              {
                label: 'Resend',
                value: config?.hasResendApiKey ? 'Configured' : 'Not configured',
                tone: config?.hasResendApiKey ? 'success' : 'warning',
              },
              {
                label: 'Spreadsheet',
                value: config?.settings.spreadsheetId ? `Worksheet "${config.settings.worksheetName}"` : 'Not set',
                tone: config?.settings.spreadsheetId ? 'success' : 'neutral',
              },
            ]}
          />
        </CardBody>
      </Card>
      <GoogleSheetSettings configHook={configHook} onSaved={onSaved} />
      <ResendSettings configHook={configHook} onSaved={onSaved} />
      <CampaignDefaults configHook={configHook} />
    </>
  );
}

function CampaignDefaults({ configHook }: { configHook: ConfigHook }) {
  const { config, save } = configHook;
  const [batchSize, setBatchSize] = useState('100');
  const [concurrency, setConcurrency] = useState('5');
  const [sendsPerSecond, setSendsPerSecond] = useState('2');
  const [firstNameFallback, setFirstNameFallback] = useState('there');
  const [message, setMessage] = useState<{ tone: 'success' | 'error'; text: string } | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!config) return;
    setBatchSize(String(config.settings.batchSize));
    setConcurrency(String(config.settings.concurrency));
    setSendsPerSecond(String(config.settings.sendsPerSecond));
    setFirstNameFallback(config.settings.firstNameFallback);
  }, [config]);

  const onSave = async () => {
    setSaving(true);
    setMessage(null);
    try {
      await save({
        settings: {
          batchSize: Number(batchSize),
          concurrency: Number(concurrency),
          sendsPerSecond: Number(sendsPerSecond),
          firstNameFallback,
        },
      });
      setMessage({ tone: 'success', text: 'Defaults saved.' });
    } catch (e) {
      setMessage({ tone: 'error', text: errorMessage(e) });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card>
      <CardHeader title="Campaign Defaults" />
      <CardBody className="space-y-4">
        <div className="grid grid-cols-4 gap-4">
          <Field label="Batch Size" hint={`${MIN_BATCH_SIZE}–${MAX_BATCH_SIZE}`}>
            <Input type="number" min={MIN_BATCH_SIZE} max={MAX_BATCH_SIZE} value={batchSize} onChange={(e) => setBatchSize(e.target.value)} />
          </Field>
          <Field label="Concurrency" hint={`${MIN_CONCURRENCY}–${MAX_CONCURRENCY} parallel sends`}>
            <Input type="number" min={MIN_CONCURRENCY} max={MAX_CONCURRENCY} value={concurrency} onChange={(e) => setConcurrency(e.target.value)} />
          </Field>
          <Field label="Sends per Second" hint="Stay within your Resend rate limit">
            <Input
              type="number"
              min={MIN_SENDS_PER_SECOND}
              max={MAX_SENDS_PER_SECOND}
              value={sendsPerSecond}
              onChange={(e) => setSendsPerSecond(e.target.value)}
            />
          </Field>
          <Field label="First Name Fallback" hint="Used when first_name is empty">
            <Input value={firstNameFallback} onChange={(e) => setFirstNameFallback(e.target.value)} />
          </Field>
        </div>
        {message && <Alert tone={message.tone}>{message.text}</Alert>}
        <Button onClick={onSave} loading={saving}>
          Save
        </Button>
      </CardBody>
    </Card>
  );
}
