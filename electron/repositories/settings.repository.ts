import Store from 'electron-store';
import type { Settings } from '../../shared/schemas';
import type { CampaignHistoryEntry, ManualReviewItem } from '../../shared/types';

/** Encrypted secrets, stored as base64 of safeStorage ciphertext. Never plain text. */
export interface EncryptedSecrets {
  resendApiKey?: string;
  elasticEmailApiKey?: string;
  mailjetApiKey?: string;
  mailjetSecretKey?: string;
  openaiApiKey?: string;
  googlePrivateKey?: string;
}

export interface ActiveCampaignMarker {
  campaignId: string;
  startedAt: string;
}

export interface StoreSchema {
  settings: Partial<Settings>;
  secrets: EncryptedSecrets;
  campaignHistory: CampaignHistoryEntry[];
  manualReview: ManualReviewItem[];
  /** Set while a real campaign runs; left behind if the app crashes mid-campaign. */
  activeCampaign: ActiveCampaignMarker | null;
}

/** Small persistence abstraction so services can be tested without Electron. */
export interface SettingsRepository {
  get<K extends keyof StoreSchema>(key: K): StoreSchema[K];
  set<K extends keyof StoreSchema>(key: K, value: StoreSchema[K]): void;
}

const DEFAULTS: StoreSchema = {
  settings: {},
  secrets: {},
  campaignHistory: [],
  manualReview: [],
  activeCampaign: null,
};

/** electron-store writes JSON atomically to <userData>/settings.json. */
export function createElectronSettingsRepository(): SettingsRepository {
  const store = new Store<StoreSchema>({ name: 'settings', defaults: DEFAULTS, clearInvalidConfig: false });
  return {
    get: (key) => store.get(key),
    set: (key, value) => store.set(key, value),
  };
}

export function createMemorySettingsRepository(initial: Partial<StoreSchema> = {}): SettingsRepository {
  const data: StoreSchema = structuredClone({ ...DEFAULTS, ...initial });
  return {
    get: (key) => structuredClone(data[key]),
    set: (key, value) => {
      data[key] = structuredClone(value);
    },
  };
}
