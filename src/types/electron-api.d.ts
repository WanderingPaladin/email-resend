import type { EmailAppApi } from '@shared/api';

declare global {
  interface Window {
    /** Exposed by electron/preload.ts through contextBridge. */
    readonly emailApp: EmailAppApi;
  }
}

export {};
