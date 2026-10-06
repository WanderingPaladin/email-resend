import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import type { EmailAppApi, Unsubscribe } from '../shared/api';
import { IPC } from '../shared/constants';
import type { CampaignProgress, CampaignSummary, FinderProgress, FinderRunState, IpcResult, LogEntry } from '../shared/types';

/**
 * Preload bridge. Only the specific operations below are exposed; there is no generic
 * send/invoke. Results are unwrapped here so the renderer gets normal promises.
 */

async function invoke<T>(channel: string, payload?: unknown): Promise<T> {
  const result = (await ipcRenderer.invoke(channel, payload)) as IpcResult<T>;
  if (!result.ok) throw new Error(result.error);
  return result.data;
}

function subscribe<T>(channel: string, listener: (payload: T) => void): Unsubscribe {
  const wrapped = (_event: IpcRendererEvent, payload: T) => listener(payload);
  ipcRenderer.on(channel, wrapped);
  return () => {
    ipcRenderer.removeListener(channel, wrapped);
  };
}

const api: EmailAppApi = {
  app: {
    getStatus: () => invoke(IPC.appStatus),
    copyText: (text) => invoke(IPC.appCopyText, { text }),
  },
  config: {
    get: () => invoke(IPC.configGet),
    save: (input) => invoke(IPC.configSave, input),
    importServiceAccount: () => invoke(IPC.configImportServiceAccount),
  },
  google: {
    testConnection: () => invoke(IPC.googleTest),
    initializeTrackingColumns: () => invoke(IPC.googleInitColumns),
    listTabs: () => invoke(IPC.googleTabs),
    previewContacts: (batchSize) => invoke(IPC.contactsPreview, { batchSize }),
  },
  finder: {
    validate: () => invoke(IPC.openaiValidate),
    search: (input) => invoke(IPC.finderSearch, input),
    cancel: () => invoke(IPC.finderCancel),
    listTabs: () => invoke(IPC.finderTabs),
    save: (input) => invoke(IPC.finderSave, input),
    onProgress: (listener) => subscribe<FinderProgress>(IPC.finderProgress, listener),
    state: () => invoke(IPC.finderState),
    onDone: (listener) => subscribe<FinderRunState>(IPC.finderDone, listener),
    recent: () => invoke(IPC.finderRecent),
    openSaved: (id) => invoke(IPC.finderOpenSaved, { id }),
    usage: () => invoke(IPC.finderUsage),
    clearUsage: () => invoke(IPC.finderUsageClear),
  },
  templates: {
    list: () => invoke(IPC.templatesList),
    save: (input) => invoke(IPC.templatesSave, input),
    delete: (id) => invoke(IPC.templatesDelete, { id }),
  },
  mailer: {
    validate: () => invoke(IPC.mailerValidate),
  },
  campaign: {
    sendTest: (input) => invoke(IPC.campaignSendTest, input),
    start: (input) => invoke(IPC.campaignStart, input),
    cancel: () => invoke(IPC.campaignCancel),
    getState: () => invoke(IPC.campaignState),
    getHistory: () => invoke(IPC.campaignHistory),
    onProgress: (listener) => subscribe<CampaignProgress>(IPC.campaignProgress, listener),
    onComplete: (listener) => subscribe<CampaignSummary>(IPC.campaignComplete, listener),
  },
  recovery: {
    scan: () => invoke(IPC.recoveryScan),
    apply: (input) => invoke(IPC.recoveryApply, input),
    dismissReview: (id) => invoke(IPC.recoveryDismissReview, { id }),
  },
  logs: {
    get: () => invoke(IPC.logsGet),
    clear: () => invoke(IPC.logsClear),
    openFolder: () => invoke(IPC.logsOpenFolder),
    onLog: (listener) => subscribe<LogEntry>(IPC.logsEvent, listener),
  },
};

contextBridge.exposeInMainWorld('emailApp', api);
