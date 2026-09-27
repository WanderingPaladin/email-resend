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
  company: string;
  tag: string;
  sendStatus: string;
  campaignId: string;
  sentAt: string;
  resendEmailId: string;
  lastError: string;
  unsubscribed: string;
}

export type SkipReason =
  | 'blank_email'
  | 'invalid_email'
  | 'unsubscribed'
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
  company: string;
  tag: string;
}

export interface PreviewResult {
  totalRows: number;
  totalNew: number;
  selected: ContactPreview[];
  skipped: SkippedContact[];
  batchSize: number;
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
  rowCount: number;
  newCount: number;
  headers: string[];
  missingTrackingColumns: string[];
}

export interface ResendValidationResult {
  status: 'valid' | 'restricted';
  message: string;
  verifiedDomains: string[];
  fromDomainVerified: boolean | null;
}

export interface TestEmailResult {
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
  campaignId: string;
  lastError: string;
  /** Resend ID recorded in the local journal, if Resend accepted this email. */
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
export type LogCategory = 'app' | 'config' | 'google' | 'resend' | 'campaign' | 'ipc';

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
  resendConfigured: boolean;
  campaignRunning: boolean;
  lastCampaign: CampaignHistoryEntry | null;
  recentCampaigns: CampaignHistoryEntry[];
  manualReviewCount: number;
  interruptedCampaignId: string;
  logDirectory: string;
}
