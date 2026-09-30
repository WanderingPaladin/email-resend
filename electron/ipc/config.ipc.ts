import { readFile, stat } from 'node:fs/promises';
import { app, BrowserWindow, clipboard, dialog } from 'electron';
import { EMAIL_PROVIDER_LABELS, IPC } from '../../shared/constants';
import { copyTextInputSchema, saveConfigInputSchema } from '../../shared/schemas';
import type { AppStatus } from '../../shared/types';
import type { AppContext } from '../app-context';
import { handle, type IpcDeps } from './handle';

export function registerConfigIpc(ctx: AppContext, deps: IpcDeps): void {
  handle(deps, IPC.configGet, null, () => ctx.config.getView());

  handle(deps, IPC.configSave, saveConfigInputSchema, (input) => ctx.config.save(input));

  // The file is chosen through a native dialog opened by the main process, so the renderer
  // can never ask us to read an arbitrary path.
  handle(deps, IPC.configImportServiceAccount, null, async (_input, event) => {
    const win = BrowserWindow.fromWebContents(event.sender) ?? undefined;
    const options: Electron.OpenDialogOptions = {
      title: 'Import Google Service Account JSON',
      properties: ['openFile'],
      filters: [{ name: 'JSON', extensions: ['json'] }],
    };
    const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
    const filePath = result.filePaths[0];
    if (result.canceled || !filePath) return { imported: false as const, clientEmail: '' };
    const info = await stat(filePath);
    if (info.size > 100_000) throw new Error('That file is too large to be a service account key.');
    const { clientEmail } = ctx.config.importServiceAccount(await readFile(filePath, 'utf8'));
    return { imported: true as const, clientEmail };
  });

  handle(deps, IPC.appStatus, null, (): AppStatus => {
    const history = ctx.campaign.getHistory();
    const marker = ctx.repo.get('activeCampaign');
    return {
      version: app.getVersion(),
      googleConfigured: ctx.config.isGoogleConfigured(),
      mailerConfigured: ctx.config.isMailerConfigured(),
      emailProviderLabel: EMAIL_PROVIDER_LABELS[ctx.config.getSettings().emailProvider],
      campaignRunning: ctx.campaign.isCampaignRunning(),
      lastCampaign: history[0] ?? null,
      recentCampaigns: history.slice(0, 10),
      manualReviewCount: ctx.repo.get('manualReview').length,
      interruptedCampaignId: marker && !ctx.campaign.isCampaignRunning() ? marker.campaignId : '',
      logDirectory: ctx.logger.logDirectory,
    };
  });

  handle(deps, IPC.appCopyText, copyTextInputSchema, ({ text }) => {
    clipboard.writeText(text);
    return true;
  });
}
