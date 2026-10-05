import type { FinderUsageRecord } from './usage';
import type { CampaignStartInput, FinderSaveInput, FinderSearchInput, SaveConfigInput, SendTestInput, RecoveryApplyInput } from './schemas';
import type {
  AppStatus,
  CampaignHistoryEntry,
  CampaignProgress,
  CampaignStartResult,
  CampaignState,
  CampaignSummary,
  ConfigView,
  FinderProgress,
  FinderSaveResult,
  FinderSearchResult,
  GoogleTestResult,
  LogEntry,
  PreviewResult,
  RecoveryApplyResult,
  RecoveryState,
  MailerValidationResult,
  TestEmailResult,
} from './types';

export type Unsubscribe = () => void;

/**
 * The complete API exposed to the renderer as `window.emailApp`.
 * Each method maps to exactly one validated IPC channel. Methods reject with an Error
 * carrying a user-facing message when the main process reports a failure.
 */
export interface EmailAppApi {
  app: {
    getStatus(): Promise<AppStatus>;
    copyText(text: string): Promise<boolean>;
  };
  config: {
    get(): Promise<ConfigView>;
    save(input: SaveConfigInput): Promise<ConfigView>;
    importServiceAccount(): Promise<{ imported: boolean; clientEmail: string }>;
  };
  google: {
    testConnection(): Promise<GoogleTestResult>;
    initializeTrackingColumns(): Promise<{ added: string[] }>;
    previewContacts(batchSize: number): Promise<PreviewResult>;
  };
  finder: {
    /** Checks the OpenAI key and model without running a search. */
    validate(): Promise<{ message: string }>;
    search(input: FinderSearchInput): Promise<FinderSearchResult>;
    /** Stops a running search; what was found so far is returned by search(). */
    cancel(): Promise<boolean>;
    /** Tab names of the spreadsheet, for choosing where to save. */
    listTabs(): Promise<string[]>;
    /** Saves the contacts to a new tab, or below the last row of an existing tab. */
    save(input: FinderSaveInput): Promise<FinderSaveResult>;
    /** Progress of a running search (one event per search round). */
    onProgress(listener: (progress: FinderProgress) => void): Unsubscribe;
    /** Every search run on this computer with its estimated OpenAI cost, newest first. */
    usage(): Promise<FinderUsageRecord[]>;
    /** Deletes the saved cost history. */
    clearUsage(): Promise<boolean>;
  };
  mailer: {
    /** Checks the selected provider's credentials without sending an email. */
    validate(): Promise<MailerValidationResult>;
  };
  campaign: {
    sendTest(input: SendTestInput): Promise<TestEmailResult>;
    start(input: CampaignStartInput): Promise<CampaignStartResult>;
    cancel(): Promise<boolean>;
    getState(): Promise<CampaignState>;
    getHistory(): Promise<CampaignHistoryEntry[]>;
    onProgress(listener: (progress: CampaignProgress) => void): Unsubscribe;
    onComplete(listener: (summary: CampaignSummary) => void): Unsubscribe;
  };
  recovery: {
    scan(): Promise<RecoveryState>;
    apply(input: RecoveryApplyInput): Promise<RecoveryApplyResult>;
    dismissReview(id: string): Promise<boolean>;
  };
  logs: {
    get(): Promise<LogEntry[]>;
    clear(): Promise<boolean>;
    openFolder(): Promise<boolean>;
    onLog(listener: (entry: LogEntry) => void): Unsubscribe;
  };
}
