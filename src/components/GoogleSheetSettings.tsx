import { useEffect, useState } from 'react';
import type { GoogleTestResult } from '@shared/types';
import { Alert } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { Field, Input, Textarea } from '@/components/ui/form';
import type { ConfigHook } from '@/hooks/useConfig';
import { api, errorMessage } from '@/lib/utils';

export function GoogleSheetSettings({ configHook, onSaved }: { configHook: ConfigHook; onSaved: () => void }) {
  const { config, save, importServiceAccount } = configHook;
  const [spreadsheetId, setSpreadsheetId] = useState('');
  const [worksheetName, setWorksheetName] = useState('');
  const [serviceAccountEmail, setServiceAccountEmail] = useState('');
  // The stored private key is never sent to the renderer. This field only accepts a new one.
  const [privateKey, setPrivateKey] = useState('');
  const [busy, setBusy] = useState<'' | 'save' | 'import' | 'test' | 'init'>('');
  const [message, setMessage] = useState<{ tone: 'success' | 'error' | 'warning'; text: string } | null>(null);
  const [test, setTest] = useState<GoogleTestResult | null>(null);

  useEffect(() => {
    if (!config) return;
    setSpreadsheetId(config.settings.spreadsheetId);
    setWorksheetName(config.settings.worksheetName);
    setServiceAccountEmail(config.settings.serviceAccountEmail);
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

  const onSave = () =>
    run('save', async () => {
      await save({
        settings: { spreadsheetId: extractSpreadsheetId(spreadsheetId), worksheetName, serviceAccountEmail },
        ...(privateKey.trim() ? { googlePrivateKey: privateKey } : {}),
      });
      setPrivateKey('');
      setMessage({ tone: 'success', text: 'Google Sheets settings saved.' });
      onSaved();
    });

  const onImport = () =>
    run('import', async () => {
      const result = await importServiceAccount();
      if (result.imported) {
        setMessage({ tone: 'success', text: `Imported service account ${result.clientEmail}. The key is stored encrypted.` });
        onSaved();
      }
    });

  const onTest = () =>
    run('test', async () => {
      setTest(null);
      const result = await api().google.testConnection();
      setTest(result);
    });

  const onInit = () =>
    run('init', async () => {
      const { added } = await api().google.initializeTrackingColumns();
      setMessage({ tone: 'success', text: added.length ? `Added columns: ${added.join(', ')}` : 'All tracking columns already exist.' });
      setTest(await api().google.testConnection());
    });

  return (
    <Card>
      <CardHeader
        title="Google Sheets"
        description="The service account needs Editor access to the spreadsheet."
        actions={
          <Button size="sm" variant="outline" onClick={onImport} loading={busy === 'import'}>
            Import Service Account JSON
          </Button>
        }
      />
      <CardBody className="space-y-4">
        <div className="grid grid-cols-2 gap-4">
          <Field label="Spreadsheet ID" hint="The long ID from the sheet URL. You can paste the whole URL.">
            <Input value={spreadsheetId} onChange={(e) => setSpreadsheetId(e.target.value)} placeholder="1AbC…" />
          </Field>
          <Field label="Worksheet Name">
            <Input value={worksheetName} onChange={(e) => setWorksheetName(e.target.value)} placeholder="Emails" />
          </Field>
        </div>
        <Field label="Service Account Email">
          <Input
            value={serviceAccountEmail}
            onChange={(e) => setServiceAccountEmail(e.target.value)}
            placeholder="sender@project.iam.gserviceaccount.com"
          />
        </Field>
        <Field
          label="Private Key"
          hint={
            config?.hasGooglePrivateKey
              ? 'A private key is stored (encrypted). Paste a new one only to replace it.'
              : 'Paste the private_key value, or use Import Service Account JSON.'
          }
        >
          <Textarea
            rows={3}
            value={privateKey}
            onChange={(e) => setPrivateKey(e.target.value)}
            placeholder={config?.hasGooglePrivateKey ? '•••••••• stored' : '-----BEGIN PRIVATE KEY-----'}
            spellCheck={false}
            autoComplete="off"
            className="font-mono text-xs"
          />
        </Field>

        {message && <Alert tone={message.tone}>{message.text}</Alert>}
        {test && (
          <Alert tone="success" title="Connected successfully.">
            {`Spreadsheet: ${test.spreadsheetTitle}\nWorksheet: ${test.worksheetName}\nRows: ${test.rowCount.toLocaleString()}\nNew: ${test.newCount.toLocaleString()}`}
          </Alert>
        )}
        {test && test.missingTrackingColumns.length > 0 && (
          <Alert
            tone="warning"
            title="Tracking columns are missing"
            actions={
              <Button size="sm" variant="outline" onClick={onInit} loading={busy === 'init'}>
                Add Columns
              </Button>
            }
          >
            {`The app records each send in these columns: ${test.missingTrackingColumns.join(', ')}.\nThey will be added to the right of your existing headers. No data is moved.`}
          </Alert>
        )}

        <div className="flex gap-2">
          <Button onClick={onSave} loading={busy === 'save'}>
            Save
          </Button>
          <Button variant="outline" onClick={onTest} loading={busy === 'test'}>
            Test Google Sheets
          </Button>
        </div>
      </CardBody>
    </Card>
  );
}

/** Accepts either a bare ID or a full https://docs.google.com/spreadsheets/d/<id>/edit URL. */
function extractSpreadsheetId(value: string): string {
  const match = /\/spreadsheets\/d\/([A-Za-z0-9_-]+)/.exec(value);
  return (match?.[1] ?? value).trim();
}
