# Architecture

Email Sender is an Electron desktop app. There is no separate HTTP backend: the Electron
**main process is the backend**. The React renderer is treated as untrusted UI.

```text
React renderer (src/)            no Node, no secrets, no network to Google or the email provider
      │  window.emailApp.*       typed functions only (shared/api.ts)
      ▼
Preload (electron/preload.ts)    contextBridge; one function per IPC channel
      │  ipcRenderer.invoke / on
      ▼
Main process (electron/)         Zod-validated IPC handlers → services
      │
      ├─ Google Sheets API v4 (googleapis, service-account JWT)
      ├─ Email provider: Resend SDK, or Elastic Email / Mailjet REST APIs (Chromium net.fetch)
      └─ Filesystem: settings.json (electron-store), logs/, journal/
```

## Process boundaries and security model

| Concern | Where it lives | How it is protected |
| --- | --- | --- |
| Email provider keys (Resend, Elastic Email, Mailjet API + secret), Google private key | Main process only | Encrypted with `safeStorage` (DPAPI / Keychain / libsecret) before being written to `settings.json`. Never sent to the renderer: the renderer only sees `has…` flags. |
| Service account JSON | Main process | Chosen through a native file dialog opened by the main process; only `client_email` and the encrypted `private_key` are kept. The file itself is not copied. |
| IPC | `electron/ipc/*` | Every payload is parsed with a Zod schema (`shared/schemas.ts`); the sender frame must be the app's own page. Handlers return `{ ok, data \| error }`. |
| Limits | `campaign.service.ts`, `sheet-parser.ts` | The email limit (batch size) is clamped to 1–10,000 and concurrency to 1–10 in the main process, independently of the IPC schema. |
| Email editor and preview | `HtmlVisualEditor.tsx` | The email's HTML is shown only inside sandboxed iframes without `allow-scripts`: nothing in it can run, and its CSS cannot affect the app. |
| Renderer | `BrowserWindow` | `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`, no `remote`, no webviews, navigation and new windows blocked, all permission requests denied, strict CSP (header + meta tag), DevTools disabled in packaged builds. |
| Logs | `logger.service.ts` + `log-format.ts` | Every message and field passes through redaction: provider API keys, PEM private keys, bearer tokens and secret-named fields are replaced; email addresses are masked (`ma***@example.com`). |
| Sheet writes | `google-sheets.service.ts` | `valueInputOption: RAW` so text can never become a formula. |

## Services (electron/services)

| File | Responsibility |
| --- | --- |
| `config.service.ts` | Settings (electron-store) + encrypted secrets. |
| `google-sheets.service.ts` | Connection test, reading/parsing the sheet, tracking-column initialization (widening the grid first), verified row updates, creating a new tab for Find Contacts results. |
| `contact-finder.service.ts` | Find Contacts: OpenAI Responses API with the `web_search` tool, JSON parsing, cleaning, and opening each public source page to check the email is on it (private and local addresses are never opened). |
| `finder-usage.service.ts` | Saves each search run's token counts, web search calls and estimated cost (`shared/usage.ts` holds the list prices and day/week/month totals). |
| `sheet-parser.ts` | Pure logic: finds the Name (or first/last name), Email, Batch Flag and tracking columns by header name, row numbers, New selection, validation, skip reasons, stale detection. |
| `shared/template.ts` | Pure `{{variable}}` rendering, plain-text → HTML, escaping. Shared with the renderer for the live preview. |
| `mailer.ts` | Provider-neutral `Mailer` interface and base class: throttling, safe retries, `SendResult`. |
| `resend.service.ts`, `elastic-email.service.ts`, `mailjet.service.ts` | One request per provider, error classification (fatal / ambiguous / retryable), key validation without sending. |
| `campaign.service.ts` | Orchestration: lock, selection, reservation, `p-limit` concurrency, sending, batched status writes, cancellation, history, progress events. |
| `recovery.service.ts` | Finds rows left in Processing and applies operator decisions. Never sends email. |
| `journal.service.ts` | Append-only local record of each send outcome, written before the sheet is updated. |
| `logger.service.ts` | electron-log with `main.log` and `campaign.log`, rotation at 5 MB, live events to the UI. |

## Campaign data flow

```text
startCampaign()
  ├─ lock (synchronous, before any await)       → "A campaign is already running."
  ├─ validate template variables
  ├─ read sheet once, parse headers by name
  ├─ ensure tracking columns (only with operator confirmation)
  ├─ selectContacts(): Batch Flag = New, email not empty (empty rows are ignored), valid email,
  │                    no previous send, not awaiting manual review, no duplicate email, up to the email limit
  ├─ reserve all selected rows in ONE batch write: Batch Flag=Processing, send_status=processing, campaign_id
  │    (each row re-verified against a fresh read: still New, same email)
  └─ run in background with p-limit(concurrency)
        for each contact:
          cancelled / fatal error? → not started (returned to New at the end)
          render → provider (Resend gets idempotency key = campaignId:row) → journal the outcome
          ├─ accepted  → queue: Batch Flag=Sent, send_status=sent, sent_at, message_id, last_error=""
          ├─ rejected  → queue: Batch Flag=Failed, send_status=failed, last_error
          ├─ unknown   → queue: Batch Flag stays Processing, send_status=review (manual review)
          └─ fatal (bad key, quota, sender domain) → stop scheduling
        queued updates are flushed every 3 s / 25 rows as one verified batch write
        flush failed for an accepted email → EMAIL_SENT_SHEET_UPDATE_FAILED (warn + manual-review list)
  finally: release unstarted rows to New, save history, emit campaign:complete
```

### Why status writes are batched

Google Sheets allows roughly 60 write requests per minute per user. A 100-contact campaign with
one write per contact (plus a reservation write each) would exceed that. Reservation is one
batch write; final statuses are flushed in batches. A crash between "provider accepted" and the
flush leaves the row in Processing, which is the safe state: it will never be picked up as New,
and the local journal lets the Review screen show that the provider accepted it.

### Why rows are verified before every write

Row numbers are the source of truth for updates, but someone may insert, delete or sort rows
while a campaign runs. Before each batch write the sheet is re-read and each update is applied
only if the row at the recorded number still has the same email (and campaign ID). If the row
moved, it is re-located by email + campaign ID; if that is ambiguous, the update is not written
and the row goes to manual review.

## Duplicate-send protection summary

1. Single app instance (`app.requestSingleInstanceLock()`).
2. One campaign at a time (in-memory lock, taken synchronously).
3. Contacts are reserved in the sheet before any send.
4. Rows with Batch Flag `Sent`, `send_status = sent` or a `message_id` are never selected; an email
   already sent from another row, or accepted but still awaiting manual review, is skipped.
5. Resend idempotency keys (`campaignId:row`) make retries of the same request safe. Elastic Email and
   Mailjet have no such key, so only rate-limit errors are retried there.
6. Ambiguous outcomes (network failure, 5xx) are never retried without that key and end in manual review.
7. Stale Processing rows after a crash are shown for review; they are never resent automatically,
   and "Mark as New" is refused for rows the journal shows the provider accepted.

## IPC channels

| Channel | Direction | Payload schema |
| --- | --- | --- |
| `app:status`, `app:copy-text` | invoke | — / `copyTextInputSchema` |
| `config:get`, `config:save`, `config:import-service-account` | invoke | — / `saveConfigInputSchema` / — |
| `google:test`, `google:init-columns`, `contacts:preview` | invoke | — / — / `previewInputSchema` |
| `mailer:validate` | invoke | — |
| `openai:validate` | invoke | — |
| `finder:search`, `finder:save` | invoke | `finderSearchInputSchema` / `finderSaveInputSchema` |
| `finder:usage`, `finder:usage-clear` | invoke | none (no input) |
| `campaign:send-test`, `campaign:start`, `campaign:cancel`, `campaign:state`, `campaign:history` | invoke | `sendTestInputSchema` / `campaignStartInputSchema` / — |
| `recovery:scan`, `recovery:apply`, `recovery:dismiss-review` | invoke | — / `recoveryApplyInputSchema` / `dismissReviewInputSchema` |
| `logs:get`, `logs:clear`, `logs:open-folder` | invoke | — |
| `campaign:progress`, `campaign:complete`, `logger:event` | main → renderer | `CampaignProgress`, `CampaignSummary`, `LogEntry` |
