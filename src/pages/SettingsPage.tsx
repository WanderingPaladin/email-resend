import { useEffect, useState } from 'react';
import {
  MAX_BATCH_SIZE,
  MAX_CONCURRENCY,
  MAX_SENDS_PER_SECOND,
  MIN_BATCH_SIZE,
  MIN_CONCURRENCY,
  MIN_SENDS_PER_SECOND,
  EMAIL_PROVIDER_LABELS,
} from '@shared/constants';
import { ConnectionStatus } from '@/components/ConnectionStatus';
import { GoogleSheetSettings } from '@/components/GoogleSheetSettings';
import { EmailProviderSettings } from '@/components/EmailProviderSettings';
import { OpenAiSettings } from '@/components/OpenAiSettings';
import { Alert } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { BatchSizeInput } from '@/components/BatchSizeInput';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { Field, Input } from '@/components/ui/form';
import type { ConfigHook } from '@/hooks/useConfig';
import { errorMessage } from '@/lib/utils';

export function SettingsPage({ configHook, onSaved }: { configHook: ConfigHook; onSaved: () => void }) {
  const { config } = configHook;
  const googleReady = Boolean(
    config?.settings.spreadsheetId && config.settings.serviceAccountEmail && config.hasGooglePrivateKey,
  );
  const provider = config?.settings.emailProvider ?? 'resend';
  const mailerReady = Boolean(
    config &&
      (provider === 'mailjet'
        ? config.hasMailjetApiKey && config.hasMailjetSecretKey
        : provider === 'elasticemail'
          ? config.hasElasticEmailApiKey
          : config.hasResendApiKey),
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
                label: EMAIL_PROVIDER_LABELS[provider],
                value: mailerReady ? 'Configured' : 'Not configured',
                tone: mailerReady ? 'success' : 'warning',
              },
              {
                label: 'Spreadsheet',
                value: config?.settings.spreadsheetId ? 'Set' : 'Not set',
                tone: config?.settings.spreadsheetId ? 'success' : 'neutral',
              },
            ]}
          />
        </CardBody>
      </Card>
      <GoogleSheetSettings configHook={configHook} onSaved={onSaved} />
      <EmailProviderSettings configHook={configHook} onSaved={onSaved} />
      <OpenAiSettings configHook={configHook} />
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

  const stored = config?.settings;
  useEffect(() => {
    if (!stored) return;
    setBatchSize(String(stored.batchSize));
    setConcurrency(String(stored.concurrency));
    setSendsPerSecond(String(stored.sendsPerSecond));
    setFirstNameFallback(stored.firstNameFallback);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stored?.batchSize, stored?.concurrency, stored?.sendsPerSecond, stored?.firstNameFallback]);

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
          <Field label="Default batch size" hint={`Emails per campaign, ${MIN_BATCH_SIZE}–${MAX_BATCH_SIZE.toLocaleString()}`}>
            <BatchSizeInput value={batchSize} onChange={setBatchSize} />
          </Field>
          <Field label="Concurrency" hint={`${MIN_CONCURRENCY}–${MAX_CONCURRENCY} parallel sends`}>
            <Input type="number" min={MIN_CONCURRENCY} max={MAX_CONCURRENCY} value={concurrency} onChange={(e) => setConcurrency(e.target.value)} />
          </Field>
          <Field label="Sends per Second" hint="Stay within your provider's rate limit">
            <Input
              type="number"
              min={MIN_SENDS_PER_SECOND}
              max={MAX_SENDS_PER_SECOND}
              value={sendsPerSecond}
              onChange={(e) => setSendsPerSecond(e.target.value)}
            />
          </Field>
          <Field label="First Name Fallback" hint="Used when the name is empty">
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
