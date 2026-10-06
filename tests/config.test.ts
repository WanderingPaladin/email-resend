import { describe, expect, it } from 'vitest';
import { campaignStartInputSchema, saveConfigInputSchema, sendTestInputSchema, settingsSchema } from '../shared/schemas';
import { createMemorySettingsRepository } from '../electron/repositories/settings.repository';
import { ConfigService, normalizePrivateKey, type SecretCipher } from '../electron/services/config.service';
import { MemoryLogger } from './helpers';

/** Reversible fake cipher so tests can prove secrets are not stored as plain text. */
const fakeCipher = (available = true): SecretCipher => ({
  isAvailable: () => available,
  encrypt: (plain) => Buffer.from(`enc:${plain}`).toString('base64'),
  decrypt: (encrypted) => Buffer.from(encrypted, 'base64').toString().replace(/^enc:/, ''),
});

const RESEND_KEY = 're_live_1234567890abcdef';
const PRIVATE_KEY = '-----BEGIN PRIVATE KEY-----\\nABC123\\n-----END PRIVATE KEY-----\\n';

describe('configuration validation', () => {
  it('applies defaults', () => {
    const s = settingsSchema.parse({});
    expect(s).toMatchObject({ worksheetName: 'Emails', batchSize: 100, concurrency: 5, firstNameFallback: 'there' });
  });

  it('rejects out-of-range limits', () => {
    expect(settingsSchema.safeParse({ batchSize: 5000 }).success).toBe(true);
    expect(settingsSchema.safeParse({ batchSize: 10_001 }).success).toBe(false);
    expect(settingsSchema.safeParse({ batchSize: 0 }).success).toBe(false);
    expect(settingsSchema.safeParse({ concurrency: 11 }).success).toBe(false);
    expect(settingsSchema.safeParse({ concurrency: 1.5 }).success).toBe(false);
  });

  it('validates campaign start payloads from the renderer', () => {
    const base = { fromName: 'Julio', fromEmail: 'julio@example.com', subject: 'Hi', body: 'Hi {{first_name}}', bodyFormat: 'text', batchSize: 100, concurrency: 5, dryRun: false };
    expect(campaignStartInputSchema.safeParse(base).success).toBe(true);
    expect(campaignStartInputSchema.safeParse({ ...base, batchSize: 1000 }).success).toBe(true);
    expect(campaignStartInputSchema.safeParse({ ...base, batchSize: 10_001 }).success).toBe(false);
    expect(campaignStartInputSchema.safeParse({ ...base, concurrency: 50 }).success).toBe(false);
    expect(campaignStartInputSchema.safeParse({ ...base, fromEmail: 'nope' }).success).toBe(false);
    expect(campaignStartInputSchema.safeParse({ ...base, subject: '   ' }).success).toBe(false);
    expect(campaignStartInputSchema.safeParse({ ...base, bodyFormat: 'js' }).success).toBe(false);
    expect(sendTestInputSchema.safeParse({ ...base, to: 'not-email' }).success).toBe(false);
    expect(saveConfigInputSchema.safeParse({ settings: { batchSize: 50_000 } }).success).toBe(false);
  });
});

describe('ConfigService', () => {
  it('encrypts secrets and never exposes them in the renderer view', () => {
    const repo = createMemorySettingsRepository();
    const config = new ConfigService(repo, fakeCipher(), new MemoryLogger());
    const view = config.save({ resendApiKey: RESEND_KEY, googlePrivateKey: PRIVATE_KEY, settings: { spreadsheetId: 'abc' } });

    expect(JSON.stringify(view)).not.toContain(RESEND_KEY);
    expect(JSON.stringify(view)).not.toContain('ABC123');
    expect(view.hasResendApiKey).toBe(true);
    expect(view.hasGooglePrivateKey).toBe(true);

    const stored = JSON.stringify(repo.get('secrets'));
    expect(stored).not.toContain(RESEND_KEY);
    expect(stored).not.toContain('ABC123');

    expect(config.getMailerCredentials()).toEqual({ provider: 'resend', apiKey: RESEND_KEY });
  });

  it('stores keys per provider and reports the selected provider as configured only when complete', () => {
    const repo = createMemorySettingsRepository();
    const config = new ConfigService(repo, fakeCipher(), new MemoryLogger());
    config.save({ settings: { emailProvider: 'mailjet' }, mailjetApiKey: 'mj-public-123' });
    expect(config.isMailerConfigured()).toBe(false);
    expect(() => config.getMailerCredentials()).toThrow(/Mailjet secret key is not configured/);
    const view = config.save({ mailjetSecretKey: 'mj-secret-456', elasticEmailApiKey: 'ee-key-789' });
    expect(view).toMatchObject({ hasMailjetApiKey: true, hasMailjetSecretKey: true, hasElasticEmailApiKey: true, hasResendApiKey: false });
    expect(config.isMailerConfigured()).toBe(true);
    expect(config.getMailerCredentials()).toEqual({ provider: 'mailjet', apiKey: 'mj-public-123', secretKey: 'mj-secret-456' });
    config.save({ settings: { emailProvider: 'elasticemail' } });
    expect(config.getMailerCredentials()).toEqual({ provider: 'elasticemail', apiKey: 'ee-key-789' });
    const stored = JSON.stringify(repo.get('secrets'));
    for (const secret of ['mj-public-123', 'mj-secret-456', 'ee-key-789']) {
      expect(stored).not.toContain(secret);
      expect(JSON.stringify(view)).not.toContain(secret);
    }
  });

  it('normalizes escaped newlines in private keys', () => {
    expect(normalizePrivateKey(PRIVATE_KEY)).toBe('-----BEGIN PRIVATE KEY-----\nABC123\n-----END PRIVATE KEY-----\n');
  });

  it('keeps, replaces and removes secrets', () => {
    const config = new ConfigService(createMemorySettingsRepository(), fakeCipher(), new MemoryLogger());
    config.save({ resendApiKey: RESEND_KEY });
    config.save({ settings: { fromName: 'Julio' } });
    expect(config.getMailerCredentials()).toMatchObject({ apiKey: RESEND_KEY });
    config.save({ resendApiKey: null });
    expect(config.isMailerConfigured()).toBe(false);
    expect(() => config.getMailerCredentials()).toThrow(/Resend API key is not configured/);
  });

  it('refuses to store secrets when encryption is unavailable', () => {
    const config = new ConfigService(createMemorySettingsRepository(), fakeCipher(false), new MemoryLogger());
    expect(() => config.save({ resendApiKey: RESEND_KEY })).toThrow(/Secure storage is not available/);
  });

  it('imports a service account JSON without keeping the file', () => {
    const repo = createMemorySettingsRepository();
    const logger = new MemoryLogger();
    const config = new ConfigService(repo, fakeCipher(), logger);
    const json = JSON.stringify({ type: 'service_account', client_email: 'svc@proj.iam.gserviceaccount.com', private_key: PRIVATE_KEY, private_key_id: 'kid' });
    expect(config.importServiceAccount(json)).toEqual({ clientEmail: 'svc@proj.iam.gserviceaccount.com' });
    expect(config.getGoogleCredentials()?.privateKey).toContain('ABC123');
    expect(JSON.stringify(repo.get('settings'))).not.toContain('ABC123');
    expect(logger.text()).not.toContain('ABC123');
    expect(() => config.importServiceAccount('{"foo":1}')).toThrow(/service account/);
    expect(() => config.importServiceAccount('not json')).toThrow(/not valid JSON/);
  });

  it('falls back to defaults for corrupted stored values', () => {
    const repo = createMemorySettingsRepository({ settings: { batchSize: 99_999 as number, fromName: 'Julio' } });
    const config = new ConfigService(repo, fakeCipher(), new MemoryLogger());
    expect(config.getSettings()).toMatchObject({ batchSize: 100, fromName: 'Julio' });
  });
});

describe('saving one settings section', () => {
  it('keeps the other sections unchanged', () => {
    const config = new ConfigService(createMemorySettingsRepository(), fakeCipher(), new MemoryLogger());
    const save = (settings: unknown) => config.save(saveConfigInputSchema.parse({ settings }));
    save({ spreadsheetId: 'sheet-123', worksheetName: 'My Emails' });
    save({ emailProvider: 'elasticemail', fromName: 'Julio', fromEmail: 'julio@example.com' });
    expect(config.getSettings()).toMatchObject({ spreadsheetId: 'sheet-123', worksheetName: 'My Emails', emailProvider: 'elasticemail' });
    save({ spreadsheetId: 'sheet-456' });
    expect(config.getSettings()).toMatchObject({ spreadsheetId: 'sheet-456', emailProvider: 'elasticemail', fromEmail: 'julio@example.com' });
  });
});
