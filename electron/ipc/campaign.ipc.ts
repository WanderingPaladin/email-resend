import { IPC } from '../../shared/constants';
import {
  campaignStartInputSchema,
  dismissReviewInputSchema,
  recoveryApplyInputSchema,
  sendTestInputSchema,
} from '../../shared/schemas';
import type { AppContext } from '../app-context';
import { handle, type IpcDeps } from './handle';

export function registerCampaignIpc(ctx: AppContext, deps: IpcDeps): void {
  handle(deps, IPC.campaignSendTest, sendTestInputSchema, (input) => ctx.campaign.sendTest(input));

  handle(deps, IPC.campaignStart, campaignStartInputSchema, async (input) => {
    // Remember non-secret campaign defaults for next time.
    ctx.config.save({
      settings: {
        fromName: input.fromName,
        fromEmail: input.fromEmail,
        lastSubject: input.subject,
        lastBody: input.body,
        bodyFormat: input.bodyFormat,
        batchSize: input.batchSize,
        concurrency: input.concurrency,
      },
    });
    return ctx.campaign.startCampaign(input);
  });

  handle(deps, IPC.campaignCancel, null, () => ctx.campaign.cancelCampaign());
  handle(deps, IPC.campaignState, null, () => ctx.campaign.getState());
  handle(deps, IPC.campaignHistory, null, () => ctx.campaign.getHistory());

  handle(deps, IPC.recoveryScan, null, () => ctx.recovery.scan());
  handle(deps, IPC.recoveryApply, recoveryApplyInputSchema, (input) => ctx.recovery.apply(input));
  handle(deps, IPC.recoveryDismissReview, dismissReviewInputSchema, ({ id }) => {
    ctx.recovery.dismissReview(id);
    return true;
  });
}
