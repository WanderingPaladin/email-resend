import type { EmailAppApi } from '@shared/api';

declare global {
  /** Build date and git commit, set at build time (electron.vite.config.ts). */
  const __BUILD_ID__: string;

  interface Window {
    /** Exposed by electron/preload.ts through contextBridge. */
    readonly emailApp: EmailAppApi;
  }
}

export {};
