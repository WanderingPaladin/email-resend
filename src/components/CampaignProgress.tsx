import type { CampaignProgress as Progress } from '@shared/types';
import { Alert } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';

export function CampaignProgress({ progress, onCancel }: { progress: Progress; onCancel: () => void }) {
  const pct = progress.total > 0 ? Math.round((progress.processed / progress.total) * 100) : 0;
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-base font-semibold">{progress.dryRun ? 'Dry Run in Progress' : 'Sending Campaign'}</h3>
        <Button variant="outline" size="sm" onClick={onCancel} disabled={progress.cancelRequested}>
          {progress.cancelRequested ? 'Cancelling…' : 'Cancel Campaign'}
        </Button>
      </div>
      <div>
        <div className="h-3 overflow-hidden rounded-full bg-slate-100">
          <div className="h-full rounded-full bg-emerald-500 transition-all duration-300" style={{ width: `${pct}%` }} />
        </div>
        <div className="mt-1.5 text-sm text-slate-700 tabular-nums">
          {progress.processed} / {progress.total} processed
        </div>
      </div>
      <div className="grid grid-cols-4 gap-3 text-sm">
        <Counter label="Sent" value={progress.dryRun ? progress.processed : progress.sent} tone="text-emerald-700" />
        <Counter label="Failed" value={progress.failed} tone="text-red-700" />
        <Counter label="Skipped" value={progress.skipped} tone="text-slate-600" />
        <Counter label="Needs review" value={progress.needsReview} tone="text-amber-700" />
      </div>
      {progress.currentEmail && (
        <div className="text-sm">
          <span className="text-slate-500">Currently processing: </span>
          <span className="font-medium">{progress.currentEmail}</span>
        </div>
      )}
      {progress.cancelRequested && (
        <Alert tone="warning" title="Campaign cancellation requested.">
          Currently active sends will finish. No additional contacts will be started.
        </Alert>
      )}
    </div>
  );
}

function Counter({ label, value, tone }: { label: string; value: number; tone: string }) {
  return (
    <div className="rounded-md border border-slate-200 px-3 py-2">
      <div className="text-xs text-slate-500">{label}</div>
      <div className={`text-xl font-semibold tabular-nums ${tone}`}>{value}</div>
    </div>
  );
}
