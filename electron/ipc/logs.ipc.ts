import { shell } from 'electron';
import { IPC } from '../../shared/constants';
import type { AppContext } from '../app-context';
import { handle, type IpcDeps } from './handle';

export function registerLogsIpc(ctx: AppContext, deps: IpcDeps): void {
  handle(deps, IPC.logsGet, null, () => ctx.logger.getLogs());

  handle(deps, IPC.logsClear, null, () => {
    ctx.logger.clear();
    return true;
  });

  // Opens only the app's own log directory; the renderer cannot pass a path.
  handle(deps, IPC.logsOpenFolder, null, async () => {
    const error = await shell.openPath(ctx.logger.logDirectory);
    if (error) throw new Error(error);
    return true;
  });
}
