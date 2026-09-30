import type { ContactResult } from '@shared/types';
import { Badge, type Tone } from '@/components/ui/badge';

const STATUS: Record<ContactResult['status'], { label: string; tone: Tone }> = {
  sent: { label: 'Sent', tone: 'success' },
  failed: { label: 'Failed', tone: 'error' },
  skipped: { label: 'Skipped', tone: 'neutral' },
  needs_review: { label: 'Needs review', tone: 'warning' },
  not_started: { label: 'Not started', tone: 'neutral' },
  dry_run: { label: 'Dry run', tone: 'info' },
};

export function CampaignResults({
  totals,
  results,
  compact,
}: {
  totals: { total: number; sent: number; failed: number; skipped: number; needsReview: number; notStarted?: number };
  results: ContactResult[];
  compact?: boolean;
}) {
  return (
    <div className="space-y-3">
      <dl className="grid w-fit grid-cols-[8rem_4rem] gap-y-0.5 text-sm tabular-nums">
        <dt>Total:</dt>
        <dd className="text-right font-medium">{totals.total}</dd>
        <dt>Sent:</dt>
        <dd className="text-right font-medium text-emerald-700">{totals.sent}</dd>
        <dt>Failed:</dt>
        <dd className="text-right font-medium text-red-700">{totals.failed}</dd>
        <dt>Skipped:</dt>
        <dd className="text-right font-medium">{totals.skipped}</dd>
        {totals.needsReview > 0 && (
          <>
            <dt>Needs review:</dt>
            <dd className="text-right font-medium text-amber-700">{totals.needsReview}</dd>
          </>
        )}
        {(totals.notStarted ?? 0) > 0 && (
          <>
            <dt>Not started:</dt>
            <dd className="text-right font-medium">{totals.notStarted}</dd>
          </>
        )}
      </dl>
      <div className={`${compact ? 'max-h-64' : 'max-h-96'} overflow-auto rounded-md border border-slate-200`}>
        <table className="w-full text-xs">
          <thead className="sticky top-0 bg-slate-50 text-left text-slate-600">
            <tr>
              <th className="px-2 py-1.5 font-medium">Name</th>
              <th className="px-2 py-1.5 font-medium">Email</th>
              <th className="px-2 py-1.5 font-medium">Sheet Row</th>
              <th className="px-2 py-1.5 font-medium">Status</th>
              <th className="px-2 py-1.5 font-medium">Message ID</th>
              <th className="px-2 py-1.5 font-medium">Error</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {results.map((r) => (
              <tr key={`${r.sheetRow}-${r.email}`}>
                <td className="px-2 py-1">{r.name}</td>
                <td className="px-2 py-1">{r.email}</td>
                <td className="px-2 py-1 tabular-nums">{r.sheetRow}</td>
                <td className="px-2 py-1">
                  <Badge tone={STATUS[r.status].tone}>{STATUS[r.status].label}</Badge>
                </td>
                <td className="px-2 py-1 font-mono">{r.resendId}</td>
                <td className="max-w-xs px-2 py-1 text-red-700">{r.error}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
