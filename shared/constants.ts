/**
 * Constants shared by the main process, preload and renderer.
 * Limits here are enforced in the main process; the renderer only uses them for form hints.
 */

export const APP_NAME = 'Email Sender';

/** Hard upper bound on contacts per campaign. Enforced in the main process. */
export const MAX_BATCH_SIZE = 100;
export const MIN_BATCH_SIZE = 1;
export const DEFAULT_BATCH_SIZE = 100;

export const MIN_CONCURRENCY = 1;
export const MAX_CONCURRENCY = 10;
export const DEFAULT_CONCURRENCY = 5;

/** Resend's default team rate limit is low; we throttle sends to stay under it. */
export const MIN_SENDS_PER_SECOND = 1;
export const MAX_SENDS_PER_SECOND = 10;
export const DEFAULT_SENDS_PER_SECOND = 2;

export const DEFAULT_WORKSHEET_NAME = 'Emails';
export const DEFAULT_FIRST_NAME_FALLBACK = 'there';

/** Number of campaigns kept in local history. */
export const CAMPAIGN_HISTORY_LIMIT = 50;

/** Maximum number of log lines kept in memory / rendered in the UI. */
export const LOG_BUFFER_LIMIT = 1000;

/** Values written to the `tag` column. */
export const TAG = {
  New: 'New',
  Processing: 'Processing',
  Sent: 'Sent',
  Failed: 'Failed',
} as const;

/** Values written to the `send_status` column. */
export const SEND_STATUS = {
  Processing: 'processing',
  Sent: 'sent',
  Failed: 'failed',
  /** Resend may or may not have accepted the email. Never retried automatically. */
  Review: 'review',
} as const;

/** Columns the app needs to find contacts. */
export const REQUIRED_COLUMNS = ['first_name', 'email', 'tag'] as const;

/** Columns the app writes to while tracking a campaign. */
export const TRACKING_COLUMNS = [
  'send_status',
  'campaign_id',
  'sent_at',
  'resend_email_id',
  'last_error',
] as const;

export const OPTIONAL_COLUMNS = ['last_name', 'company', 'unsubscribed'] as const;

/** Values in the `unsubscribed` column that mean "never email this contact". */
export const UNSUBSCRIBED_VALUES = ['true', 'yes', '1', 'unsubscribed'] as const;

/** Template variables supported in subject and body. */
export const TEMPLATE_VARIABLES = ['first_name', 'last_name', 'email', 'company'] as const;

/** Mock contact used for test emails. */
export const TEST_EMAIL_VARIABLES = {
  first_name: 'John',
  last_name: 'Doe',
  email: 'john@example.com',
  company: 'Example Inc.',
} as const;

/** Marker used in logs when an email was accepted but the sheet could not be updated. */
export const EMAIL_SENT_SHEET_UPDATE_FAILED = 'EMAIL_SENT_SHEET_UPDATE_FAILED';

/**
 * IPC channel names. Every channel is registered explicitly in the main process
 * and exposed through a dedicated preload function; there is no generic IPC bridge.
 */
export const IPC = {
  appStatus: 'app:status',
  appCopyText: 'app:copy-text',

  configGet: 'config:get',
  configSave: 'config:save',
  configImportServiceAccount: 'config:import-service-account',

  googleTest: 'google:test',
  googleInitColumns: 'google:init-columns',
  contactsPreview: 'contacts:preview',

  resendValidate: 'resend:validate',

  campaignSendTest: 'campaign:send-test',
  campaignStart: 'campaign:start',
  campaignCancel: 'campaign:cancel',
  campaignState: 'campaign:state',
  campaignHistory: 'campaign:history',
  campaignProgress: 'campaign:progress',
  campaignComplete: 'campaign:complete',

  recoveryScan: 'recovery:scan',
  recoveryApply: 'recovery:apply',
  recoveryDismissReview: 'recovery:dismiss-review',

  logsGet: 'logs:get',
  logsClear: 'logs:clear',
  logsOpenFolder: 'logs:open-folder',
  logsEvent: 'logger:event',
} as const;
