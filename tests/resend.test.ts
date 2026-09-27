import { describe, expect, it } from 'vitest';
import { normalizeResendError, ResendService } from '../electron/services/resend.service';
import { FakeResendClient, MemoryLogger, noSleep } from './helpers';

const email = { from: 'Julio <julio@example.com>', to: 'maria@example.com', subject: 'Hi', html: '<p>Hi</p>', text: 'Hi' };

function service(client: FakeResendClient) {
  return new ResendService(client, new MemoryLogger(), { sendsPerSecond: 10, sleepFn: noSleep, now: () => 0 });
}

describe('ResendService.sendEmail', () => {
  it('returns the Resend ID on success', async () => {
    const client = new FakeResendClient();
    client.script('maria@example.com', { id: 'f4ae7289' });
    expect(await service(client).sendEmail(email)).toEqual({ success: true, id: 'f4ae7289' });
    expect(client.calls[0]).toMatchObject({ to: 'maria@example.com', from: 'Julio <julio@example.com>', html: '<p>Hi</p>' });
  });

  it('normalizes a validation failure and does not retry it', async () => {
    const client = new FakeResendClient();
    client.script('maria@example.com', { error: { name: 'validation_error', message: 'Invalid `to` field', statusCode: 422 } });
    const result = await service(client).sendEmail({ ...email, idempotencyKey: 'k' });
    expect(result).toMatchObject({ success: false, code: 'validation_error', ambiguous: false, fatal: false });
    expect(client.calls).toHaveLength(1);
  });

  it('retries rate limits', async () => {
    const client = new FakeResendClient();
    client.script('maria@example.com', { error: { name: 'rate_limit_exceeded', message: 'Too many', statusCode: 429 } }, { id: 'ok' });
    expect(await service(client).sendEmail(email)).toEqual({ success: true, id: 'ok' });
    expect(client.calls).toHaveLength(2);
  });

  it('retries ambiguous failures only with the same idempotency key', async () => {
    const client = new FakeResendClient();
    client.script('maria@example.com', { throw: new TypeError('fetch failed') }, { id: 'ok' });
    expect(await service(client).sendEmail({ ...email, idempotencyKey: 'camp:12' })).toEqual({ success: true, id: 'ok' });
    expect(client.calls.map((c) => c.idempotencyKey)).toEqual(['camp:12', 'camp:12']);
  });

  it('does not retry ambiguous failures without an idempotency key', async () => {
    const client = new FakeResendClient();
    client.script('maria@example.com', { throw: new TypeError('fetch failed') }, { id: 'ok' });
    const result = await service(client).sendEmail(email);
    expect(result).toMatchObject({ success: false, ambiguous: true });
    expect(client.calls).toHaveLength(1);
  });

  it('flags configuration errors as fatal', async () => {
    const client = new FakeResendClient();
    client.script('maria@example.com', { error: { name: 'invalid_api_key', message: 'API key is invalid', statusCode: 403 } });
    expect(await service(client).sendEmail(email)).toMatchObject({ success: false, fatal: true, ambiguous: false });
  });

  it('throttles request starts to the configured rate', async () => {
    const client = new FakeResendClient();
    const waits: number[] = [];
    const svc = new ResendService(client, new MemoryLogger(), {
      sendsPerSecond: 2,
      sleepFn: async (ms) => {
        waits.push(ms);
      },
      now: () => 1000,
    });
    await Promise.all([svc.sendEmail(email), svc.sendEmail(email), svc.sendEmail(email)]);
    expect(waits).toEqual([500, 1000]);
  });
});

describe('normalizeResendError', () => {
  it('redacts API keys from error messages', () => {
    const e = normalizeResendError({ name: 'invalid_api_key', message: 'Key re_abcdefghijkl123 is invalid' });
    expect(e.message).not.toContain('re_abcdefghijkl123');
  });
  it('treats server errors as ambiguous', () => {
    expect(normalizeResendError({ name: 'internal_server_error', message: 'x' }).ambiguous).toBe(true);
    expect(normalizeResendError({ name: 'application_error', message: 'Unable to fetch data' }).ambiguous).toBe(true);
  });
});

describe('validateConfiguration', () => {
  it('lists verified domains and checks the sender domain', async () => {
    const client = new FakeResendClient();
    const ok = await service(client).validateConfiguration('julio@example.com');
    expect(ok).toMatchObject({ status: 'valid', fromDomainVerified: true });
    const other = await service(client).validateConfiguration('julio@other.com');
    expect(other.fromDomainVerified).toBe(false);
  });

  it('accepts sending-only keys without sending an email', async () => {
    const client = new FakeResendClient();
    client.domainsResponse = { data: null, error: { name: 'restricted_api_key', message: 'restricted', statusCode: 401 } };
    expect((await service(client).validateConfiguration('julio@example.com')).status).toBe('restricted');
    expect(client.calls).toHaveLength(0);
  });

  it('rejects invalid keys', async () => {
    const client = new FakeResendClient();
    client.domainsResponse = { data: null, error: { name: 'invalid_api_key', message: 'API key is invalid', statusCode: 403 } };
    await expect(service(client).validateConfiguration('julio@example.com')).rejects.toThrow(/rejected the API key/);
  });
});
