import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { isFullHtmlDocument } from '@shared/template';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/form';

/** Default look for fragments while editing and previewing. Not part of the saved HTML. */
export const EMAIL_BASE_CSS =
  'body{margin:0;padding:12px 14px;font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5;color:#1e293b;word-wrap:break-word}img{max-width:100%}';

/** Wraps an HTML fragment in a document with the base style; full documents are used as they are. */
export function toPreviewDocument(html: string): string {
  if (isFullHtmlDocument(html)) return html;
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>${EMAIL_BASE_CSS}</style></head><body>${html}</body></html>`;
}

export interface HtmlVisualEditorHandle {
  insertText(text: string): void;
}

/**
 * WYSIWYG editing of the email's HTML. The HTML is loaded into an iframe in design mode:
 * the iframe is sandboxed without allow-scripts, so nothing in the email can run, and the
 * email's own CSS cannot affect the app. The parent reads the edited HTML back on every change.
 */
export const HtmlVisualEditor = forwardRef<
  HtmlVisualEditorHandle,
  { html: string; disabled?: boolean; onChange: (html: string) => void }
>(function HtmlVisualEditor({ html, disabled, onChange }, ref) {
  const frame = useRef<HTMLIFrameElement>(null);
  // The HTML currently in the iframe, so our own edits do not reload it (which would move the caret).
  const loaded = useRef<string | null>(null);
  const fullDocument = useRef(false);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const [linkOpen, setLinkOpen] = useState(false);
  const [linkUrl, setLinkUrl] = useState('https://');

  const doc = () => frame.current?.contentDocument ?? null;

  const serialize = useCallback((): string => {
    const d = doc();
    if (!d) return '';
    if (fullDocument.current) return `<!DOCTYPE html>\n${d.documentElement.outerHTML}`;
    return d.body.innerHTML;
  }, []);

  const emit = useCallback(() => {
    const next = serialize();
    loaded.current = next;
    onChangeRef.current(next);
  }, [serialize]);

  const load = useCallback(
    (value: string) => {
      const d = doc();
      if (!d) return;
      fullDocument.current = isFullHtmlDocument(value);
      d.open();
      d.write(fullDocument.current ? value : toPreviewDocument(value));
      d.close();
      // document.open() removes listeners, so they are attached after every load.
      d.addEventListener('input', emit);
      d.designMode = disabled ? 'off' : 'on';
      // Plain tags (<b>, <i>, <font color>) render in more email clients than CSS spans.
      d.execCommand('styleWithCSS', false, 'false');
      loaded.current = value;
    },
    [disabled, emit],
  );

  useEffect(() => {
    if (html !== loaded.current) load(html);
  }, [html, load]);

  useEffect(() => {
    const d = doc();
    if (d) d.designMode = disabled ? 'off' : 'on';
  }, [disabled]);

  const exec = (command: string, value?: string) => {
    const d = doc();
    if (!d || disabled) return;
    frame.current?.contentWindow?.focus();
    d.execCommand(command, false, value);
    emit();
  };

  useImperativeHandle(ref, () => ({ insertText: (text: string) => exec('insertText', text) }));

  const tool = (label: string, title: string, command: string, value?: string, className?: string) => (
    <Button
      key={title}
      size="sm"
      variant="ghost"
      title={title}
      disabled={disabled}
      className={className}
      // Keep the selection inside the editor when a toolbar button is clicked.
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => exec(command, value)}
    >
      {label}
    </Button>
  );

  return (
    <div className="overflow-hidden rounded-md border border-slate-300 bg-white">
      <div className="flex flex-wrap items-center gap-0.5 border-b border-slate-200 bg-slate-50 px-1 py-1">
        {tool('B', 'Bold', 'bold', undefined, 'font-bold')}
        {tool('I', 'Italic', 'italic', undefined, 'italic')}
        {tool('U', 'Underline', 'underline', undefined, 'underline')}
        <span className="mx-1 h-5 w-px bg-slate-200" />
        {tool('H1', 'Large heading', 'formatBlock', 'h1')}
        {tool('H2', 'Heading', 'formatBlock', 'h2')}
        {tool('¶', 'Paragraph', 'formatBlock', 'p')}
        {tool('• List', 'Bulleted list', 'insertUnorderedList')}
        {tool('1. List', 'Numbered list', 'insertOrderedList')}
        <span className="mx-1 h-5 w-px bg-slate-200" />
        {tool('Left', 'Align left', 'justifyLeft')}
        {tool('Center', 'Align center', 'justifyCenter')}
        <label className="flex items-center gap-1 px-1 text-xs text-slate-600" title="Text color" onMouseDown={(e) => e.stopPropagation()}>
          Color
          <input
            type="color"
            className="h-6 w-7 cursor-pointer rounded border border-slate-300"
            disabled={disabled}
            onChange={(e) => exec('foreColor', e.target.value)}
          />
        </label>
        <Button size="sm" variant="ghost" title="Insert link" disabled={disabled} onMouseDown={(e) => e.preventDefault()} onClick={() => setLinkOpen((o) => !o)}>
          Link
        </Button>
        {tool('Unlink', 'Remove link', 'unlink')}
        {tool('Clear', 'Clear formatting', 'removeFormat')}
      </div>
      {linkOpen && (
        <div className="flex items-center gap-2 border-b border-slate-200 bg-slate-50 px-2 py-1.5">
          <span className="text-xs text-slate-600">Select text in the editor, then:</span>
          <Input className="h-7 flex-1 text-xs" value={linkUrl} onChange={(e) => setLinkUrl(e.target.value)} placeholder="https://example.com" />
          <Button
            size="sm"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              const url = linkUrl.trim();
              if (/^(https?:|mailto:)/i.test(url)) exec('createLink', url);
              setLinkOpen(false);
            }}
          >
            Apply
          </Button>
        </div>
      )}
      <iframe
        ref={frame}
        title="Email editor"
        // allow-same-origin lets the app read the edited HTML; without allow-scripts nothing in it runs.
        sandbox="allow-same-origin"
        className="block h-72 w-full bg-white"
      />
    </div>
  );
});

/** Read-only rendering of the final email. Fully sandboxed: no scripts, no access to the app. */
export function HtmlPreviewFrame({ html, className }: { html: string; className?: string }) {
  return <iframe title="Email preview" sandbox="" srcDoc={toPreviewDocument(html)} className={className} />;
}
