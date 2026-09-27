import type { CampaignStartInput, SaveConfigInput, SendTestInput, RecoveryApplyInput } from './schemas';
import type {
  AppStatus,
  CampaignHistoryEntry,
  CampaignProgress,
  CampaignStartResult,
  CampaignState,
  CampaignSummary,
  ConfigView,
  GoogleTestResult,
  LogEntry,
  PreviewResult,
  RecoveryApplyResult,
  RecoveryState,
  ResendValidationResult,
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
  resend: {
    validate(): Promise<ResendValidationResult>;
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
