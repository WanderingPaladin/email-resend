import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { app, BrowserWindow, dialog, Menu, session, shell, type MenuItemConstructorOptions } from 'electron';
import { APP_NAME } from '../shared/constants';
import { createAppContext, type AppContext } from './app-context';
import { registerCampaignIpc } from './ipc/campaign.ipc';
import { registerConfigIpc } from './ipc/config.ipc';
import { registerGoogleIpc } from './ipc/google.ipc';
import type { IpcDeps } from './ipc/handle';
import { registerLogsIpc } from './ipc/logs.ipc';
import { useChromiumNetworkStack } from './services/network';
import { safeStorageCipher } from './services/secret-cipher';

const isDev = !app.isPackaged;
const devServerUrl = process.env['ELECTRON_RENDERER_URL'];
const rendererIndex = join(import.meta.dirname, '../renderer/index.html');
const rendererFileUrl = pathToFileURL(rendererIndex).href;

let mainWindow: BrowserWindow | null = null;
let ctx: AppContext | null = null;

/** Only our own renderer may call IPC or be navigated to. */
function isTrustedUrl(url: string): boolean {
  if (!url) return false;
  const withoutHash = url.split('#')[0]?.split('?')[0] ?? '';
  if (devServerUrl && isDev) {
    try {
      return new URL(url).origin === new URL(devServerUrl).origin;
    } catch {
      return false;
    }
  }
  return withoutHash === rendererFileUrl;
}

// Production CSP (remote https images are allowed so email previews show them). The same policy is injected as a <meta> tag into the built index.html
// (see electron.vite.config.ts) because response headers do not apply to file:// pages.
const PROD_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
// Vite's dev server needs inline scripts (React refresh) and a websocket for HMR.
const DEV_CSP =
  "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; connect-src 'self' ws: http://localhost:*; object-src 'none'; base-uri 'none'";

// ---------------------------------------------------------------------------
// 1. Single instance: a second launch focuses the existing window and exits.
// ---------------------------------------------------------------------------
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });

  void app.whenReady().then(startup);

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0 && ctx) createWindow();
  });
}

function startup(): void {
  // Google and Resend requests go through Chromium so Windows proxy/VPN/DNS settings apply.
  useChromiumNetworkStack();
  // 2. Logger (inside the app context) and 3. safe configuration.
  ctx = createAppContext();
  const { logger } = ctx;
  logger.info('app', 'Application started', { version: app.getVersion(), platform: process.platform, packaged: app.isPackaged });

  if (!safeStorageCipher.isAvailable()) {
    logger.warn('config', 'OS secure storage is not available; credentials cannot be saved until it is');
  }

  process.on('uncaughtException', (error) => logger.error('app', 'Uncaught exception', { reason: error.message }));
  process.on('unhandledRejection', (reason) =>
    logger.error('app', 'Unhandled promise rejection', { reason: reason instanceof Error ? reason.message : String(reason) }),
  );

  hardenSessions();

  const deps: IpcDeps = { logger, isTrustedUrl };
  registerConfigIpc(ctx, deps);
  registerGoogleIpc(ctx, deps);
  registerCampaignIpc(ctx, deps);
  registerLogsIpc(ctx, deps);

  Menu.setApplicationMenu(buildMenu());

  // 4. Window.
  createWindow();

  // 5. Unfinished previous campaign.
  const marker = ctx.repo.get('activeCampaign');
  if (marker) {
    logger.warn('campaign', 'The previous campaign did not finish (app closed or crashed). Contacts it left in Processing will not be resent automatically.', {
      campaignId: marker.campaignId,
      startedAt: marker.startedAt,
    });
  }
  const reviewCount = ctx.repo.get('manualReview').length;
  if (reviewCount > 0) {
    logger.warn('campaign', `${reviewCount} sent email(s) still need their sheet row confirmed. Manual review required.`);
  }

  // 6./7. Stale Processing rows are detected by the recovery scan, which the renderer runs on
  // launch and shows as a warning banner. We also run it here so the result lands in the logs.
  if (ctx.config.isGoogleConfigured()) {
    void ctx.recovery.scan().catch(() => undefined);
  }
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 1000,
    minHeight: 650,
    title: APP_NAME,
    show: false,
    backgroundColor: '#f8fafc',
    // Packaged builds take their icon from the executable (see electron-builder.yml).
    ...(isDev ? { icon: join(import.meta.dirname, '../../assets/icon.png') } : {}),
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      spellcheck: true,
      devTools: isDev,
    },
  });

  mainWindow.once('ready-to-show', () => mainWindow?.show());

  // Closing during a campaign leaves contacts in Processing; ask first.
  mainWindow.on('close', (event) => {
    if (!ctx?.campaign.isCampaignRunning() || !mainWindow) return;
    const choice = dialog.showMessageBoxSync(mainWindow, {
      type: 'warning',
      buttons: ['Keep Running', 'Quit Anyway'],
      defaultId: 0,
      cancelId: 0,
      title: 'Campaign in progress',
      message: 'A campaign is still sending.',
      detail:
        'If you quit now, contacts that are mid-send will stay in Processing and must be reviewed on the next launch. They will not be resent automatically.',
    });
    if (choice === 0) event.preventDefault();
    else ctx.logger.warn('campaign', 'Application closed while a campaign was running');
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  if (isDev && devServerUrl) {
    void mainWindow.loadURL(devServerUrl);
  } else {
    void mainWindow.loadFile(rendererIndex);
  }
}

function hardenSessions(): void {
  const csp = isDev ? DEV_CSP : PROD_CSP;
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({ responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': [csp] } });
  });
  // The app needs no camera, notifications, geolocation, etc.
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);

  app.on('web-contents-created', (_event, contents) => {
    contents.setWindowOpenHandler(({ url }) => {
      // Documentation links open in the user's browser; nothing opens inside the app.
      if (url.startsWith('https://')) void shell.openExternal(url);
      return { action: 'deny' };
    });
    contents.on('will-navigate', (event, url) => {
      if (!isTrustedUrl(url)) event.preventDefault();
    });
    contents.on('will-attach-webview', (event) => event.preventDefault());
  });
}

function buildMenu(): Menu {
  const template: MenuItemConstructorOptions[] = [
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' as const }] : []),
    { role: 'fileMenu' },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        ...(isDev ? [{ type: 'separator' as const }, { role: 'reload' as const }, { role: 'toggleDevTools' as const }] : []),
      ],
    },
    { role: 'windowMenu' },
  ];
  return Menu.buildFromTemplate(template);
}
