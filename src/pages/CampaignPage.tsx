import { useCallback, useEffect, useMemo, useState } from 'react';
import { MAX_BATCH_SIZE, MAX_CONCURRENCY, MIN_BATCH_SIZE, MIN_CONCURRENCY } from '@shared/constants';
import { validateTemplate } from '@shared/template';
import type { ConfigView, LogEntry, PreviewResult } from '@shared/types';
import { ActivityPanel } from '@/components/ActivityPanel';
import type { PageId } from '@/components/AppSidebar';
import { CampaignConfirmation } from '@/components/CampaignConfirmation';
import { CampaignProgress } from '@/components/CampaignProgress';
import { CampaignResults } from '@/components/CampaignResults';
import { ContactsPreview } from '@/components/ContactsPreview';
import { EmailTemplateEditor } from '@/components/EmailTemplateEditor';
import { Alert } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { Checkbox, Field, Input } from '@/components/ui/form';
import type { CampaignHook } from '@/hooks/useCampaign';
import type { CampaignFormHook } from '@/hooks/useCampaignForm';
import { api, errorMessage } from '@/lib/utils';

type Notice = { tone: 'success' | 'error' | 'warning' | 'info'; title?: string; text: string } | null;

export function CampaignPage({
  config,
  formHook,
  campaign,
  logs,
  autoPreview,
  onNavigate,
}: {
  config: ConfigView | null;
  formHook: CampaignFormHook;
  campaign: CampaignHook;
  logs: LogEntry[];
  autoPreview: number;
  onNavigate: (page: PageId, options?: { logFilter?: string }) => void;
}) {
  const { form, update } = formHook;
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [previewError, setPreviewError] = useState('');
  const [testing, setTesting] = useState(false);
  const [testNotice, setTestNotice] = useState<Notice>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [starting, setStarting] = useState(false);
  const [startNotice, setStartNotice] = useState<Notice>(null);

  const locked = campaign.running;

  const loadPreview = useCallback(async (): Promise<PreviewResult | null> => {
    setPreviewing(true);
    setPreviewError('');
    try {
      const result = await api().google.previewContacts(clamp(form.batchSize, MIN_BATCH_SIZE, MAX_BATCH_SIZE));
      setPreview(result);
      return result;
    } catch (e) {
      setPreview(null);
      setPreviewError(errorMessage(e));
      return null;
    } finally {
      setPreviewing(false);
    }
  }, [form.batchSize]);

  useEffect(() => {
    if (autoPreview > 0) void loadPreview();
    // Only react to explicit "Preview Contacts" requests from the dashboard.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoPreview]);

  const contentError = useMemo(() => {
    if (!form.fromName.trim()) return 'From Name is required.';
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.fromEmail.trim())) return 'From Email must be a valid email address.';
    if (!form.subject.trim()) return 'Subject is required.';
    if (!form.body.trim()) return 'Email body is required.';
    return validateTemplate({ subject: form.subject, body: form.body });
  }, [form]);

  const content = () => ({
    fromName: form.fromName,
    fromEmail: form.fromEmail,
    subject: form.subject,
    body: form.body,
    bodyFormat: form.bodyFormat,
  });

  const sendTest = async () => {
    setTesting(true);
    setTestNotice(null);
    try {
      const { resendId } = await api().campaign.sendTest({ ...content(), to: form.testRecipient });
      setTestNotice({ tone: 'success', text: `Test email sent successfully.\nMessage ID: ${resendId}` });
    } catch (e) {
      setTestNotice({ tone: 'error', text: errorMessage(e) });
    } finally {
      setTesting(false);
    }
  };

  const openConfirmation = async () => {
    setStartNotice(null);
    // Always confirm against a fresh preview so the numbers in the modal match the sheet.
    const result = await loadPreview();
    if (!result) {
      setStartNotice({ tone: 'error', title: 'Campaign not started', text: 'Contacts could not be loaded. See the Contacts section.' });
    } else if (result.selected.length === 0) {
      setStartNotice({ tone: 'warning', text: 'There are no eligible New contacts to send to.' });
    } else {
      setConfirmOpen(true);
    }
  };

  const start = async () => {
    setStarting(true);
    try {
      const result = await campaign.start({
        ...content(),
        batchSize: clamp(form.batchSize, MIN_BATCH_SIZE, MAX_BATCH_SIZE),
        concurrency: clamp(form.concurrency, MIN_CONCURRENCY, MAX_CONCURRENCY),
        dryRun: form.dryRun,
      });
      setConfirmOpen(false);
      setStartNotice({ tone: 'info', text: `Campaign ${result.campaignId} started with ${result.selected} contact(s).` });
    } catch (e) {
      setConfirmOpen(false);
      setStartNotice({ tone: 'error', title: 'Campaign not started', text: errorMessage(e) });
    } finally {
      setStarting(false);
    }
  };

  const recipients = preview?.selected.length ?? 0;
  const activity = useMemo(() => {
    const since = campaign.startedAt;
    return logs.filter((l) => l.category === 'campaign' && (!since || l.timestamp >= since)).slice(-200);
  }, [logs, campaign.startedAt]);

  const summary = campaign.summary;

  return (
    <>
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Campaign</h1>
        {locked && <span className="text-sm text-emerald-700">A campaign is running</span>}
      </div>

      {(campaign.running || summary) && (
        <Card>
          <CardBody>
            {campaign.running && campaign.progress && (
              <CampaignProgress progress={campaign.progress} onCancel={() => void campaign.cancel()} />
            )}
            {campaign.running && !campaign.progress && <div className="text-sm text-slate-600">Starting…</div>}
            {!campaign.running && summary && (
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <h3 className="text-base font-semibold">
                    {summary.dryRun ? 'Dry Run Complete' : summary.cancelled ? 'Campaign Cancelled' : 'Campaign Complete'}
                  </h3>
                  <div className="flex gap-2">
                    <Button size="sm" variant="outline" onClick={() => onNavigate('logs', { logFilter: 'campaign' })}>
                      Open Logs
                    </Button>
                    <Button size="sm" variant="ghost" onClick={campaign.reset}>
                      Dismiss
                    </Button>
                  </div>
                </div>
                <div className="text-xs text-slate-500">Campaign ID: {summary.campaignId}</div>
                {summary.abortReason && <Alert tone="error">{summary.abortReason}</Alert>}
                {summary.needsReview > 0 && (
                  <Alert tone="warning">
                    {summary.needsReview} contact(s) have an unknown delivery state. They were left in Processing for manual review and
                    will not be resent automatically.
                  </Alert>
                )}
                <CampaignResults
                  totals={{
                    total: summary.selected,
                    sent: summary.sent,
                    failed: summary.failed,
                    skipped: summary.skipped,
                    needsReview: summary.needsReview,
                    notStarted: summary.notStarted,
                  }}
                  results={summary.results}
                />
              </div>
            )}
          </CardBody>
        </Card>
      )}

      {startNotice && <Alert tone={startNotice.tone} title={startNotice.title}>{startNotice.text}</Alert>}

      <Card>
        <CardHeader title="Email" />
        <CardBody className="space-y-4">
          <div className="grid grid-cols-4 gap-4">
            <Field label="From Name">
              <Input value={form.fromName} disabled={locked} onChange={(e) => update('fromName', e.target.value)} />
            </Field>
            <Field label="From Email">
              <Input value={form.fromEmail} disabled={locked} onChange={(e) => update('fromEmail', e.target.value)} />
            </Field>
            <Field label="Batch Size" hint={`${MIN_BATCH_SIZE}–${MAX_BATCH_SIZE}`}>
              <Input
                type="number"
                min={MIN_BATCH_SIZE}
                max={MAX_BATCH_SIZE}
                value={form.batchSize}
                disabled={locked}
                onChange={(e) => update('batchSize', Number(e.target.value))}
              />
            </Field>
            <Field label="Concurrency" hint={`${MIN_CONCURRENCY}–${MAX_CONCURRENCY}`}>
              <Input
                type="number"
                min={MIN_CONCURRENCY}
                max={MAX_CONCURRENCY}
                value={form.concurrency}
                disabled={locked}
                onChange={(e) => update('concurrency', Number(e.target.value))}
              />
            </Field>
          </div>
          <EmailTemplateEditor
            subject={form.subject}
            body={form.body}
            bodyFormat={form.bodyFormat}
            firstNameFallback={config?.settings.firstNameFallback ?? 'there'}
            sampleContact={preview?.selected[0] ?? null}
            disabled={locked}
            onChange={(patch) => {
              if (patch.subject !== undefined) update('subject', patch.subject);
              if (patch.body !== undefined) update('body', patch.body);
              if (patch.bodyFormat !== undefined) update('bodyFormat', patch.bodyFormat);
            }}
          />
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title="Contacts"
          description={`Rows whose Batch Flag is New in "${config?.settings.worksheetName ?? 'Emails'}", in sheet order.`}
          actions={
            <Button size="sm" variant="outline" onClick={() => void loadPreview()} loading={previewing}>
              Preview Contacts
            </Button>
          }
        />
        <CardBody>
          {previewError && <Alert tone="error">{previewError}</Alert>}
          {preview ? (
            <ContactsPreview preview={preview} />
          ) : (
            !previewError && <p className="text-sm text-slate-500">Preview the contacts this campaign will email.</p>
          )}
        </CardBody>
      </Card>

      <div className="grid grid-cols-2 gap-4">
        <Card>
          <CardHeader title="Send Test Email" description="Uses John Doe sample values. The sheet is not updated." />
          <CardBody className="space-y-3">
            <div className="flex gap-2">
              <Input
                placeholder="you@example.com"
                value={form.testRecipient}
                onChange={(e) => update('testRecipient', e.target.value)}
              />
              <Button
                variant="outline"
                onClick={sendTest}
                loading={testing}
                disabled={Boolean(contentError) || !form.testRecipient.trim()}
              >
                Send Test Email
              </Button>
            </div>
            {testNotice && <Alert tone={testNotice.tone}>{testNotice.text}</Alert>}
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="Send" />
          <CardBody className="space-y-3">
            <Checkbox
              checked={form.dryRun}
              disabled={locked}
              onChange={(v) => update('dryRun', v)}
              label={
                <span>
                  <strong>Dry Run</strong>: render and log every email without sending or changing the sheet
                </span>
              }
            />
            {contentError && <p className="text-xs text-red-700">{contentError}</p>}
            <Button
              onClick={() => void openConfirmation()}
              disabled={locked || Boolean(contentError)}
              loading={previewing && !confirmOpen}
              variant={form.dryRun ? 'default' : 'destructive'}
            >
              {form.dryRun ? 'Start Dry Run' : 'Send Campaign'}
            </Button>
          </CardBody>
        </Card>
      </div>

      <Card>
        <CardHeader
          title="Activity"
          actions={
            <Button size="sm" variant="ghost" onClick={() => onNavigate('logs', { logFilter: 'campaign' })}>
              Full logs
            </Button>
          }
        />
        <CardBody>
          <ActivityPanel entries={activity} />
        </CardBody>
      </Card>

      <CampaignConfirmation
        open={confirmOpen && recipients > 0}
        recipients={recipients}
        from={`${form.fromName} <${form.fromEmail}>`}
        subject={form.subject}
        concurrency={clamp(form.concurrency, MIN_CONCURRENCY, MAX_CONCURRENCY)}
        dryRun={form.dryRun}
        starting={starting}
        onCancel={() => setConfirmOpen(false)}
        onConfirm={() => void start()}
      />
    </>
  );
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, Math.floor(value)));
}
