import { describe, expect, it } from 'vitest';
import { isRetryableGoogleError, normalizeGoogleError } from '../electron/services/google-sheets.service';

describe('normalizeGoogleError', () => {
  it('explains DNS failures from Node', () => {
    const e = normalizeGoogleError(Object.assign(new Error('getaddrinfo ENOTFOUND oauth2.googleapis.com'), { code: 'ENOTFOUND' }));
    expect(e.kind).toBe('network');
    expect(e.message).toContain('ENOTFOUND');
    expect(e.message).toMatch(/VPN, proxy, firewall/);
  });

  it('recognizes Chromium network errors from net.fetch', () => {
    const e = normalizeGoogleError(new TypeError('net::ERR_NAME_NOT_RESOLVED'));
    expect(e.kind).toBe('network');
    expect(e.message).toContain('ERR_NAME_NOT_RESOLVED');
    expect(isRetryableGoogleError(new TypeError('net::ERR_CONNECTION_RESET'))).toBe(true);
    expect(isRetryableGoogleError(new TypeError('net::ERR_NAME_NOT_RESOLVED'))).toBe(false);
  });

  it('maps auth, permission and not-found errors', () => {
    expect(normalizeGoogleError(new Error('invalid_grant: account not found')).kind).toBe('auth');
    expect(normalizeGoogleError(Object.assign(new Error('forbidden'), { response: { status: 403 } }), { serviceAccountEmail: 'svc@x.iam.gserviceaccount.com' }).message).toContain(
      'svc@x.iam.gserviceaccount.com',
    );
    expect(normalizeGoogleError(Object.assign(new Error('nf'), { response: { status: 404 } })).kind).toBe('not_found');
  });
});
