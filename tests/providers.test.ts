import { describe, expect, it } from 'vitest';
import { ElasticEmailService } from '../electron/services/elastic-email.service';
import { MailjetService } from '../electron/services/mailjet.service';
import { FakeFetch, MemoryLogger, noSleep } from './helpers';

// No real HTTP requests: every call goes to FakeFetch.
const options = { sendsPerSecond: 10, sleepFn: noSleep, now: () => 0 };
const email = {
  fromName: 'Julio "J" <Recruiter>',
  fromEmail: 'julio@example.com',
  to: 'maria@example.com',
  subject: 'Hi Maria',
  html: '<p>Hi <b>Maria</b></p>',
  text: 'Hi Maria',
  idempotencyKey: 'camp:2',
};

describe('Elastic Email', () => {
  const service = (f: FakeFetch) => new ElasticEmailService('ee-secret-key', new MemoryLogger(), options, f.fetch);

  it('sends HTML and text parts with the API key header and returns the message ID', async () => {
    const f = new FakeFetch().reply(200, { TransactionID: 't-1', MessageID: 'm-1' });
    expect(await service(f).sendEmail(email)).toEqual({ success: true, id: 'm-1' });
    const call = f.calls[0];
    expect(call?.url).toBe('https://api.elasticemail.com/v4/emails/transactional');
    expect(call?.method).toBe('POST');
    expect(call?.headers['x-elasticemail-apikey']).toBe('ee-secret-key');
    expect(call?.body).toEqual({
      Recipients: { To: ['maria@example.com'] },
      Content: {
        From: 'Julio J Recruiter <julio@example.com>',
        Subject: 'Hi Maria',
        Body: [
          { ContentType: 'HTML', Content: '<p>Hi <b>Maria</b></p>', Charset: 'utf-8' },
          { ContentType: 'PlainText', Content: 'Hi Maria', Charset: 'utf-8' },
        ],
      },
    });
  });

  it('treats a rejected key as fatal and a bad recipient as a single failure', async () => {
    const f = new FakeFetch().reply(401, { Error: 'Access denied' }).reply(400, { Error: 'Invalid recipient address' });
    expect(await service(f).sendEmail(email)).toMatchObject({ success: false, fatal: true, ambiguous: false });
    expect(await service(f).sendEmail(email)).toMatchObject({ success: false, fatal: false, ambiguous: false, error: 'Invalid recipient address' });
  });

  it('treats sender and credit problems as fatal', async () => {
    const f = new FakeFetch().reply(400, { Error: 'Not enough credit to send' });
    expect(await service(f).sendEmail(email)).toMatchObject({ success: false, fatal: true });
  });

  it('retries rate limits but never retries an ambiguous failure (no idempotency support)', async () => {
    const f = new FakeFetch().reply(429, {}).reply(200, { MessageID: 'm-2' });
    expect(await service(f).sendEmail(email)).toEqual({ success: true, id: 'm-2' });
    expect(f.calls).toHaveLength(2);

    const g = new FakeFetch().fail(new TypeError('socket hang up')).reply(200, { MessageID: 'never' });
    expect(await service(g).sendEmail(email)).toMatchObject({ success: false, ambiguous: true });
    expect(g.calls).toHaveLength(1);

    const h = new FakeFetch().reply(503, { Error: 'down' });
    expect(await service(h).sendEmail(email)).toMatchObject({ success: false, ambiguous: true });
    expect(h.calls).toHaveLength(1);
  });

  it('validates the key by listing domains', async () => {
    const f = new FakeFetch().reply(200, [
      { Domain: 'example.com', Spf: true, Dkim: true },
      { Domain: 'other.com', Spf: false, Dkim: true },
    ]);
    const result = await service(f).validateConfiguration('julio@example.com');
    expect(result).toMatchObject({ status: 'valid', verifiedDomains: ['example.com'], fromDomainVerified: true });
    expect(f.calls[0]?.url).toBe('https://api.elasticemail.com/v4/domains');

    const bad = new FakeFetch().reply(401, { Error: 'Access denied' });
    await expect(service(bad).validateConfiguration('julio@example.com')).rejects.toThrow(/rejected the API key/);
  });

  it('matches a domain listed with its default sender, e.g. "example.org (hi@example.org)"', async () => {
    const f = new FakeFetch().reply(200, [{ Domain: 'LeanSolutionsGroup.org (hi@leansolutionsgroup.org)', Spf: true, Dkim: true }]);
    const result = await service(f).validateConfiguration(' hi@leansolutionsgroup.org ');
    expect(result).toMatchObject({ verifiedDomains: ['leansolutionsgroup.org'], fromDomainVerified: true });
    expect(result.message).not.toContain('not verified');
  });
});

describe('Mailjet', () => {
  const service = (f: FakeFetch) => new MailjetService('mj-key', 'mj-secret', new MemoryLogger(), options, f.fetch);
  const success = { Messages: [{ Status: 'success', To: [{ Email: 'maria@example.com', MessageUUID: 'uuid-1', MessageID: 288230376151711744 }] }] };

  it('sends with Basic auth and returns the message UUID', async () => {
    const f = new FakeFetch().reply(200, success);
    expect(await service(f).sendEmail(email)).toEqual({ success: true, id: 'uuid-1' });
    const call = f.calls[0];
    expect(call?.url).toBe('https://api.mailjet.com/v3.1/send');
    expect(call?.headers['authorization']).toBe(`Basic ${Buffer.from('mj-key:mj-secret').toString('base64')}`);
    expect(call?.body).toEqual({
      Messages: [
        {
          From: { Email: 'julio@example.com', Name: 'Julio J Recruiter' },
          To: [{ Email: 'maria@example.com' }],
          Subject: 'Hi Maria',
          TextPart: 'Hi Maria',
          HTMLPart: '<p>Hi <b>Maria</b></p>',
          CustomID: 'camp:2',
        },
      ],
    });
  });

  it('classifies errors', async () => {
    const f = new FakeFetch()
      .reply(401, { ErrorMessage: 'API key authentication/authorization failure', StatusCode: 401 })
      .reply(400, { Messages: [{ Status: 'error', Errors: [{ ErrorMessage: 'Sender is not validated', ErrorRelatedTo: ['From.Email'] }] }] })
      .reply(400, { Messages: [{ Status: 'error', Errors: [{ ErrorMessage: '"x" is an invalid email address.', ErrorRelatedTo: ['To[0].Email'] }] }] });
    expect(await service(f).sendEmail(email)).toMatchObject({ success: false, fatal: true, code: 'invalid_api_key' });
    expect(await service(f).sendEmail(email)).toMatchObject({ success: false, fatal: true, code: 'invalid_from_address' });
    expect(await service(f).sendEmail(email)).toMatchObject({ success: false, fatal: false, ambiguous: false });
  });

  it('validates keys by listing active senders, including domain wildcards', async () => {
    const f = new FakeFetch().reply(200, { Data: [{ Email: '*@example.com', Status: 'Active' }, { Email: 'x@other.com', Status: 'Inactive' }] });
    const result = await service(f).validateConfiguration('julio@example.com');
    expect(result).toMatchObject({ status: 'valid', fromDomainVerified: true, verifiedDomains: ['*@example.com'] });
    expect(f.calls[0]?.url).toBe('https://api.mailjet.com/v3/REST/sender?Limit=1000');

    const g = new FakeFetch().reply(200, { Data: [] });
    expect((await service(g).validateConfiguration('julio@example.com')).fromDomainVerified).toBe(false);
  });

  it('never puts keys in error messages', async () => {
    const f = new FakeFetch().reply(500, { ErrorMessage: 'Internal error' });
    const result = await service(f).sendEmail(email);
    expect(JSON.stringify(result)).not.toContain('mj-secret');
    expect(result).toMatchObject({ success: false, ambiguous: true });
  });
});
