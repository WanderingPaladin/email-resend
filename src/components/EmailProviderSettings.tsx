import { useEffect, useState } from 'react';
import { EMAIL_PROVIDER_LABELS, EMAIL_PROVIDERS, type EmailProviderId } from '@shared/constants';
import type { ConfigView, SaveConfigInput } from '@shared/types';
import { Alert } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { Field, Input, Select } from '@/components/ui/form';
import type { ConfigHook } from '@/hooks/useConfig';
import { api, errorMessage } from '@/lib/utils';

type SecretField = 'resendApiKey' | 'elasticEmailApiKey' | 'mailjetApiKey' | 'mailjetSecretKey';

interface SecretSpec {
  field: SecretField;
  label: string;
  placeholder: string;
  stored: (c: ConfigView) => boolean;
}

/** The secrets each provider needs, and where to find them. */
const PROVIDERS: Record<EmailProviderId, { description: string; secrets: SecretSpec[] }> = {
  resend: {
    description: 'Emails are sent from a domain you have verified in Resend (resend.com → API Keys).',
    secrets: [{ field: 'resendApiKey', label: 'API Key', placeholder: 're_…', stored: (c) => c.hasResendApiKey }],
  },
  elasticemail: {
    description: 'Emails are sent from a domain verified in Elastic Email (Settings → Manage API Keys; allow "Send Email").',
    secrets: [{ field: 'elasticEmailApiKey', label: 'API Key', placeholder: 'Elastic Email API key', stored: (c) => c.hasElasticEmailApiKey }],
  },
  mailjet: {
    description: 'Mailjet needs both the API key and the secret key (Account settings → API Key Management). The From address must be an active Mailjet sender.',
    secrets: [
      { field: 'mailjetApiKey', label: 'API Key', placeholder: 'Mailjet API key', stored: (c) => c.hasMailjetApiKey },
      { field: 'mailjetSecretKey', label: 'Secret Key', placeholder: 'Mailjet secret key', stored: (c) => c.hasMailjetSecretKey },
    ],
  },
};

export function EmailProviderSettings({ configHook, onSaved }: { configHook: ConfigHook; onSaved: () => void }) {
  const { config, save } = configHook;
  const [provider, setProvider] = useState<EmailProviderId>('resend');
  const [secrets, setSecrets] = useState<Partial<Record<SecretField, string>>>({});
  const [fromName, setFromName] = useState('');
  const [fromEmail, setFromEmail] = useState('');
  const [busy, setBusy] = useState<'' | 'save' | 'validate' | 'remove'>('');
  const [message, setMessage] = useState<{ tone: 'success' | 'error' | 'warning'; text: string } | null>(null);

  useEffect(() => {
    if (!config) return;
    setProvider(config.settings.emailProvider);
    setFromName(config.settings.fromName);
    setFromEmail(config.settings.fromEmail);
  }, [config]);

  const spec = PROVIDERS[provider];
  const label = EMAIL_PROVIDER_LABELS[provider];
  const anyStored = Boolean(config && spec.secrets.some((s) => s.stored(config)));

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

  const onSave = () =>
    run('save', async () => {
      const input: SaveConfigInput = { settings: { emailProvider: provider, fromName, fromEmail } };
      for (const s of spec.secrets) {
        const value = secrets[s.field]?.trim();
        if (value) input[s.field] = value;
      }
      await save(input);
      setSecrets({});
      setMessage({ tone: 'success', text: `${label} settings saved. ${label} is now used for sending.` });
      onSaved();
    });

  return (
    <Card>
      <CardHeader title="Email Provider" description={spec.description} />
      <CardBody className="space-y-4">
        <div className="grid grid-cols-2 gap-4">
          <Field label="Send With" hint={config && config.settings.emailProvider !== provider ? 'Click Save to switch.' : undefined}>
            <Select
              value={provider}
              onChange={(e) => {
                setProvider(e.target.value as EmailProviderId);
                setSecrets({});
                setMessage(null);
              }}
            >
              {EMAIL_PROVIDERS.map((p) => (
                <option key={p} value={p}>
                  {EMAIL_PROVIDER_LABELS[p]}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <div className="grid grid-cols-2 gap-4">
          {spec.secrets.map((s) => {
            const stored = Boolean(config && s.stored(config));
            return (
              <Field
                key={s.field}
                label={`${label} ${s.label}`}
                hint={stored ? 'Stored (encrypted). Enter a new one only to replace it.' : undefined}
              >
                <Input
                  type="password"
                  value={secrets[s.field] ?? ''}
                  onChange={(e) => setSecrets((prev) => ({ ...prev, [s.field]: e.target.value }))}
                  placeholder={stored ? '•••••••• stored' : s.placeholder}
                  autoComplete="off"
                  spellCheck={false}
                />
              </Field>
            );
          })}
        </div>
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
          <Button loading={busy === 'save'} onClick={() => void onSave()}>
            Save
          </Button>
          <Button
            variant="outline"
            loading={busy === 'validate'}
            disabled={config?.settings.emailProvider !== provider}
            onClick={() =>
              run('validate', async () => {
                const result = await api().mailer.validate();
                setMessage({ tone: result.fromDomainVerified === false ? 'warning' : 'success', text: result.message });
              })
            }
          >
            Validate {label} Configuration
          </Button>
          {anyStored && (
            <Button
              variant="ghost"
              loading={busy === 'remove'}
              onClick={() =>
                run('remove', async () => {
                  const input: SaveConfigInput = {};
                  for (const s of spec.secrets) input[s.field] = null;
                  await save(input);
                  setMessage({ tone: 'success', text: `${label} keys removed.` });
                  onSaved();
                })
              }
            >
              Remove {label} Keys
            </Button>
          )}
        </div>
      </CardBody>
    </Card>
  );
}
