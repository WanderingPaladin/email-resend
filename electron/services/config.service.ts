import { EMAIL_PROVIDER_LABELS, type EmailProviderId } from '../../shared/constants';
import { settingsSchema, serviceAccountFileSchema, type SaveConfigInput, type Settings } from '../../shared/schemas';
import type { ConfigView } from '../../shared/types';
import type { EncryptedSecrets, SettingsRepository } from '../repositories/settings.repository';
import type { AppLogger } from '../types/logger';

/** Encrypts secrets at rest. Backed by Electron safeStorage in the app, a fake in tests. */
export interface SecretCipher {
  isAvailable(): boolean;
  encrypt(plain: string): string;
  decrypt(encrypted: string): string;
}

export interface GoogleCredentials {
  clientEmail: string;
  privateKey: string;
}

type SecretName = keyof EncryptedSecrets;

/** Email provider secrets that can be saved from Settings. */
const MAILER_SECRETS = ['resendApiKey', 'elasticEmailApiKey', 'mailjetApiKey', 'mailjetSecretKey'] as const;

/** Secrets each provider needs before it can send. */
const PROVIDER_SECRETS: Record<EmailProviderId, readonly (typeof MAILER_SECRETS)[number][]> = {
  resend: ['resendApiKey'],
  elasticemail: ['elasticEmailApiKey'],
  mailjet: ['mailjetApiKey', 'mailjetSecretKey'],
};

export type MailerCredentials =
  | { provider: 'resend'; apiKey: string }
  | { provider: 'elasticemail'; apiKey: string }
  | { provider: 'mailjet'; apiKey: string; secretKey: string };

/**
 * Normalizes a pasted private key. Keys copied out of JSON often contain literal "\n"
 * sequences instead of line breaks, which makes the JWT signer reject them.
 */
export function normalizePrivateKey(key: string): string {
  return key.replace(/\\n/g, '\n').replace(/\r\n?/g, '\n').trim() + '\n';
}

export class ConfigService {
  constructor(
    private readonly repo: SettingsRepository,
    private readonly cipher: SecretCipher,
    private readonly logger: AppLogger,
  ) {}

  /** Stored settings merged with defaults. Invalid stored values fall back to defaults. */
  getSettings(): Settings {
    const stored = this.repo.get('settings');
    const parsed = settingsSchema.safeParse(stored);
    if (parsed.success) return parsed.data;
    this.logger.warn('config', 'Stored settings were invalid; falling back to defaults for invalid fields');
    const defaults = settingsSchema.parse({});
    const merged: Record<string, unknown> = { ...defaults };
    for (const [key, value] of Object.entries(stored)) {
      const single = settingsSchema.shape[key as keyof Settings]?.safeParse(value);
      if (single?.success) merged[key] = single.data;
    }
    return settingsSchema.parse(merged);
  }

  getView(): ConfigView {
    const secrets = this.repo.get('secrets');
    return {
      settings: this.getSettings(),
      hasResendApiKey: Boolean(secrets.resendApiKey),
      hasElasticEmailApiKey: Boolean(secrets.elasticEmailApiKey),
      hasMailjetApiKey: Boolean(secrets.mailjetApiKey),
      hasMailjetSecretKey: Boolean(secrets.mailjetSecretKey),
      hasGooglePrivateKey: Boolean(secrets.googlePrivateKey),
      encryptionAvailable: this.cipher.isAvailable(),
    };
  }

  save(input: SaveConfigInput): ConfigView {
    if (input.settings) {
      const next = settingsSchema.parse({ ...this.getSettings(), ...input.settings });
      this.repo.set('settings', next);
    }
    for (const name of MAILER_SECRETS) {
      const value = input[name];
      if (value !== undefined) this.setSecret(name, value);
    }
    if (input.googlePrivateKey !== undefined) {
      this.setSecret(
        'googlePrivateKey',
        input.googlePrivateKey === null ? null : normalizePrivateKey(input.googlePrivateKey),
      );
    }
    this.logger.info('config', 'Configuration saved', {
      settingsChanged: input.settings ? Object.keys(input.settings).join(',') : '',
      secretsChanged: MAILER_SECRETS.filter((n) => input[n] !== undefined)
        .map((n) => `${n}:${input[n] === null ? 'removed' : 'updated'}`)
        .join(','),
      googlePrivateKey:
        input.googlePrivateKey === undefined ? 'unchanged' : input.googlePrivateKey === null ? 'removed' : 'updated',
    });
    return this.getView();
  }

  /**
   * Imports a service-account JSON file's contents. Only client_email and private_key are kept;
   * the key is encrypted and the JSON itself is never written to disk.
   */
  importServiceAccount(fileContents: string): { clientEmail: string } {
    let raw: unknown;
    try {
      raw = JSON.parse(fileContents);
    } catch {
      throw new Error('The selected file is not valid JSON.');
    }
    const parsed = serviceAccountFileSchema.safeParse(raw);
    if (!parsed.success) {
      throw new Error('The file does not look like a Google service account key (client_email and private_key are required).');
    }
    this.setSecret('googlePrivateKey', normalizePrivateKey(parsed.data.private_key));
    this.repo.set('settings', { ...this.getSettings(), serviceAccountEmail: parsed.data.client_email });
    this.logger.info('config', 'Imported Google service account', { serviceAccountEmail: parsed.data.client_email });
    return { clientEmail: parsed.data.client_email };
  }

  /** Decrypted credentials for the selected provider. Throws a user-facing error when any are missing. */
  getMailerCredentials(): MailerCredentials {
    const provider = this.getSettings().emailProvider;
    const label = EMAIL_PROVIDER_LABELS[provider];
    const need = (name: SecretName, what: string) => {
      const value = this.getSecret(name);
      if (!value) throw new Error(`${label} ${what} is not configured. Add it in Settings.`);
      return value;
    };
    if (provider === 'mailjet') {
      return { provider, apiKey: need('mailjetApiKey', 'API key'), secretKey: need('mailjetSecretKey', 'secret key') };
    }
    if (provider === 'elasticemail') return { provider, apiKey: need('elasticEmailApiKey', 'API key') };
    return { provider, apiKey: need('resendApiKey', 'API key') };
  }

  getGoogleCredentials(): GoogleCredentials | null {
    const privateKey = this.getSecret('googlePrivateKey');
    const clientEmail = this.getSettings().serviceAccountEmail;
    if (!privateKey || !clientEmail) return null;
    return { clientEmail, privateKey };
  }

  isGoogleConfigured(): boolean {
    const s = this.getSettings();
    return Boolean(s.spreadsheetId && s.worksheetName && s.serviceAccountEmail && this.repo.get('secrets').googlePrivateKey);
  }

  /** True when the selected email provider has all its credentials stored. */
  isMailerConfigured(): boolean {
    const secrets = this.repo.get('secrets');
    return PROVIDER_SECRETS[this.getSettings().emailProvider].every((name) => Boolean(secrets[name]));
  }

  private setSecret(name: SecretName, value: string | null): void {
    const secrets = { ...this.repo.get('secrets') };
    if (value === null) {
      delete secrets[name];
    } else {
      if (!this.cipher.isAvailable()) {
        throw new Error(
          'Secure storage is not available on this system, so credentials cannot be saved. ' +
            'On Linux, install and unlock a keyring (e.g. gnome-keyring or KWallet).',
        );
      }
      secrets[name] = this.cipher.encrypt(value);
    }
    this.repo.set('secrets', secrets);
  }

  private getSecret(name: SecretName): string | null {
    const encrypted = this.repo.get('secrets')[name];
    if (!encrypted) return null;
    try {
      return this.cipher.decrypt(encrypted);
    } catch {
      this.logger.error('config', `Stored ${name} could not be decrypted; please enter it again in Settings`);
      return null;
    }
  }
}
