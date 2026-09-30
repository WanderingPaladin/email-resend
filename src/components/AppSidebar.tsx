import { cn } from '@/lib/utils';

export type PageId = 'dashboard' | 'campaign' | 'find' | 'settings' | 'logs' | 'recovery';

const ITEMS: { id: PageId; label: string }[] = [
  { id: 'dashboard', label: 'Dashboard' },
  { id: 'campaign', label: 'Campaign' },
  { id: 'find', label: 'Find Contacts' },
  { id: 'settings', label: 'Settings' },
  { id: 'logs', label: 'Logs' },
];

export function AppSidebar({
  page,
  onNavigate,
  campaignRunning,
  recoveryCount,
  version,
}: {
  page: PageId;
  onNavigate: (page: PageId) => void;
  campaignRunning: boolean;
  recoveryCount: number;
  version: string;
}) {
  const items = recoveryCount > 0 ? [...ITEMS, { id: 'recovery' as const, label: 'Review' }] : ITEMS;
  return (
    <aside className="flex w-52 shrink-0 flex-col border-r border-slate-200 bg-white">
      <div className="px-5 py-5">
        <div className="text-base font-semibold tracking-tight">Email Sender</div>
        <div className="text-xs text-slate-500">Google Sheets + Email</div>
      </div>
      <nav className="flex-1 space-y-0.5 px-3">
        {items.map((item) => (
          <button
            key={item.id}
            type="button"
            onClick={() => onNavigate(item.id)}
            className={cn(
              'flex w-full items-center justify-between rounded-md px-3 py-2 text-left text-sm',
              page === item.id ? 'bg-slate-900 text-white' : 'text-slate-700 hover:bg-slate-100',
            )}
          >
            {item.label}
            {item.id === 'campaign' && campaignRunning && (
              <span className="h-2 w-2 animate-pulse rounded-full bg-emerald-400" title="Campaign running" />
            )}
            {item.id === 'recovery' && (
              <span className="rounded bg-amber-400 px-1.5 text-xs font-semibold text-amber-950">{recoveryCount}</span>
            )}
          </button>
        ))}
      </nav>
      <div className="px-5 py-4 text-xs text-slate-400">v{version}</div>
    </aside>
  );
}
