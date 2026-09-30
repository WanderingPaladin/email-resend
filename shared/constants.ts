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

/** Email providers have per-second rate limits (Resend's default is low); sends are throttled to stay under them. */
export const MIN_SENDS_PER_SECOND = 1;
export const MAX_SENDS_PER_SECOND = 10;
export const DEFAULT_SENDS_PER_SECOND = 2;

export const DEFAULT_WORKSHEET_NAME = 'Emails';
export const DEFAULT_FIRST_NAME_FALLBACK = 'there';

/** Number of campaigns kept in local history. */
export const CAMPAIGN_HISTORY_LIMIT = 50;

/** Maximum number of log lines kept in memory / rendered in the UI. */
export const LOG_BUFFER_LIMIT = 1000;

/** Values in the Batch Flag (or `tag`) column. */
export const TAG = {
  New: 'New',
  Processing: 'Processing',
  Sent: 'Sent',
  Failed: 'Failed',
} as const;

/** Values written to the `send_status` tracking column. */
export const SEND_STATUS = {
  Processing: 'processing',
  Sent: 'sent',
  Failed: 'failed',
  /** The provider may or may not have accepted the email. Never retried automatically. */
  Review: 'review',
} as const;

/**
 * Contact columns the app reads: a name (Name, or first_name/last_name), Email, and the
 * status column (Batch Flag, or tag). Other columns are ignored and never written.
 */
export const REQUIRED_COLUMNS = ['first_name', 'email', 'tag'] as const;

/**
 * Columns the app writes while tracking a campaign, appended to the right of the headers with
 * the operator's confirmation. Sheets from older versions may have `resend_email_id` instead of
 * `message_id`; it is used as is.
 */
export const TRACKING_COLUMNS = ['send_status', 'campaign_id', 'sent_at', 'message_id', 'last_error'] as const;
export type TrackingColumn = (typeof TRACKING_COLUMNS)[number];

/** Template variables supported in subject and body. */
export const TEMPLATE_VARIABLES = ['first_name', 'last_name', 'email'] as const;

/** Mock contact used for test emails. */
export const TEST_EMAIL_VARIABLES = {
  first_name: 'John',
  last_name: 'Doe',
  email: 'john@example.com',
} as const;

/** Email sending services the app can use. One is active at a time (Settings). */
export const EMAIL_PROVIDERS = ['resend', 'elasticemail', 'mailjet'] as const;
export type EmailProviderId = (typeof EMAIL_PROVIDERS)[number];

export const EMAIL_PROVIDER_LABELS: Record<EmailProviderId, string> = {
  resend: 'Resend',
  elasticemail: 'Elastic Email',
  mailjet: 'Mailjet',
};

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

  mailerValidate: 'mailer:validate',

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
