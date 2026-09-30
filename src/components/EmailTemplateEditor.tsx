import { useEffect, useMemo, useRef, useState } from 'react';
import { TEMPLATE_VARIABLES, TEST_EMAIL_VARIABLES } from '@shared/constants';
import { buildVariables, htmlToText, renderEmail, textToHtml, validateTemplate } from '@shared/template';
import type { ContactPreview } from '@shared/types';
import { HtmlPreviewFrame, HtmlVisualEditor, type HtmlVisualEditorHandle } from '@/components/HtmlVisualEditor';
import { Alert } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Field, Input, Textarea } from '@/components/ui/form';
import { cn } from '@/lib/utils';

type BodyFormat = 'text' | 'html';
/** Visual and HTML code both edit the same HTML body; plain text is converted to HTML when sent. */
type EditorMode = 'visual' | 'code' | 'text';

const MODES: { id: EditorMode; label: string }[] = [
  { id: 'visual', label: 'Visual' },
  { id: 'code', label: 'HTML code' },
  { id: 'text', label: 'Plain text' },
];

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
  bodyFormat: BodyFormat;
  firstNameFallback: string;
  sampleContact: ContactPreview | null;
  disabled?: boolean;
  onChange: (patch: { subject?: string; body?: string; bodyFormat?: BodyFormat }) => void;
}) {
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const visualRef = useRef<HtmlVisualEditorHandle>(null);
  const [mode, setMode] = useState<EditorMode>(bodyFormat === 'html' ? 'visual' : 'text');
  const [previewAs, setPreviewAs] = useState<'html' | 'text'>('html');

  // Keep the mode in line with the format when the draft is loaded from saved settings.
  useEffect(() => {
    if (bodyFormat === 'html' && mode === 'text') setMode('visual');
    if (bodyFormat === 'text' && mode !== 'text') setMode('text');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bodyFormat]);

  const switchMode = (next: EditorMode) => {
    if (next === mode) return;
    if (next === 'text') {
      onChange({ body: htmlToText(body), bodyFormat: 'text' });
    } else if (mode === 'text') {
      onChange({ body: body.trim() ? textToHtml(body) : '', bodyFormat: 'html' });
    }
    setMode(next);
  };

  const insertVariable = (name: string) => {
    const token = `{{${name}}}`;
    if (mode === 'visual') {
      visualRef.current?.insertText(token);
      return;
    }
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
    const vars = sampleContact ? buildVariables(sampleContact, firstNameFallback) : { ...TEST_EMAIL_VARIABLES };
    return renderEmail({ subject, body, bodyFormat }, vars);
  }, [subject, body, bodyFormat, sampleContact, firstNameFallback]);

  return (
    <div className="grid grid-cols-2 gap-4">
      <div className="min-w-0 space-y-3">
        <Field label="Subject">
          <Input value={subject} disabled={disabled} onChange={(e) => onChange({ subject: e.target.value })} placeholder="Engineering Opportunity" />
        </Field>
        <div>
          <div className="mb-1 flex items-center justify-between">
            <span className="text-xs font-medium text-slate-700">Email Body</span>
            <div className="inline-flex rounded-md border border-slate-300 p-0.5" role="tablist">
              {MODES.map((m) => (
                <button
                  key={m.id}
                  type="button"
                  role="tab"
                  aria-selected={mode === m.id}
                  disabled={disabled}
                  onClick={() => switchMode(m.id)}
                  className={cn(
                    'rounded px-2.5 py-1 text-xs font-medium',
                    mode === m.id ? 'bg-slate-900 text-white' : 'text-slate-600 hover:bg-slate-100',
                  )}
                >
                  {m.label}
                </button>
              ))}
            </div>
          </div>
          {mode === 'visual' ? (
            <HtmlVisualEditor ref={visualRef} html={body} disabled={disabled} onChange={(html) => onChange({ body: html })} />
          ) : (
            <Textarea
              ref={bodyRef}
              rows={14}
              value={body}
              disabled={disabled}
              onChange={(e) => onChange({ body: e.target.value })}
              placeholder={
                mode === 'code'
                  ? '<p>Hi {{first_name}},</p>\n<p>I wanted to reach out regarding an <strong>opportunity</strong>.</p>\n<p>Best,<br>Julio</p>'
                  : 'Hi {{first_name}},\n\nI wanted to reach out regarding an opportunity that may be relevant to you.\n\nBest,\nJulio'
              }
              className="font-mono text-xs"
              spellCheck={mode === 'text'}
            />
          )}
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            <span className="text-xs text-slate-500">Insert:</span>
            {TEMPLATE_VARIABLES.map((v) => (
              <Button
                key={v}
                size="sm"
                variant="secondary"
                disabled={disabled}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => insertVariable(v)}
              >
                {`{{${v}}}`}
              </Button>
            ))}
          </div>
          {mode !== 'text' && (
            <p className="mt-1.5 text-xs text-slate-500">
              Visual and HTML code edit the same email. A plain-text version is created automatically for email clients that do not show HTML.
            </p>
          )}
        </div>
        {templateError && <Alert tone="error">{templateError}</Alert>}
      </div>
      <div className="flex min-w-0 flex-col">
        <div className="mb-1 flex items-center justify-between">
          <span className="text-xs font-medium text-slate-700">
            Preview {sampleContact ? `(row ${sampleContact.sheetRow}: ${sampleContact.email})` : '(sample contact John Doe)'}
          </span>
          <div className="inline-flex rounded-md border border-slate-300 p-0.5">
            {(['html', 'text'] as const).map((p) => (
              <button
                key={p}
                type="button"
                onClick={() => setPreviewAs(p)}
                className={cn(
                  'rounded px-2 py-0.5 text-xs',
                  previewAs === p ? 'bg-slate-200 font-medium text-slate-900' : 'text-slate-600 hover:bg-slate-100',
                )}
              >
                {p === 'html' ? 'As sent' : 'Plain-text version'}
              </button>
            ))}
          </div>
        </div>
        <div className="flex min-h-[26rem] flex-1 flex-col overflow-hidden rounded-md border border-slate-200 bg-white text-sm">
          <div className="border-b border-slate-100 px-4 py-2 font-medium">
            {preview.subject || <span className="text-slate-400">No subject</span>}
          </div>
          {previewAs === 'html' ? (
            preview.html ? (
              <HtmlPreviewFrame html={preview.html} className="w-full flex-1 bg-white" />
            ) : (
              <div className="p-4 text-slate-400">Empty body</div>
            )
          ) : (
            <div className="flex-1 overflow-auto whitespace-pre-wrap p-4 text-slate-800">
              {preview.text || <span className="text-slate-400">Empty body</span>}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
