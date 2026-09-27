import { describe, expect, it } from 'vitest';
import { formatLogLine, formatLogMessage, maskEmail, parseLogLine, redactText, sanitizeForLog } from '../electron/services/log-format';

const RESEND_API_KEY = 're_AbCdEf123456_SECRETsecret';
const GOOGLE_PRIVATE_KEY = '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\n-----END PRIVATE KEY-----\n';

describe('email masking', () => {
  it('masks the local part', () => {
    expect(maskEmail('maria@gmail.com')).toBe('ma***@gmail.com');
    expect(maskEmail('carlos@example.com')).toBe('ca***@example.com');
    expect(maskEmail('a@example.com')).toBe('a***@example.com');
    expect(maskEmail('not-an-email')).toBe('***');
    expect(maskEmail('')).toBe('');
  });

  it('masks emails inside free text', () => {
    expect(redactText('Processing john.doe@example.com now')).toBe('Processing jo***@example.com now');
  });
});

describe('secret redaction', () => {
  it('never lets RESEND_API_KEY or GOOGLE_PRIVATE_KEY through', () => {
    const line = formatLogMessage(`Using key ${RESEND_API_KEY} and ${GOOGLE_PRIVATE_KEY}`, {
      apiKey: RESEND_API_KEY,
      privateKey: GOOGLE_PRIVATE_KEY,
      nested: { resendApiKey: RESEND_API_KEY, note: `key=${RESEND_API_KEY}` },
      credentials: { client_email: 'svc@x.iam.gserviceaccount.com', private_key: GOOGLE_PRIVATE_KEY },
    });
    expect(line).not.toContain(RESEND_API_KEY);
    expect(line).not.toContain('MIIEvQIBADANBgkqhkiG9w0BAQEFAASC');
    expect(line).not.toContain('BEGIN PRIVATE KEY');
    expect(line).toContain('[REDACTED');
  });

  it('sanitizes nested objects, errors and cycles', () => {
    const cyclic: Record<string, unknown> = { password: 'hunter2', message: `failed for ${RESEND_API_KEY}` };
    cyclic['self'] = cyclic;
    const out = sanitizeForLog({ err: new Error(`bad ${RESEND_API_KEY}`), cyclic }) as Record<string, Record<string, unknown>>;
    expect(JSON.stringify(out)).not.toContain(RESEND_API_KEY);
    expect(JSON.stringify(out)).not.toContain('hunter2');
    expect(out['cyclic']?.['self']).toBe('[Circular]');
  });

  it('redacts bearer tokens', () => {
    expect(redactText('Authorization: Bearer ya29.a0AfH6SMB')).toBe('Authorization: Bearer [REDACTED]');
  });
});

describe('log line format', () => {
  it('round-trips through the file format', () => {
    const message = formatLogMessage('Email sent', { row: 12, email: 'carlos@example.com', resendId: 'abc' });
    expect(message).toBe('Email sent row=12 email=ca***@example.com resendId=abc');
    const line = formatLogLine({ timestamp: '2026-09-27T14:32:04.000Z', level: 'info', category: 'campaign', message });
    expect(parseLogLine(line, 'x')).toEqual({ id: 'x', timestamp: '2026-09-27T14:32:04.000Z', level: 'info', category: 'campaign', message });
    expect(parseLogLine('garbage', 'y')).toBeNull();
  });

  it('keeps multi-line messages on one line', () => {
    expect(formatLogMessage('a\nb')).toBe('a ⏎ b');
  });
});
