import { join } from 'node:path';
import { app } from 'electron';
import { IPC } from '../shared/constants';
import { broadcast } from './ipc/handle';
import { createElectronSettingsRepository, type SettingsRepository } from './repositories/settings.repository';
import { CampaignService } from './services/campaign.service';
import { ConfigService } from './services/config.service';
import { ContactFinder } from './services/contact-finder.service';
import { createSheetsClient, GoogleSheetsService } from './services/google-sheets.service';
import { createFileJournal } from './services/journal.service';
import { LoggerService } from './services/logger.service';
import { chromiumFetch } from './services/network';
import { RecoveryService } from './services/recovery.service';
import { ElasticEmailService } from './services/elastic-email.service';
import { MailjetService } from './services/mailjet.service';
import type { Mailer } from './services/mailer';
import { createResendClient, ResendService } from './services/resend.service';
import { safeStorageCipher } from './services/secret-cipher';

/** Every long-lived main-process service, created once at startup. */
export interface AppContext {
  logger: LoggerService;
  repo: SettingsRepository;
  config: ConfigService;
  campaign: CampaignService;
  recovery: RecoveryService;
  createSheets(): GoogleSheetsService;
  createMailer(): Mailer;
  createFinder(): ContactFinder;
}

export function createAppContext(): AppContext {
  const logger = new LoggerService(join(app.getPath('userData'), 'logs'), { console: !app.isPackaged });
  logger.onLog((entry) => broadcast(IPC.logsEvent, entry));

  const repo = createElectronSettingsRepository();
  const config = new ConfigService(repo, safeStorageCipher, logger);
  const journal = createFileJournal(join(app.getPath('userData'), 'journal'));

  const createSheets = (): GoogleSheetsService => {
    const settings = config.getSettings();
    const credentials = config.getGoogleCredentials();
    if (!settings.spreadsheetId) throw new Error('Spreadsheet ID is not set. Configure it in Settings.');
    if (!settings.worksheetName) throw new Error('Worksheet name is not set. Configure it in Settings.');
    if (!credentials) {
      throw new Error('Google credentials are not configured. Import the service account JSON in Settings.');
    }
    return new GoogleSheetsService(
      createSheetsClient(credentials, chromiumFetch),
      {
        spreadsheetId: settings.spreadsheetId,
        worksheetName: settings.worksheetName,
        serviceAccountEmail: settings.serviceAccountEmail,
      },
      logger,
    );
  };

  /** Builds a client for the provider selected in Settings. Throws a user-facing error when it is not configured. */
  const createMailer = (): Mailer => {
    const credentials = config.getMailerCredentials();
    const options = { sendsPerSecond: config.getSettings().sendsPerSecond };
    switch (credentials.provider) {
      case 'elasticemail':
        return new ElasticEmailService(credentials.apiKey, logger, options, chromiumFetch);
      case 'mailjet':
        return new MailjetService(credentials.apiKey, credentials.secretKey, logger, options, chromiumFetch);
      default:
        return new ResendService(createResendClient(credentials.apiKey), logger, options);
    }
  };

  const createFinder = (): ContactFinder => {
    const { apiKey, model } = config.getOpenAiCredentials();
    return new ContactFinder(apiKey, model, logger, chromiumFetch);
  };

  const campaign = new CampaignService({
    logger,
    repo,
    journal,
    getSettings: () => config.getSettings(),
    createSheets,
    createMailer,
    events: {
      progress: (progress) => broadcast(IPC.campaignProgress, progress),
      complete: (summary) => broadcast(IPC.campaignComplete, summary),
    },
  });

  const recovery = new RecoveryService({
    logger,
    repo,
    journal,
    isGoogleConfigured: () => config.isGoogleConfigured(),
    createSheets,
    isCampaignRunning: () => campaign.isCampaignRunning(),
  });

  return { logger, repo, config, campaign, recovery, createSheets, createMailer, createFinder };
}
