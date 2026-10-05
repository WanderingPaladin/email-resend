import { useCallback, useEffect, useState } from 'react';
import { AppSidebar, type PageId } from '@/components/AppSidebar';
import { Alert } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useAppStatus } from '@/hooks/useAppStatus';
import { useCampaign } from '@/hooks/useCampaign';
import { useCampaignForm } from '@/hooks/useCampaignForm';
import { useConfig } from '@/hooks/useConfig';
import { useLogs } from '@/hooks/useLogs';
import { useRecovery } from '@/hooks/useRecovery';
import { CampaignPage } from '@/pages/CampaignPage';
import { DashboardPage } from '@/pages/DashboardPage';
import { FindContactsPage } from '@/pages/FindContactsPage';
import { SearchCostsPage } from '@/pages/SearchCostsPage';
import { LogsPage } from '@/pages/LogsPage';
import { RecoveryPage } from '@/pages/RecoveryPage';
import { SettingsPage } from '@/pages/SettingsPage';

export function App() {
  const [page, setPage] = useState<PageId>('dashboard');
  const [autoPreview, setAutoPreview] = useState(0);
  const [logFilter, setLogFilter] = useState<string>('all');

  const configHook = useConfig();
  const { status, reload: reloadStatus } = useAppStatus();
  const logs = useLogs();
  const recovery = useRecovery();
  const formHook = useCampaignForm(configHook.config?.settings);

  const onCampaignFinished = useCallback(() => {
    void reloadStatus();
    void recovery.scan();
  }, [reloadStatus, recovery.scan]);
  const campaign = useCampaign(onCampaignFinished);

  // Startup check: stale Processing rows and unconfirmed sends.
  useEffect(() => {
    void recovery.scan();
  }, [recovery.scan]);

  const navigate = useCallback((next: PageId, options?: { preview?: boolean; logFilter?: string }) => {
    if (options?.preview) setAutoPreview((n) => n + 1);
    if (options?.logFilter) setLogFilter(options.logFilter);
    setPage(next);
  }, []);

  const needsReview = recovery.attentionCount > 0 && !campaign.running;
  const interrupted = recovery.state?.interruptedCampaignId;

  return (
    <div className="flex h-full">
      <AppSidebar
        page={page}
        onNavigate={(p) => navigate(p)}
        campaignRunning={campaign.running}
        recoveryCount={recovery.attentionCount}
        version={status?.version ?? ''}
      />
      <main className="min-w-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-6xl space-y-4 p-6">
          {needsReview && page !== 'recovery' && (
            <Alert
              tone="warning"
              title={`${recovery.attentionCount} contact(s) from a previous campaign need review.`}
              actions={
                <Button size="sm" variant="outline" onClick={() => navigate('recovery')}>
                  Review
                </Button>
              }
            >
              {interrupted ? 'The last campaign did not finish. ' : ''}
              They remain in Processing and will not be resent automatically. Review them before retrying.
            </Alert>
          )}
          {configHook.error && <Alert tone="error" title="Could not load settings">{configHook.error}</Alert>}

          {page === 'dashboard' && (
            <DashboardPage status={status} config={configHook.config} campaignRunning={campaign.running} onNavigate={navigate} onRefresh={reloadStatus} />
          )}
          {page === 'campaign' && (
            <CampaignPage
              config={configHook.config}
              formHook={formHook}
              campaign={campaign}
              logs={logs.entries}
              autoPreview={autoPreview}
              onNavigate={navigate}
            />
          )}
          {page === 'find' && <FindContactsPage config={configHook.config} saveConfig={configHook.save} onNavigate={navigate} />}
          {page === 'costs' && <SearchCostsPage />}
          {page === 'settings' && <SettingsPage configHook={configHook} onSaved={reloadStatus} />}
          {page === 'logs' && <LogsPage logs={logs} initialFilter={logFilter} logDirectory={status?.logDirectory ?? ''} />}
          {page === 'recovery' && <RecoveryPage recovery={recovery} />}
        </div>
      </main>
    </div>
  );
}
