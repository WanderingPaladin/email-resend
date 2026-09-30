import { describe, expect, it } from 'vitest';
import {
  buildVariables,
  escapeHtml,
  findUnknownVariables,
  htmlToText,
  isFullHtmlDocument,
  renderEmail,
  renderTemplate,
  textToHtml,
  validateTemplate,
} from '../shared/template';

describe('renderTemplate', () => {
  it('replaces variables', () => {
    expect(renderTemplate('Hi {{first_name}},', { first_name: 'Carlos' })).toBe('Hi Carlos,');
    expect(renderTemplate('{{ first_name }} {{LAST_NAME}}', { first_name: 'Maria', last_name: 'Perez' })).toBe('Maria Perez');
  });

  it('leaves unknown placeholders untouched and reports them', () => {
    expect(renderTemplate('Hi {{frist_name}}', { first_name: 'X' })).toBe('Hi {{frist_name}}');
    expect(findUnknownVariables('Hi {{frist_name}} {{email}}')).toEqual(['{{frist_name}}']);
    // Only name and email come from the sheet, so {{company}} is no longer a variable.
    expect(findUnknownVariables('{{company}}')).toEqual(['{{company}}']);
    expect(validateTemplate({ subject: 'Hi', body: '{{nope}}' })).toMatch(/Unsupported template variable/);
    expect(validateTemplate({ subject: 'Hi {{first_name}}', body: '{{email}} {{last_name}}' })).toBeNull();
  });

  it('never evaluates code in templates or values', () => {
    const template = 'Hi ${process.exit(1)} {{first_name}} {{constructor}}';
    expect(renderTemplate(template, { first_name: '${1+1}' })).toBe('Hi ${process.exit(1)} ${1+1} {{constructor}}');
  });

  it('does not personalize by searching for "Hi"', () => {
    expect(renderTemplate('Hi there, Hi {{first_name}}', { first_name: 'Ana' })).toBe('Hi there, Hi Ana');
  });
});

describe('first name fallback', () => {
  it('uses the fallback when first_name is empty', () => {
    const vars = buildVariables({ firstName: '  ', lastName: '', email: 'x@example.com' }, 'there');
    expect(renderTemplate('Hi {{first_name}},', vars)).toBe('Hi there,');
  });
  it('uses the real name when present', () => {
    const vars = buildVariables({ firstName: ' Maria ', lastName: 'Lopez', email: 'maria@example.com' }, 'there');
    expect(vars.first_name).toBe('Maria');
  });
});

describe('renderEmail', () => {
  const template = [
    'Hi {{first_name}},',
    '',
    'I came across your profile and wanted to reach out regarding an opportunity.',
    '',
    'Would you be interested in discussing it?',
    '',
    'Best,',
    'Julio',
  ].join('\n');

  it('produces the exact personalized text from the spec example', () => {
    const vars = buildVariables({ firstName: 'Maria', lastName: 'Lopez', email: 'maria@example.com' }, 'there');
    const email = renderEmail({ subject: 'Opportunity for {{first_name}}', body: template, bodyFormat: 'text' }, vars);
    expect(email.subject).toBe('Opportunity for Maria');
    expect(email.text).toBe(template.replace('{{first_name}}', 'Maria'));
    expect(email.html).toBe(
      '<p>Hi Maria,</p>\n<p>I came across your profile and wanted to reach out regarding an opportunity.</p>\n<p>Would you be interested in discussing it?</p>\n<p>Best,<br>Julio</p>',
    );
  });

  it('escapes contact data in HTML output', () => {
    const vars = { first_name: '<script>alert(1)</script>' };
    expect(renderEmail({ subject: 's', body: 'Hi {{first_name}}', bodyFormat: 'text' }, vars).html).toBe(
      '<p>Hi &lt;script&gt;alert(1)&lt;/script&gt;</p>',
    );
    expect(renderEmail({ subject: 's', body: '<b>Hi {{first_name}}</b>', bodyFormat: 'html' }, vars).html).toBe(
      '<b>Hi &lt;script&gt;alert(1)&lt;/script&gt;</b>',
    );
  });

  it('keeps subjects on one line', () => {
    expect(renderEmail({ subject: 'Hi {{first_name}}', body: 'x', bodyFormat: 'text' }, { first_name: 'A\r\nBcc: evil@example.com' }).subject).toBe(
      'Hi A Bcc: evil@example.com',
    );
  });

  it('converts text to paragraphs', () => {
    expect(textToHtml('Hi,\n\nHow are you?')).toBe('<p>Hi,</p>\n<p>How are you?</p>');
    expect(escapeHtml(`"&'<>`)).toBe('&quot;&amp;&#39;&lt;&gt;');
  });
});

describe('htmlToText', () => {
  it('drops head, styles and scripts, keeps links and list items', () => {
    const html =
      '<!DOCTYPE html><html><head><title>T</title><style>p{color:red}</style></head><body><h2>Hi Maria</h2>' +
      '<p>See <a href="https://example.com/jobs">open roles</a><br>Thanks</p><ul><li>One</li><li>Two</li></ul><script>x()</script></body></html>';
    expect(htmlToText(html)).toBe('Hi Maria\nSee open roles (https://example.com/jobs)\nThanks\n\n- One\n- Two');
  });

  it('keeps the operator HTML and escapes substituted values in html format', () => {
    const email = renderEmail(
      { subject: 'Hi', body: '<p style="color:#123">Hi <b>{{first_name}}</b></p>', bodyFormat: 'html' },
      { first_name: '<Ana>', last_name: '', email: 'a@example.com' },
    );
    expect(email.html).toBe('<p style="color:#123">Hi <b>&lt;Ana&gt;</b></p>');
    expect(email.text).toBe('Hi <Ana>');
    expect(isFullHtmlDocument(email.html)).toBe(false);
    expect(isFullHtmlDocument('<html><body>x</body></html>')).toBe(true);
  });
});
