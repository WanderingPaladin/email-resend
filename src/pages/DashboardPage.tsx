import { useCallback, useEffect, useState } from 'react';
import type { AppStatus, CampaignHistoryEntry, ConfigView, GoogleTestResult } from '@shared/types';
import type { PageId } from '@/components/AppSidebar';
import { CampaignResults } from '@/components/CampaignResults';
import { ConnectionStatus, type StatusRow } from '@/components/ConnectionStatus';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { api, errorMessage, formatDate, formatDateTime } from '@/lib/utils';

export function DashboardPage({
  status,
  config,
  campaignRunning,
  onNavigate,
  onRefresh,
}: {
  status: AppStatus | null;
  config: ConfigView | null;
  campaignRunning: boolean;
  onNavigate: (page: PageId, options?: { preview?: boolean; logFilter?: string }) => void;
  onRefresh: () => Promise<void>;
}) {
  const [google, setGoogle] = useState<GoogleTestResult | null>(null);
  const [googleError, setGoogleError] = useState('');
  const [checking, setChecking] = useState(false);
  const [selected, setSelected] = useState<CampaignHistoryEntry | null>(null);

  const check = useCallback(async () => {
    setChecking(true);
    try {
      setGoogle(await api().google.testConnection());
      setGoogleError('');
    } catch (e) {
      setGoogle(null);
      setGoogleError(errorMessage(e));
    } finally {
      setChecking(false);
    }
  }, []);

  useEffect(() => {
    if (status?.googleConfigured) void check();
  }, [status?.googleConfigured, check]);

  const last = status?.lastCampaign ?? null;
  const rows: StatusRow[] = [
    status?.googleConfigured
      ? google
        ? { label: 'Google Sheets', value: 'Connected', tone: 'success', detail: `${google.spreadsheetTitle} / ${google.worksheetName}` }
        : googleError
          ? { label: 'Google Sheets', value: 'Error', tone: 'error', detail: googleError }
          : { label: 'Google Sheets', value: checking ? 'Checking…' : 'Configured', tone: 'neutral' }
      : { label: 'Google Sheets', value: 'Not Connected', tone: 'warning', detail: 'Configure it in Settings.' },
    status?.resendConfigured
      ? { label: 'Resend', value: 'Configured', tone: 'success', detail: config?.settings.fromEmail || undefined }
      : { label: 'Resend', value: 'Not Configured', tone: 'warning', detail: 'Add your API key in Settings.' },
    {
      label: 'Application Status',
      value: campaignRunning ? 'Campaign running' : status?.manualReviewCount || status?.interruptedCampaignId ? 'Needs review' : 'Ready',
      tone: campaignRunning ? 'info' : status?.manualReviewCount || status?.interruptedCampaignId ? 'warning' : 'success',
    },
  ];

  return (
    <>
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Dashboard</h1>
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => onNavigate('campaign', { preview: true })}>
            Preview Contacts
          </Button>
          <Button onClick={() => onNavigate('campaign')}>New Campaign</Button>
          <Button variant="outline" onClick={() => onNavigate('logs')}>
            Open Logs
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-3 gap-4">
        <Card className="col-span-2">
          <CardHeader
            title="Status"
            actions={
              <Button
                size="sm"
                variant="ghost"
                loading={checking}
                onClick={() => {
                  void onRefresh();
                  if (status?.googleConfigured) void check();
                }}
              >
                Refresh
              </Button>
            }
          />
          <CardBody>
            <ConnectionStatus rows={rows} />
          </CardBody>
        </Card>
        <Card>
          <CardHeader title="New Contacts" />
          <CardBody>
            <div className="text-4xl font-semibold tabular-nums">{google ? google.newCount.toLocaleString() : '—'}</div>
            <div className="mt-1 text-xs text-slate-500">
              {google ? `of ${google.rowCount.toLocaleString()} rows in "${google.worksheetName}"` : 'Connect Google Sheets to count contacts.'}
            </div>
          </CardBody>
        </Card>
      </div>

      <div className="grid grid-cols-3 gap-4">
        <Card>
          <CardHeader title="Last Campaign" />
          <CardBody className="space-y-1 text-sm">
            {last ? (
              <>
                <Stat label="Sent" value={last.sent} />
                <Stat label="Failed" value={last.failed} />
                {last.needsReview > 0 && <Stat label="Needs review" value={last.needsReview} />}
                <Stat label="Date" value={formatDateTime(last.completedAt)} />
              </>
            ) : (
              <p className="text-slate-500">No campaigns yet.</p>
            )}
          </CardBody>
        </Card>
        <Card className="col-span-2">
          <CardHeader title="Recent Campaigns" />
          <CardBody className="p-0">
            {status && status.recentCampaigns.length > 0 ? (
              <ul className="divide-y divide-slate-100">
                {status.recentCampaigns.map((c) => (
                  <li key={c.id}>
                    <button
                      type="button"
                      className="flex w-full items-center justify-between px-5 py-2.5 text-left text-sm hover:bg-slate-50"
                      onClick={() => setSelected(c)}
                    >
                      <span>
                        <span className="font-medium">{formatDate(c.startedAt)}</span>
                        <span className="ml-2 text-slate-500">{c.subject}</span>
                      </span>
                      <span className="text-xs text-slate-600 tabular-nums">
                        {c.total} contacts · {c.sent} sent · {c.failed} failed
                        {c.cancelled ? ' · cancelled' : ''}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="px-5 py-4 text-sm text-slate-500">Completed campaigns will appear here.</p>
            )}
          </CardBody>
        </Card>
      </div>

      <Dialog
        open={selected !== null}
        title={selected ? `Campaign of ${formatDateTime(selected.startedAt)}` : ''}
        onClose={() => setSelected(null)}
        footer={<Button onClick={() => setSelected(null)}>Close</Button>}
      >
        {selected && (
          <div className="space-y-3">
            <div className="text-xs text-slate-500">Campaign ID: {selected.id}</div>
            <CampaignResults
              compact
              totals={{ total: selected.total, sent: selected.sent, failed: selected.failed, skipped: selected.skipped, needsReview: selected.needsReview }}
              results={selected.results}
            />
          </div>
        )}
      </Dialog>
    </>
  );
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="flex justify-between">
      <span className="text-slate-600">{label}</span>
      <span className="font-medium tabular-nums">{value}</span>
    </div>
  );
}
