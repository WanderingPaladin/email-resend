import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';

export function CampaignConfirmation({
  open,
  recipients,
  from,
  subject,
  concurrency,
  dryRun,
  starting,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  recipients: number;
  from: string;
  subject: string;
  concurrency: number;
  dryRun: boolean;
  starting: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const label = dryRun ? `Run Dry Run (${recipients})` : `Send ${recipients} Emails`;
  return (
    <Dialog
      open={open}
      onClose={onCancel}
      title={dryRun ? 'Start dry run?' : 'Send campaign?'}
      footer={
        <>
          <Button variant="outline" onClick={onCancel} disabled={starting}>
            Cancel
          </Button>
          <Button onClick={onConfirm} loading={starting} variant={dryRun ? 'default' : 'destructive'}>
            {label}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <p className="text-base">
          {dryRun ? (
            <>
              Dry run for <strong>{recipients}</strong> contacts. Nothing will be sent and the sheet will not change.
            </>
          ) : (
            <>
              You are about to send <strong>{recipients}</strong> emails.
            </>
          )}
        </p>
        <dl className="grid grid-cols-[7rem_1fr] gap-y-1.5">
          <dt className="text-slate-500">From</dt>
          <dd className="font-medium">{from}</dd>
          <dt className="text-slate-500">Subject</dt>
          <dd className="font-medium">{subject}</dd>
          <dt className="text-slate-500">Recipients</dt>
          <dd className="font-medium">{recipients}</dd>
          <dt className="text-slate-500">Concurrency</dt>
          <dd className="font-medium">{concurrency}</dd>
        </dl>
        {!dryRun && <p className="text-slate-600">Proceed?</p>}
      </div>
    </Dialog>
  );
}
