import { StatusDot, type Tone } from '@/components/ui/badge';

export interface StatusRow {
  label: string;
  value: string;
  tone: Tone;
  detail?: string;
}

/** Compact "● Connected" style status list used on the dashboard and settings pages. */
export function ConnectionStatus({ rows }: { rows: StatusRow[] }) {
  return (
    <dl className="divide-y divide-slate-100">
      {rows.map((row) => (
        <div key={row.label} className="flex items-start justify-between gap-4 py-2 text-sm">
          <dt className="text-slate-600">{row.label}</dt>
          <dd className="text-right">
            <span className="inline-flex items-center gap-2 font-medium">
              <StatusDot tone={row.tone} />
              {row.value}
            </span>
            {row.detail && <div className="mt-0.5 max-w-md text-xs text-slate-500">{row.detail}</div>}
          </dd>
        </div>
      ))}
    </dl>
  );
}
