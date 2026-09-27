import { BrowserWindow, ipcMain, type IpcMainInvokeEvent } from 'electron';
import type { z } from 'zod';
import type { IpcResult } from '../../shared/types';
import { redactText } from '../services/log-format';
import type { AppLogger } from '../types/logger';

export interface IpcDeps {
  logger: AppLogger;
  /** Returns true only for our own renderer (dev server URL or the packaged index.html). */
  isTrustedUrl(url: string): boolean;
}

/**
 * Registers one invoke channel. Every payload is validated with Zod, the sender frame is
 * checked, and results are wrapped in IpcResult so errors never cross IPC as exceptions.
 */
export function handle<S extends z.ZodType, R>(
  deps: IpcDeps,
  channel: string,
  schema: S | null,
  handler: (input: z.infer<S>, event: IpcMainInvokeEvent) => Promise<R> | R,
): void {
  ipcMain.handle(channel, async (event, payload: unknown): Promise<IpcResult<R>> => {
    const url = event.senderFrame?.url ?? '';
    if (!deps.isTrustedUrl(url)) {
      deps.logger.warn('ipc', 'Rejected IPC call from untrusted frame', { channel });
      return { ok: false, error: 'Request rejected.' };
    }
    let input: z.infer<S> = undefined as z.infer<S>;
    if (schema) {
      const parsed = schema.safeParse(payload);
      if (!parsed.success) {
        const detail = parsed.error.issues
          .map((i) => `${i.path.join('.') || 'input'}: ${i.message}`)
          .join('; ');
        deps.logger.warn('ipc', 'IPC validation failed', { channel, detail });
        return { ok: false, error: `Invalid request: ${detail}` };
      }
      input = parsed.data;
    }
    try {
      return { ok: true, data: await handler(input, event) };
    } catch (error) {
      const message = redactText(error instanceof Error ? error.message : String(error), { maskEmails: false });
      deps.logger.debug('ipc', 'IPC handler returned an error', { channel, reason: message });
      return { ok: false, error: message };
    }
  });
}

/** Sends an event to every open window. */
export function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send(channel, payload);
  }
}
