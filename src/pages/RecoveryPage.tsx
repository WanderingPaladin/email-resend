import { useState } from 'react';
import type { StaleContact } from '@shared/types';
import { Alert, Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import type { RecoveryHook } from '@/hooks/useRecovery';
import { errorMessage, formatDateTime } from '@/lib/utils';

type Action = 'mark_new' | 'mark_failed' | 'mark_sent';

const ACTION_TEXT: Record<Action, { label: string; explain: string }> = {
  mark_new: {
    label: 'Mark as New',
    explain: 'These contacts will be eligible for the next campaign and may receive the email. Only do this if you are sure they did not receive it.',
  },
  mark_failed: { label: 'Mark as Failed', explain: 'These contacts will be tagged Failed and excluded from future campaigns until you change them.' },
  mark_sent: { label: 'Mark as Sent', explain: 'These contacts will be tagged Sent and never emailed again automatically.' },
};

function outcomeBadge(c: StaleContact) {
  switch (c.journalOutcome) {
    case 'accepted':
      return <Badge tone="success">Resend accepted</Badge>;
    case 'rejected':
      return <Badge tone="error">Resend rejected</Badge>;
    case 'unknown':
      return <Badge tone="warning">Unknown</Badge>;
    default:
      return <Badge tone="neutral">No local record</Badge>;
  }
}

export function RecoveryPage({ recovery }: { recovery: RecoveryHook }) {
  const { state, scanning, error, scan, apply, dismiss } = recovery;
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [pending, setPending] = useState<Action | null>(null);
  const [working, setWorking] = useState(false);
  const [notice, setNotice] = useState<{ tone: 'success' | 'error' | 'warning'; text: string } | null>(null);

  const stale = state?.staleContacts ?? [];
  const chosen = stale.filter((c) => selected.has(c.sheetRow));

  const toggle = (row: number) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(row)) next.delete(row);
      else next.add(row);
      return next;
    });

  const confirm = async () => {
    if (!pending) return;
    setWorking(true);
    try {
      const result = await apply({ action: pending, rows: chosen.map((c) => ({ sheetRow: c.sheetRow, email: c.email })) });
      setSelected(new Set());
      const skipped = result.skipped.map((s) => `Row ${s.sheetRow}: ${s.reason}`).join('\n');
      setNotice({
        tone: result.skipped.length ? 'warning' : 'success',
        text: `Updated ${result.updated} row(s).${skipped ? `\n${skipped}` : ''}`,
      });
    } catch (e) {
      setNotice({ tone: 'error', text: errorMessage(e) });
    } finally {
      setWorking(false);
      setPending(null);
    }
  };

  return (
    <>
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Review</h1>
        <Button variant="outline" size="sm" onClick={() => void scan()} loading={scanning}>
          Rescan Sheet
        </Button>
      </div>
      <Alert tone="info">
        Nothing on this screen sends email. Each action only updates the selected rows in the sheet after checking they are still in
        Processing with the same email address.
      </Alert>
      {error && <Alert tone="error">{error}</Alert>}
      {state?.googleError && <Alert tone="error">{state.googleError}</Alert>}
      {notice && <Alert tone={notice.tone}>{notice.text}</Alert>}

      <Card>
        <CardHeader
          title={`${stale.length} contact(s) remain in Processing state`}
          description="Left by an interrupted campaign or an unknown delivery result. Review them before retrying."
          actions={
            <>
              {(['mark_new', 'mark_failed', 'mark_sent'] as const).map((a) => (
                <Button key={a} size="sm" variant="outline" disabled={chosen.length === 0} onClick={() => setPending(a)}>
                  {ACTION_TEXT[a].label}
                </Button>
              ))}
            </>
          }
        />
        <CardBody className="p-0">
          {stale.length === 0 ? (
            <p className="px-5 py-4 text-sm text-slate-500">{scanning ? 'Scanning…' : 'No rows need review.'}</p>
          ) : (
            <table className="w-full text-xs">
              <thead className="bg-slate-50 text-left text-slate-600">
                <tr>
                  <th className="w-8 px-3 py-2">
                    <input
                      type="checkbox"
                      checked={chosen.length === stale.length}
                      onChange={(e) => setSelected(e.target.checked ? new Set(stale.map((c) => c.sheetRow)) : new Set())}
                    />
                  </th>
                  <th className="px-3 py-2 font-medium">Row</th>
                  <th className="px-3 py-2 font-medium">Email</th>
                  <th className="px-3 py-2 font-medium">Status</th>
                  <th className="px-3 py-2 font-medium">Local record</th>
                  <th className="px-3 py-2 font-medium">Resend ID</th>
                  <th className="px-3 py-2 font-medium">Last error</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {stale.map((c) => (
                  <tr key={c.sheetRow} className="cursor-pointer hover:bg-slate-50" onClick={() => toggle(c.sheetRow)}>
                    <td className="px-3 py-1.5">
                      <input type="checkbox" checked={selected.has(c.sheetRow)} readOnly />
                    </td>
                    <td className="px-3 py-1.5 tabular-nums">{c.sheetRow}</td>
                    <td className="px-3 py-1.5">{c.email}</td>
                    <td className="px-3 py-1.5">
                      {c.tag} / {c.sendStatus || '—'}
                    </td>
                    <td className="px-3 py-1.5">{outcomeBadge(c)}</td>
                    <td className="px-3 py-1.5 font-mono">{c.journalResendId}</td>
                    <td className="max-w-xs px-3 py-1.5 text-slate-600">{c.lastError}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardBody>
      </Card>

      {(state?.manualReview.length ?? 0) > 0 && (
        <Card>
          <CardHeader
            title="Sent, but the sheet was not updated"
            description="Resend accepted these emails but the status write to Google Sheets failed (EMAIL_SENT_SHEET_UPDATE_FAILED). Mark the matching rows above as Sent, then dismiss."
          />
          <CardBody className="p-0">
            <table className="w-full text-xs">
              <thead className="bg-slate-50 text-left text-slate-600">
                <tr>
                  <th className="px-3 py-2 font-medium">Time</th>
                  <th className="px-3 py-2 font-medium">Row</th>
                  <th className="px-3 py-2 font-medium">Email</th>
                  <th className="px-3 py-2 font-medium">Resend ID</th>
                  <th className="px-3 py-2 font-medium">Campaign</th>
                  <th className="px-3 py-2" />
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {state?.manualReview.map((r) => (
                  <tr key={r.id}>
                    <td className="px-3 py-1.5">{formatDateTime(r.timestamp)}</td>
                    <td className="px-3 py-1.5 tabular-nums">{r.sheetRow}</td>
                    <td className="px-3 py-1.5">{r.email}</td>
                    <td className="px-3 py-1.5 font-mono">{r.resendId}</td>
                    <td className="px-3 py-1.5 font-mono text-slate-500">{r.campaignId.slice(0, 8)}</td>
                    <td className="px-3 py-1.5 text-right">
                      <Button size="sm" variant="ghost" onClick={() => void dismiss(r.id)}>
                        Dismiss
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardBody>
        </Card>
      )}

      <Dialog
        open={pending !== null}
        title={pending ? `${ACTION_TEXT[pending].label}: ${chosen.length} row(s)?` : ''}
        onClose={() => setPending(null)}
        footer={
          <>
            <Button variant="outline" onClick={() => setPending(null)} disabled={working}>
              Cancel
            </Button>
            <Button onClick={() => void confirm()} loading={working} variant={pending === 'mark_new' ? 'destructive' : 'default'}>
              {pending ? ACTION_TEXT[pending].label : ''}
            </Button>
          </>
        }
      >
        {pending && (
          <div className="space-y-2">
            <p>{ACTION_TEXT[pending].explain}</p>
            {pending === 'mark_new' && chosen.some((c) => c.journalOutcome === 'accepted') && (
              <Alert tone="error">Some selected rows were accepted by Resend. Those rows will be refused to prevent a duplicate send.</Alert>
            )}
          </div>
        )}
      </Dialog>
    </>
  );
}
