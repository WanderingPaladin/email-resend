import { useEffect, type ReactNode } from 'react';

export function Dialog({ open, title, children, footer, onClose }: { open: boolean; title: ReactNode; children: ReactNode; footer: ReactNode; onClose: () => void }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4" role="dialog" aria-modal="true">
      <div className="w-full max-w-lg rounded-lg bg-white shadow-xl">
        <div className="border-b border-slate-100 px-5 py-4 text-base font-semibold">{title}</div>
        <div className="max-h-[60vh] overflow-y-auto px-5 py-4 text-sm">{children}</div>
        <div className="flex justify-end gap-2 border-t border-slate-100 px-5 py-3">{footer}</div>
      </div>
    </div>
  );
}
