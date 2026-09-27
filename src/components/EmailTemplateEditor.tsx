import { useMemo, useRef } from 'react';
import { TEMPLATE_VARIABLES, TEST_EMAIL_VARIABLES } from '@shared/constants';
import { buildVariables, renderEmail, validateTemplate } from '@shared/template';
import type { ContactPreview } from '@shared/types';
import { Alert } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Field, Input, Select, Textarea } from '@/components/ui/form';

export function EmailTemplateEditor({
  subject,
  body,
  bodyFormat,
  firstNameFallback,
  sampleContact,
  disabled,
  onChange,
}: {
  subject: string;
  body: string;
  bodyFormat: 'text' | 'html';
  firstNameFallback: string;
  sampleContact: ContactPreview | null;
  disabled?: boolean;
  onChange: (patch: { subject?: string; body?: string; bodyFormat?: 'text' | 'html' }) => void;
}) {
  const bodyRef = useRef<HTMLTextAreaElement>(null);

  const insertVariable = (name: string) => {
    const token = `{{${name}}}`;
    const el = bodyRef.current;
    if (!el) return onChange({ body: body + token });
    const start = el.selectionStart ?? body.length;
    const end = el.selectionEnd ?? body.length;
    onChange({ body: body.slice(0, start) + token + body.slice(end) });
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(start + token.length, start + token.length);
    });
  };

  const templateError = validateTemplate({ subject, body });
  const preview = useMemo(() => {
    const vars = sampleContact
      ? buildVariables(sampleContact, firstNameFallback)
      : { ...TEST_EMAIL_VARIABLES };
    return renderEmail({ subject, body, bodyFormat }, vars);
  }, [subject, body, bodyFormat, sampleContact, firstNameFallback]);

  return (
    <div className="grid grid-cols-2 gap-4">
      <div className="space-y-3">
        <Field label="Subject">
          <Input value={subject} disabled={disabled} onChange={(e) => onChange({ subject: e.target.value })} placeholder="Engineering Opportunity" />
        </Field>
        <div>
          <div className="mb-1 flex items-center justify-between">
            <span className="text-xs font-medium text-slate-700">Email Body</span>
            <Select
              className="h-7 w-40 text-xs"
              value={bodyFormat}
              disabled={disabled}
              onChange={(e) => onChange({ bodyFormat: e.target.value as 'text' | 'html' })}
            >
              <option value="text">Plain text → HTML</option>
              <option value="html">HTML</option>
            </Select>
          </div>
          <Textarea
            ref={bodyRef}
            rows={12}
            value={body}
            disabled={disabled}
            onChange={(e) => onChange({ body: e.target.value })}
            placeholder={'Hi {{first_name}},\n\nI wanted to reach out regarding an opportunity that may be relevant to you.\n\nBest,\nJulio'}
            className="font-mono text-xs"
          />
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            <span className="text-xs text-slate-500">Insert:</span>
            {TEMPLATE_VARIABLES.map((v) => (
              <Button key={v} size="sm" variant="secondary" disabled={disabled} onClick={() => insertVariable(v)}>
                {`{{${v}}}`}
              </Button>
            ))}
          </div>
        </div>
        {templateError && <Alert tone="error">{templateError}</Alert>}
      </div>
      <div>
        <div className="mb-1 text-xs font-medium text-slate-700">
          Preview {sampleContact ? `(row ${sampleContact.sheetRow})` : '(sample contact John Doe)'}
        </div>
        <div className="h-[calc(100%-1.25rem)] rounded-md border border-slate-200 bg-white p-4 text-sm">
          <div className="border-b border-slate-100 pb-2 font-medium">{preview.subject || <span className="text-slate-400">No subject</span>}</div>
          <div className="whitespace-pre-wrap pt-3 text-slate-800">{preview.text || <span className="text-slate-400">Empty body</span>}</div>
        </div>
      </div>
    </div>
  );
}
