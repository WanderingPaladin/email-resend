import { useState } from 'react';
import { LogViewer } from '@/components/LogViewer';
import { Alert } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import type { LogsHook } from '@/hooks/useLogs';
import { api, errorMessage } from '@/lib/utils';

export function LogsPage({ logs, initialFilter, logDirectory }: { logs: LogsHook; initialFilter: string; logDirectory: string }) {
  const [notice, setNotice] = useState<{ tone: 'success' | 'error'; text: string } | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);

  const act = async (fn: () => Promise<unknown>, success?: string) => {
    try {
      await fn();
      setNotice(success ? { tone: 'success', text: success } : null);
    } catch (e) {
      setNotice({ tone: 'error', text: errorMessage(e) });
    }
  };

  return (
    <>
      <div>
        <h1 className="text-xl font-semibold">Logs</h1>
        {logDirectory && <p className="text-xs text-slate-500">{logDirectory}</p>}
      </div>
      {notice && <Alert tone={notice.tone}>{notice.text}</Alert>}
      <LogViewer
        key={initialFilter}
        entries={logs.entries}
        initialFilter={initialFilter}
        loading={logs.loading}
        onRefresh={() => void act(logs.reload)}
        onClear={() => setConfirmClear(true)}
        onOpenFolder={() => void act(() => api().logs.openFolder())}
        onCopy={(text) => void act(() => api().app.copyText(text), 'Copied to clipboard.')}
      />
      <Dialog
        open={confirmClear}
        title="Clear logs?"
        onClose={() => setConfirmClear(false)}
        footer={
          <>
            <Button variant="outline" onClick={() => setConfirmClear(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                setConfirmClear(false);
                void act(logs.clear, 'Logs cleared.');
              }}
            >
              Clear Logs
            </Button>
          </>
        }
      >
        This deletes main.log and campaign.log. Campaign history and the sheet are not affected. Warnings about emails that need manual
        review will no longer be in the log files, but they stay listed on the Review screen.
      </Dialog>
    </>
  );
}
