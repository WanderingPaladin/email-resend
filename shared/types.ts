import type {
  CampaignStartInput,
  EmailContent,
  RecoveryApplyInput,
  SaveConfigInput,
  SendTestInput,
  Settings,
} from './schemas';

export type { CampaignStartInput, EmailContent, RecoveryApplyInput, SaveConfigInput, SendTestInput, Settings };

/** Result envelope used by every IPC invoke handler. Errors never cross IPC as exceptions. */
export type IpcResult<T> = { ok: true; data: T } | { ok: false; error: string };

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** What the renderer is allowed to see about configuration. Secrets are reduced to flags. */
export interface ConfigView {
  settings: Settings;
  hasResendApiKey: boolean;
  hasElasticEmailApiKey: boolean;
  hasMailjetApiKey: boolean;
  hasMailjetSecretKey: boolean;
  hasOpenAiApiKey: boolean;
  hasGooglePrivateKey: boolean;
  /** False when the OS cannot encrypt secrets (e.g. Linux without a keyring). */
  encryptionAvailable: boolean;
}

// ---------------------------------------------------------------------------
// Contacts
// ---------------------------------------------------------------------------

export interface ContactRow {
  /** 1-based row number in the spreadsheet. Row 1 is the header. */
  sheetRow: number;
  firstName: string;
  lastName: string;
  email: string;
  /** Batch Flag (or tag) value. */
  tag: string;
  /** Tracking columns ('' when the column does not exist yet). */
  sendStatus: string;
  campaignId: string;
  sentAt: string;
  messageId: string;
  lastError: string;
}

export type SkipReason =
  | 'invalid_email'
  | 'already_sent'
  | 'duplicate_in_campaign'
  | 'email_already_sent_elsewhere';

export interface SkippedContact {
  sheetRow: number;
  email: string;
  firstName: string;
  reason: SkipReason;
  detail: string;
}

export interface ContactPreview {
  sheetRow: number;
  firstName: string;
  lastName: string;
  email: string;
  tag: string;
}

export interface PreviewResult {
  totalRows: number;
  totalNew: number;
  selected: ContactPreview[];
  skipped: SkippedContact[];
  batchSize: number;
  /** New rows ignored because their email cell is empty. They are never emailed or listed as skipped. */
  blankEmailCount: number;
  missingTrackingColumns: string[];
  staleProcessingCount: number;
}

// ---------------------------------------------------------------------------
// Connections
// ---------------------------------------------------------------------------

export interface GoogleTestResult {
  spreadsheetTitle: string;
  worksheetName: string;
  worksheets: string[];
  /** Rows with anything in the Name, Email, Batch Flag or tracking columns. */
  rowCount: number;
  /** New rows that have an email address (the ones a campaign can send to). */
  newCount: number;
  /** New rows with an empty Email cell; they are ignored. */
  newWithoutEmailCount: number;
  /** Which sheet columns are used, e.g. { name: 'Name', email: 'Email', status: 'Batch Flag' }. */
  columns: { name: string; email: string; status: string };
  /** Header labels of the tracking columns found on the sheet. */
  trackingColumns: string[];
  missingTrackingColumns: string[];
}

export interface MailerValidationResult {
  status: 'valid' | 'restricted';
  message: string;
  verifiedDomains: string[];
  fromDomainVerified: boolean | null;
}

export interface TestEmailResult {
  /** Message ID returned by the email provider. */
  resendId: string;
}

// ---------------------------------------------------------------------------
// Campaigns
// ---------------------------------------------------------------------------

export type ContactResultStatus =
  | 'sent'
  | 'failed'
  | 'skipped'
  | 'needs_review'
  | 'not_started'
  | 'dry_run';

export interface ContactResult {
  sheetRow: number;
  name: string;
  email: string;
  status: ContactResultStatus;
  resendId: string;
  error: string;
}

export interface CampaignProgress {
  campaignId: string;
  dryRun: boolean;
  processed: number;
  total: number;
  sent: number;
  failed: number;
  skipped: number;
  needsReview: number;
  currentEmail: string;
  cancelRequested: boolean;
}

export interface CampaignSummary {
  campaignId: string;
  dryRun: boolean;
  startedAt: string;
  completedAt: string;
  selected: number;
  sent: number;
  failed: number;
  skipped: number;
  needsReview: number;
  notStarted: number;
  cancelled: boolean;
  /** Set when the campaign stopped early because of a fatal error (e.g. invalid API key). */
  abortReason: string;
  subject: string;
  results: ContactResult[];
}

export interface CampaignHistoryEntry {
  id: string;
  startedAt: string;
  completedAt: string;
  total: number;
  sent: number;
  failed: number;
  skipped: number;
  needsReview: number;
  cancelled: boolean;
  subject: string;
  results: ContactResult[];
}

export interface CampaignState {
  running: boolean;
  progress: CampaignProgress | null;
  lastSummary: CampaignSummary | null;
}

export interface CampaignStartResult {
  campaignId: string;
  selected: number;
  skipped: number;
}

// ---------------------------------------------------------------------------
// Recovery
// ---------------------------------------------------------------------------

export interface StaleContact {
  sheetRow: number;
  email: string;
  firstName: string;
  tag: string;
  sendStatus: string;
  lastError: string;
  /** Campaign that reserved the row: the campaign_id cell, or the local journal ('' if unknown). */
  campaignId: string;
  /** Message ID recorded in the local journal, if the provider accepted this email. */
  journalResendId: string;
  journalOutcome: 'accepted' | 'rejected' | 'unknown' | 'none';
}

export interface ManualReviewItem {
  id: string;
  kind: 'EMAIL_SENT_SHEET_UPDATE_FAILED';
  campaignId: string;
  sheetRow: number;
  email: string;
  resendId: string;
  timestamp: string;
  error: string;
}

export interface RecoveryState {
  staleContacts: StaleContact[];
  manualReview: ManualReviewItem[];
  interruptedCampaignId: string;
  googleError: string;
}

export interface RecoveryApplyResult {
  updated: number;
  skipped: { sheetRow: number; reason: string }[];
}

// ---------------------------------------------------------------------------
// Logs
// ---------------------------------------------------------------------------

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type LogCategory = 'app' | 'config' | 'google' | 'resend' | 'campaign' | 'finder' | 'ipc';

export interface LogEntry {
  id: string;
  timestamp: string;
  level: LogLevel;
  category: LogCategory;
  message: string;
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

export interface AppStatus {
  version: string;
  googleConfigured: boolean;
  /** The selected email provider has its credentials stored. */
  mailerConfigured: boolean;
  emailProviderLabel: string;
  campaignRunning: boolean;
  lastCampaign: CampaignHistoryEntry | null;
  recentCampaigns: CampaignHistoryEntry[];
  manualReviewCount: number;
  interruptedCampaignId: string;
  logDirectory: string;
}

// ---------------------------------------------------------------------------
// Contact search (OpenAI web search)
// ---------------------------------------------------------------------------

export interface FoundContact {
  name: string;
  email: string;
  organization: string;
  role: string;
  /** Public page where the email was found. */
  sourceUrl: string;
  /** Whether the email appears on the source page when the app opens it ('unknown' when the page could not be read). */
  emailOnPage: 'yes' | 'no' | 'unknown';
}

export interface FinderSearchResult {
  contacts: FoundContact[];
  /**
   * Results that did not count: invalid email, no source page, repeated, already in any tab of the
   * spreadsheet, or not found on the source page (those are still listed, unselected).
   */
  dropped: { invalid: number; noSource: number; duplicate: number; alreadyInSheet: number; notOnPage: number };
  /** Number of searches run to reach the target. */
  rounds: number;
  /** Requested number of contacts. */
  target: number;
  /** Usable contacts found (email on the page or page not checkable). Less than target when the search stopped short. */
  found: number;
  /** Why the search stopped early, when a later round failed. */
  warning?: string;
  /** False when the spreadsheet could not be read to drop existing contacts. */
  checkedAgainstSheet: boolean;
}

export interface FinderProgress {
  round: number;
  maxRounds: number;
  found: number;
  target: number;
}

export interface FinderSaveResult {
  tabName: string;
  rows: number;
  /** Selected contacts left out because their email is already in some tab of the spreadsheet. */
  skippedExisting: number;
  /** Selected contacts left out because the same email was selected twice. */
  skippedDuplicate: number;
}
