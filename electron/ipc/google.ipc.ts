import { IPC } from '../../shared/constants';
import { previewInputSchema, templateDeleteInputSchema, templateSaveInputSchema } from '../../shared/schemas';
import type { AppContext } from '../app-context';
import { TemplateStore } from '../services/template-store.service';
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

  handle(deps, IPC.googleTabs, null, () => ctx.createSheets().listWorksheets());

  const templates = new TemplateStore(ctx.repo);
  handle(deps, IPC.templatesList, null, () => templates.list());
  handle(deps, IPC.templatesSave, templateSaveInputSchema, (input) => {
    const saved = templates.save(input);
    ctx.logger.info('campaign', `Template "${saved.name}" saved`);
    return saved;
  });
  handle(deps, IPC.templatesDelete, templateDeleteInputSchema, ({ id }) => {
    templates.delete(id);
    return true;
  });

  handle(deps, IPC.contactsPreview, previewInputSchema, ({ batchSize }) => ctx.campaign.previewContacts(batchSize));

  handle(deps, IPC.mailerValidate, null, async () => {
    const mailer = ctx.createMailer();
    const result = await mailer.validateConfiguration(ctx.config.getSettings().fromEmail);
    ctx.logger.info('resend', `${mailer.providerLabel} configuration validated`, { status: result.status });
    return result;
  });
}
