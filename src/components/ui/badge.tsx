import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

export type Tone = 'neutral' | 'success' | 'warning' | 'error' | 'info';

const tones: Record<Tone, string> = {
  neutral: 'bg-slate-100 text-slate-700',
  success: 'bg-emerald-50 text-emerald-700',
  warning: 'bg-amber-50 text-amber-800',
  error: 'bg-red-50 text-red-700',
  info: 'bg-sky-50 text-sky-700',
};

export function Badge({ tone = 'neutral', children, className }: { tone?: Tone; children: ReactNode; className?: string }) {
  return <span className={cn('inline-flex items-center rounded px-2 py-0.5 text-xs font-medium', tones[tone], className)}>{children}</span>;
}

const dots: Record<Tone, string> = {
  neutral: 'bg-slate-400',
  success: 'bg-emerald-500',
  warning: 'bg-amber-500',
  error: 'bg-red-500',
  info: 'bg-sky-500',
};

export function StatusDot({ tone }: { tone: Tone }) {
  return <span className={cn('inline-block h-2.5 w-2.5 rounded-full', dots[tone])} />;
}

export function Alert({ tone = 'info', title, children, actions }: { tone?: Tone; title?: ReactNode; children?: ReactNode; actions?: ReactNode }) {
  const styles: Record<Tone, string> = {
    neutral: 'border-slate-200 bg-slate-50 text-slate-800',
    success: 'border-emerald-200 bg-emerald-50 text-emerald-900',
    warning: 'border-amber-200 bg-amber-50 text-amber-900',
    error: 'border-red-200 bg-red-50 text-red-900',
    info: 'border-sky-200 bg-sky-50 text-sky-900',
  };
  return (
    <div className={cn('flex items-start justify-between gap-4 rounded-md border px-4 py-3 text-sm', styles[tone])}>
      <div className="min-w-0">
        {title && <div className="font-medium">{title}</div>}
        {children && <div className={cn('whitespace-pre-line break-words', title && 'mt-0.5')}>{children}</div>}
      </div>
      {actions && <div className="flex shrink-0 gap-2">{actions}</div>}
    </div>
  );
}
