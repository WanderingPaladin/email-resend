import { useEffect, useState } from 'react';
import type { EmailTemplate } from '@shared/types';
import { Alert } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Field, Input, Select } from '@/components/ui/form';
import { api, errorMessage } from '@/lib/utils';

type Content = Pick<EmailTemplate, 'subject' | 'body' | 'bodyFormat'>;

/** Choose a saved template to fill in the subject and body, or save the current email as a template. */
export function TemplatePicker({
  templateId,
  content,
  disabled,
  onLoad,
}: {
  /** The template the current email came from ('' when none). */
  templateId: string;
  content: Content;
  disabled?: boolean;
  /** Called with the chosen template, or null when the email is no longer tied to a template. */
  onLoad: (template: EmailTemplate | null) => void;
}) {
  const [templates, setTemplates] = useState<EmailTemplate[]>([]);
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [message, setMessage] = useState<{ tone: 'success' | 'error'; text: string } | null>(null);

  const load = async () => {
    try {
      setTemplates(await api().templates.list());
    } catch (e) {
      setMessage({ tone: 'error', text: errorMessage(e) });
    }
  };
  useEffect(() => {
    void load();
  }, []);

  const current = templates.find((t) => t.id === templateId) ?? null;
  const changed = current !== null && (current.subject !== content.subject || current.body !== content.body || current.bodyFormat !== content.bodyFormat);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setMessage(null);
    try {
      await fn();
    } catch (e) {
      setMessage({ tone: 'error', text: errorMessage(e) });
    } finally {
      setBusy(false);
    }
  };

  const saveNew = () =>
    run(async () => {
      const saved = await api().templates.save({ name, ...content });
      await load();
      onLoad(saved);
      setNaming(false);
      setName('');
      setMessage({ tone: 'success', text: `Saved as template "${saved.name}".` });
    });

  const update = () =>
    run(async () => {
      if (!current) return;
      const saved = await api().templates.save({ id: current.id, name: current.name, ...content });
      await load();
      setMessage({ tone: 'success', text: `Template "${saved.name}" updated.` });
    });

  const remove = () =>
    run(async () => {
      if (!current) return;
      await api().templates.delete(current.id);
      await load();
      onLoad(null);
      setConfirmDelete(false);
      setMessage({ tone: 'success', text: `Template "${current.name}" deleted.` });
    });

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-end gap-2">
        <Field label="Template" className="w-80">
          <Select
            value={current ? current.id : ''}
            disabled={disabled || busy}
            onChange={(e) => {
              setConfirmDelete(false);
              setMessage(null);
              const chosen = templates.find((t) => t.id === e.target.value) ?? null;
              onLoad(chosen);
            }}
          >
            <option value="">{templates.length ? 'No template (write below)' : 'No saved templates yet'}</option>
            {templates.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </Select>
        </Field>
        {current && changed && (
          <Button size="sm" variant="outline" loading={busy} disabled={disabled} onClick={() => void update()}>
            {`Update "${current.name}"`}
          </Button>
        )}
        {!naming && (
          <Button size="sm" variant="outline" disabled={disabled || busy} onClick={() => setNaming(true)}>
            Save as New Template
          </Button>
        )}
        {current &&
          (confirmDelete ? (
            <>
              <span className="pb-2 text-xs text-slate-600">{`Delete "${current.name}"?`}</span>
              <Button size="sm" variant="outline" onClick={() => setConfirmDelete(false)}>
                Keep
              </Button>
              <Button size="sm" loading={busy} onClick={() => void remove()}>
                Delete
              </Button>
            </>
          ) : (
            <Button size="sm" variant="ghost" disabled={disabled || busy} onClick={() => setConfirmDelete(true)}>
              Delete Template
            </Button>
          ))}
      </div>
      {naming && (
        <div className="flex items-end gap-2">
          <Field label="New template name" className="w-80">
            <Input
              autoFocus
              value={name}
              maxLength={100}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && name.trim()) void saveNew();
              }}
            />
          </Field>
          <Button size="sm" loading={busy} disabled={!name.trim()} onClick={() => void saveNew()}>
            Save Template
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setNaming(false)}>
            Cancel
          </Button>
        </div>
      )}
      {current && changed && <p className="text-xs text-slate-500">You changed this email since loading the template. The template itself is unchanged until you update it.</p>}
      {message && <Alert tone={message.tone}>{message.text}</Alert>}
    </div>
  );
}
