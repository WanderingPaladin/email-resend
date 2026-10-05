# Email Sender

A desktop utility (Electron + React + TypeScript) that reads contacts whose **Batch Flag** is **New**
from the `Emails` worksheet of a Google Sheet, sends each one a personalized email through
[Resend](https://resend.com), [Elastic Email](https://elasticemail.com) or [Mailjet](https://www.mailjet.com),
and marks the row **Sent** or **Failed**. It is built to avoid
duplicate sends, to survive crashes and partial failures, and to be easy to debug through logs.

> Only email contacts you are authorized to email.

## Features

- Google Sheets and email provider (Resend, Elastic Email or Mailjet) configuration, with credentials encrypted by the operating system (`safeStorage`)
- Contact preview (up to 100 per campaign), template variables
- Email editor with Visual (formatted), HTML code and Plain text modes, and a live rendered preview
- Test email, dry run, confirmation step, live progress, cancel, results table
- Controlled concurrency (`p-limit`) and a send-rate throttle for the provider's rate limit
- Duplicate-send protection, crash recovery and a Review screen for ambiguous rows
- Persistent logs with masking and secret redaction, live log viewer
- Local campaign history (last 50)
- Windows installer (NSIS) via electron-builder

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the process model, security model and campaign algorithm.

## Requirements

- Node.js 22 or newer and npm
- A Google Cloud account (for a service account with Google Sheets API access)
- An account with Resend, Elastic Email or Mailjet, with a verified sending domain or sender

## Install

```bash
npm install
```

## Run (development)

```bash
npm run dev
```

## Build

```bash
npm run build
```

Type-checks and bundles the main process, preload and renderer into `out/`.

## Create the Windows installer

```bash
npm run dist
```

Run this on Windows. The installer is written to `release/<version>/Email Sender-Setup-<version>.exe`,
and the same app without an installer to `release/<version>/win-unpacked/` (run `Email Sender.exe` there).
Building the Windows installer from Linux or macOS requires Wine (on Linux both `wine64` and `wine32:i386`), so use a Windows machine or the
CI workflow: in GitHub, open **Actions → CI → Run workflow** and download the `windows-installer`
artifact, or `windows-app-no-install` to run the app without installing it (unzip it and run `Email Sender.exe`;
keep the whole folder together). Pushing a tag such as `v0.1.0` also builds it.

Other platforms: `npm run dist:mac` (dmg) and `npm run dist:linux` (AppImage).

The installer is not code-signed, so Windows SmartScreen will warn on first launch. To sign it,
configure a certificate as described in the electron-builder docs (`CSC_LINK`, `CSC_KEY_PASSWORD`).

## Tests

```bash
npm test
```

Unit and integration tests use an in-memory Google Sheet and a fake Resend client and a fake fetch for Elastic Email and Mailjet. No real API
calls are made.

## Google Cloud setup

1. Open the [Google Cloud Console](https://console.cloud.google.com/).
2. Create a project, or select an existing one.
3. Enable the **Google Sheets API** (APIs & Services → Library → Google Sheets API → Enable).
4. Create a service account (IAM & Admin → Service Accounts → Create service account). No roles are needed.
5. Create credentials for it: open the service account → **Keys** → Add key → Create new key → **JSON**.
6. The JSON key file downloads to your computer. Keep it private.
7. Open Email Sender and go to **Settings**.
8. Click **Import Service Account JSON** and select the file. The app stores the service account
   email and encrypts the private key; it does not keep a copy of the file. You can delete the
   downloaded file afterwards, or keep it somewhere safe.
9. Open your Google Sheet, click **Share**, and share it with the service account email
   (it looks like `name@project.iam.gserviceaccount.com`).
10. Give it **Editor** permission, because the app updates each contact's status.

Then fill in **Spreadsheet ID** (the long ID in the sheet URL, or paste the whole URL) and
**Worksheet Name** (default `Emails`), click **Save** and **Test Google Sheets**.

## Email provider setup

Open Email Sender → **Settings** → **Email Provider**, choose **Send With**, enter the keys, set
**From Name** and **From Email**, and click **Save**. Keys are stored encrypted. **Validate** checks
the keys without sending anything; **Send Test Email** on the Campaign page sends a real message.

| Provider | What to enter | Where to get it |
| --- | --- | --- |
| Resend | API key (`re_…`) | resend.com → Domains (verify your domain), then API Keys → Create API Key |
| Elastic Email | API key | elasticemail.com → Settings → Manage API Keys → Create (allow sending), and verify your domain under Domains |
| Mailjet | API key **and** secret key | mailjet.com → Account settings → API Key Management; the From address (or its domain) must be an active sender under Senders & Domains |

The From Email must be on a domain (or sender) verified with the selected provider.
Only one provider is used at a time; switching keeps the other providers' keys stored.

## Google Sheet format

Row 1 must contain headers. Contacts are read from three columns, matched by header name
(case-insensitive; `_`, `-` and spaces are treated alike), in any order:

| What | Header | Notes |
| --- | --- | --- |
| Name | `Name` (full name), or `first_name` / `last_name` | With `Name`, the first word becomes `{{first_name}}` and the rest `{{last_name}}` ("Lopez, Maria" is also understood). Empty names use the fallback (default `there`) |
| Email | `Email` | Rows with an empty email are ignored completely: never emailed, never changed. Invalid emails are skipped |
| Status | `Batch Flag` (or `tag`) | The app sends to `New` rows and writes `Processing`, then `Sent` or `Failed` |

The app also records each send in five tracking columns. If they are missing, it offers to add
them to the right of your existing headers (Settings → Test Google Sheets → Add Columns, or in
the send confirmation):

| Column | Written by the app |
| --- | --- |
| `send_status` | `processing`, `sent`, `failed`, `review` |
| `campaign_id` | ID of the campaign that processed the row |
| `sent_at` | ISO timestamp |
| `message_id` | ID returned by the email provider (an existing `resend_email_id` column is used instead) |
| `last_error` | Sanitized error message |

Every other column (Location, Country, notes, …) is ignored and never changed. **Test Google
Sheets** also looks only at these columns: it shows which header it uses for the name, email and
Batch Flag, which tracking columns exist, and how many New rows have (and don't have) an email.

## Find Contacts (OpenAI web search)

**Find Contacts** looks for people whose business email is published on a public web page and
saves them to a new tab of your spreadsheet.

1. In **Settings → OpenAI**, paste an OpenAI API key (stored encrypted) and, if you like, change the
   model. Any OpenAI model that supports the `web_search` tool works. **Check OpenAI Key** tests the key
   and model without searching.
2. Describe who you are looking for (for example "HR managers at software companies in Austin") and
   click **Search**. A search can take a minute or two and uses your OpenAI credits.
3. The model is told to return only addresses written on a public page, never guessed ones. The app
   then opens each source page and shows whether the email is really there (**On page**, **Not on
   page**, **Not checked**). Only On-page results are pre-selected. Invalid emails, repeats and people
   whose email already appears in **any tab** of the spreadsheet (the Emails tab, earlier search tabs,
   any column) are left out. The same check runs again when you save, and the app tells you how many
   were skipped.
   Skipped results (already in the spreadsheet, repeated, invalid, or not on their page) do not
   count. The app keeps searching, with no fixed number of searches, until it has the number you
   asked for (up to 100; each search asks for at most 25). Every new search is told which emails and
   organizations were already found and is steered to other sources. Temporary OpenAI errors (rate
   limit, timeout) are retried. The run ends early only when you press **Cancel** (you keep what was
   found), on a permanent OpenAI error such as no credits, or when 5 searches in a row find nobody
   new. The page shows live progress. Each search uses OpenAI credits.
4. Choose where to save:
   - **New tab**: enter a name. The tab gets Name, Email, Organization, Role, Source URL, Email on
     page, Batch Flag and the tracking columns. An existing tab is never overwritten.
   - **Existing tab** (any tab, including your Emails tab): rows are added below the last row in use,
     placed by that tab's own headers (Name or First Name/Last Name, Email; Organization/Company, Role
     and Email on page when the tab has them). Missing Name, Email, Batch Flag or Source URL columns
     are added at the right. Existing rows and columns are never changed or reordered.

Batch Flag is left **empty**, so nothing is sent to found contacts until you review them. Set Batch
Flag to `New` only for people you are authorized to email, then either choose that tab as the
worksheet in Settings or copy the rows into your Emails tab.

### Search costs

Each search shows its **estimated** OpenAI cost while it runs and when it finishes. The **Search
Costs** page lists every search with its tokens, web searches and estimated cost, plus totals for
today, this week (weeks start on Monday), this month and all time, and a table grouped by day,
week or month.

The estimate uses the token counts and web search calls OpenAI reports with each answer, priced at
OpenAI's list prices (standard tier, October 2026, see `shared/usage.ts`): web searches at $10 per
1,000 calls, plus input, cached input and output tokens at the model's rate. Searches that failed
before OpenAI answered cost nothing and are not counted. For a model the app has no price for, only
the web searches are counted and the amount is marked with `+`. Your OpenAI billing page has the
exact charges. The history is kept on this computer only (in `settings.json`, the latest 5,000
searches) and can be cleared on that page.

## Workflow

1. **Settings**: configure Google Sheets and the email provider, then test both connections.
2. **Campaign**: write the subject and body. Variables: `{{first_name}}`, `{{last_name}}`, `{{email}}`.
   Use **Visual** to format the email like a document (bold, headings, lists, links, colors),
   **HTML code** to paste or edit HTML directly, or **Plain text**. The preview shows the email
   exactly as it will be sent, with the first previewed contact's details.
   Unknown variables (e.g. a typo like `{{frist_name}}`) block sending.
3. **Preview Contacts** to see exactly which rows will be emailed, and why others are skipped.
4. Run a **Dry Run** (on by default): every email is rendered and logged as
   `[DRY RUN] Would send to ma***@example.com`; nothing is sent and the sheet is untouched.
5. **Send Test Email** to yourself (uses John Doe sample values; the sheet is untouched).
6. Untick Dry Run and click **Send Campaign**, check the confirmation, and confirm.
7. Watch live progress and the Activity panel. **Cancel Campaign** stops new sends; sends already
   in flight finish, and contacts that were never started go back to `New`.
8. Review the results table. Open **Logs** for details.

## If something goes wrong

- **A contact fails**: its row becomes `Failed` with `last_error`; the campaign continues.
- **Invalid API key, quota exhausted or unverified sender**: the campaign stops early and
  unstarted contacts go back to `New`.
- **Network error while sending**: the provider may or may not have delivered it. The row stays in
  `Processing` with `send_status = review` and is never resent automatically.
- **App closed or crashed mid-campaign**: rows left in `Processing` are listed on the **Review**
  screen at the next launch. Choose **Mark as New**, **Mark as Failed** or **Mark as Sent** for each.
  Nothing on that screen sends email, and **Mark as New** is refused for rows the app knows the provider accepted.
- **The provider accepted an email but the sheet update failed**: logged as a warning
  (`EMAIL_SENT_SHEET_UPDATE_FAILED`, find it under Logs → Warning) and listed on the Review screen
  with the message ID. Mark the row as Sent there. That address is not emailed again automatically.

## Where data is stored

All paths are inside Electron's user-data folder (`%APPDATA%\Email Sender` on Windows,
`~/Library/Application Support/Email Sender` on macOS, `~/.config/Email Sender` on Linux):

| Path | Contents |
| --- | --- |
| `settings.json` | Non-secret settings, campaign history, search cost history, encrypted credentials (ciphertext only) |
| `logs/main.log` | All log entries (rotates to `main.old.log` at 5 MB) |
| `logs/campaign.log` | Campaign entries only |
| `journal/<campaign-id>.jsonl` | Per-contact send outcomes used for crash recovery (emails masked) |

Credentials (Google private key, and the Resend, Elastic Email and Mailjet keys) are encrypted with the OS keychain (Windows DPAPI, macOS Keychain, Linux
libsecret/KWallet). On Linux without a keyring (gnome-keyring or KWallet) the app refuses to save
them rather than storing them with Electron's weak fallback.
The app never writes API keys or private keys to logs; emails in logs are masked.

## Application icon

Placeholder icons live in `assets/`:

- `assets/icon.ico`: Windows installer and executable icon (include 16–256 px sizes)
- `assets/icon.png`: 512×512 PNG used for macOS/Linux builds and the development window

Replace those two files with your own artwork and rebuild. `npm run icons` regenerates the placeholders.

## Project structure

```text
electron/
  main.ts                 app lifecycle, single-instance lock, window, security hardening
  preload.ts              contextBridge API (window.emailApp)
  app-context.ts          creates and wires the services
  ipc/                    one file per area; every handler validates input with Zod
  services/               config, google-sheets, sheet-parser, mailer (shared send/retry),
                          resend, elastic-email, mailjet, campaign, recovery, journal,
                          logger, log-format, retry, network, template (re-export)
  repositories/           electron-store settings repository
  types/                  main-process-only types
src/
  App.tsx, main.tsx
  pages/                  Dashboard, Campaign, Settings, Logs, Recovery (Review)
  components/             UI components (ui/ holds small shadcn-style primitives)
  hooks/                  useConfig, useCampaign, useCampaignForm, useLogs, useRecovery, useAppStatus
  types/electron-api.d.ts window.emailApp declaration
shared/                   constants, Zod schemas, types, API contract, template rendering
tests/                    Vitest suites
assets/                   icons
electron.vite.config.ts   Vite config for main, preload and renderer (replaces vite.config.ts)
electron-builder.yml      packaging
```

## Scripts

| Script | What it does |
| --- | --- |
| `npm run dev` | Start the app with hot reload |
| `npm run build` | Type-check and build to `out/` |
| `npm run dist` | Build the Windows NSIS installer |
| `npm run dist:mac` / `npm run dist:linux` | Build for macOS / Linux |
| `npm test` | Run the test suite |
| `npm run typecheck` | TypeScript only |
| `npm run icons` | Regenerate placeholder icons |
