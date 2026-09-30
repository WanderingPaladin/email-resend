import type { PreviewResult, SkippedContact } from '@shared/types';
import { Alert, Badge } from '@/components/ui/badge';

const SKIP_LABELS: Record<SkippedContact['reason'], string> = {
  blank_email: 'Blank email',
  invalid_email: 'Invalid email',
  already_sent: 'Already sent',
  duplicate_in_campaign: 'Duplicate',
  email_already_sent_elsewhere: 'Sent in another row',
};

export function ContactsPreview({ preview }: { preview: PreviewResult }) {
  return (
    <div className="space-y-3">
      <div className="flex gap-6 text-sm">
        <div>
          <span className="text-lg font-semibold tabular-nums">{preview.totalNew.toLocaleString()}</span>
          <span className="ml-1.5 text-slate-600">total New contacts</span>
        </div>
        <div>
          <span className="text-lg font-semibold tabular-nums">{preview.selected.length}</span>
          <span className="ml-1.5 text-slate-600">contacts selected for this campaign</span>
        </div>
        {preview.skipped.length > 0 && (
          <div>
            <span className="text-lg font-semibold tabular-nums">{preview.skipped.length}</span>
            <span className="ml-1.5 text-slate-600">skipped</span>
          </div>
        )}
      </div>
      {preview.staleProcessingCount > 0 && (
        <Alert tone="warning">
          {preview.staleProcessingCount} row(s) are still in Processing from an earlier campaign. They are excluded and need review.
        </Alert>
      )}
      <div className="max-h-80 overflow-y-auto rounded-md border border-slate-200">
        <table className="w-full text-sm">
          <thead className="sticky top-0 bg-slate-50 text-left text-xs text-slate-600">
            <tr>
              <th className="px-3 py-2 font-medium">Row</th>
              <th className="px-3 py-2 font-medium">First Name</th>
              <th className="px-3 py-2 font-medium">Last Name</th>
              <th className="px-3 py-2 font-medium">Email</th>
              <th className="px-3 py-2 font-medium">Status</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {preview.selected.map((c) => (
              <tr key={c.sheetRow}>
                <td className="px-3 py-1.5 tabular-nums text-slate-500">{c.sheetRow}</td>
                <td className="px-3 py-1.5">{c.firstName || <span className="text-slate-400">(empty)</span>}</td>
                <td className="px-3 py-1.5">{c.lastName}</td>
                <td className="px-3 py-1.5">{c.email}</td>
                <td className="px-3 py-1.5">
                  <Badge tone="info">{c.tag}</Badge>
                </td>
              </tr>
            ))}
            {preview.skipped.map((s) => (
              <tr key={`skip-${s.sheetRow}`} className="bg-slate-50/60 text-slate-500">
                <td className="px-3 py-1.5 tabular-nums">{s.sheetRow}</td>
                <td className="px-3 py-1.5">{s.firstName}</td>
                <td className="px-3 py-1.5" />
                <td className="px-3 py-1.5">{s.email || '(blank)'}</td>
                <td className="px-3 py-1.5">
                  <Badge tone="warning">Skipped: {SKIP_LABELS[s.reason]}</Badge>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
