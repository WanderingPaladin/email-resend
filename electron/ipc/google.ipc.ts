import { IPC } from '../../shared/constants';
import { previewInputSchema } from '../../shared/schemas';
import type { AppContext } from '../app-context';
import { handle, type IpcDeps } from './handle';

export function registerGoogleIpc(ctx: AppContext, deps: IpcDeps): void {
  handle(deps, IPC.googleTest, null, async () => {
    try {
      return await ctx.createSheets().testConnection();
    } catch (error) {
      ctx.logger.error('google', 'Google Sheets connection test failed', {
        reason: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  });

  handle(deps, IPC.googleInitColumns, null, async () => {
    if (ctx.campaign.isCampaignRunning()) throw new Error('A campaign is already running.');
    return { added: await ctx.createSheets().initializeTrackingColumns() };
  });

  handle(deps, IPC.contactsPreview, previewInputSchema, ({ batchSize }) => ctx.campaign.previewContacts(batchSize));

  handle(deps, IPC.resendValidate, null, async () => {
    const result = await ctx.createMailer().validateConfiguration(ctx.config.getSettings().fromEmail);
    ctx.logger.info('resend', 'Resend configuration validated', { status: result.status });
    return result;
  });
}
