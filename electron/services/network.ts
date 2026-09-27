import { net } from 'electron';

/**
 * fetch backed by Chromium's network stack (Electron `net.fetch`).
 *
 * Node's own HTTP client ignores the operating system's network configuration: Windows proxy
 * settings, PAC scripts, VPN DNS and corporate certificates. On networks that need any of those,
 * requests from the main process fail with errors such as ENOTFOUND even though the browser works.
 * Routing Google and Resend traffic through Chromium makes the app behave like the browser.
 * Must be used after `app.whenReady()`.
 */
export const chromiumFetch = ((input: Parameters<typeof fetch>[0], init?: RequestInit) =>
  net.fetch(input instanceof URL ? input.toString() : (input as string | Request), init)) as typeof fetch;

/** Makes libraries that call the global fetch (the Resend SDK) use Chromium's network stack. */
export function useChromiumNetworkStack(): void {
  globalThis.fetch = chromiumFetch;
}
