import { TEMPLATE_VARIABLES } from './constants';
import type { EmailContent } from './schemas';

export type TemplateVariable = (typeof TEMPLATE_VARIABLES)[number];
export type TemplateVariables = Partial<Record<TemplateVariable, string>>;

const VARIABLE_PATTERN = /\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g;

export interface RenderOptions {
  /** Applied to each substituted value, e.g. HTML escaping. */
  escape?: (value: string) => string;
}

/**
 * Replaces `{{name}}` placeholders with values. Placeholders are matched by a regular
 * expression and substituted as plain strings: no code is evaluated.
 * Unknown placeholders are left untouched; use findUnknownVariables to reject them up front.
 */
export function renderTemplate(
  template: string,
  variables: Record<string, string | undefined>,
  options: RenderOptions = {},
): string {
  const escape = options.escape ?? ((v: string) => v);
  return template.replace(VARIABLE_PATTERN, (match, rawName: string) => {
    const name = rawName.toLowerCase();
    if (!Object.prototype.hasOwnProperty.call(variables, name)) return match;
    return escape(variables[name] ?? '');
  });
}

/** Returns placeholder names that the app does not support, e.g. `{{frist_name}}`. */
export function findUnknownVariables(template: string): string[] {
  const unknown = new Set<string>();
  for (const match of template.matchAll(VARIABLE_PATTERN)) {
    const name = (match[1] ?? '').toLowerCase();
    if (!(TEMPLATE_VARIABLES as readonly string[]).includes(name)) unknown.add(match[0]);
  }
  return [...unknown];
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Converts plain text to simple HTML: blank lines separate paragraphs,
 * single line breaks become <br>. All text is HTML-escaped.
 */
export function textToHtml(text: string): string {
  const normalized = text.replace(/\r\n?/g, '\n').trim();
  if (!normalized) return '';
  return normalized
    .split(/\n\s*\n/)
    .map((paragraph) => `<p>${escapeHtml(paragraph).replace(/\n/g, '<br>')}</p>`)
    .join('\n');
}

/** Small HTML → text converter for the plain-text part of HTML emails. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(head|style|script|title)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<a\b[^>]*\bhref\s*=\s*(["'])(.*?)\1[^>]*>([\s\S]*?)<\/a\s*>/gi, (_m, _q, href: string, inner: string) => {
      const label = inner.replace(/<[^>]+>/g, '').trim();
      return label && label !== href && !href.startsWith('mailto:') ? `${label} (${href})` : label || href;
    })
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(/<(br|\/p|\/div|\/h[1-6]|\/tr|\/ul|\/ol)\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** True when the HTML is a complete document (has <html> or <body>) rather than a fragment. */
export function isFullHtmlDocument(html: string): boolean {
  return /<(html|body)[\s>]/i.test(html);
}

export interface ContactLike {
  firstName: string;
  lastName: string;
  email: string;
}

/** Builds template variables for a contact, applying the first-name fallback. */
export function buildVariables(contact: ContactLike, firstNameFallback: string): TemplateVariables {
  const firstName = contact.firstName.trim();
  return {
    first_name: firstName || firstNameFallback,
    last_name: contact.lastName.trim(),
    email: contact.email.trim(),
  };
}

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

/**
 * Renders subject and body for one recipient.
 * - text format: variables are substituted first, then the whole body is escaped and wrapped in <p>.
 * - html format: the operator's HTML is kept, substituted values are escaped.
 */
export function renderEmail(
  content: Pick<EmailContent, 'subject' | 'body' | 'bodyFormat'>,
  variables: TemplateVariables,
): RenderedEmail {
  // Subjects are a single header line; strip line breaks a variable might introduce.
  const subject = renderTemplate(content.subject, variables).replace(/[\r\n]+/g, ' ').trim();
  if (content.bodyFormat === 'html') {
    const html = renderTemplate(content.body, variables, { escape: escapeHtml });
    return { subject, html, text: htmlToText(html) };
  }
  const text = renderTemplate(content.body, variables);
  return { subject, html: textToHtml(text), text: text.replace(/\r\n?/g, '\n').trim() };
}

/** Validates subject and body before sending. Returns an error message or null. */
export function validateTemplate(content: Pick<EmailContent, 'subject' | 'body'>): string | null {
  const unknown = [...new Set([...findUnknownVariables(content.subject), ...findUnknownVariables(content.body)])];
  if (unknown.length > 0) {
    return `Unsupported template variable(s): ${unknown.join(', ')}. Supported: ${TEMPLATE_VARIABLES.map(
      (v) => `{{${v}}}`,
    ).join(', ')}`;
  }
  return null;
}
