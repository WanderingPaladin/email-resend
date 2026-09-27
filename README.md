# Email Sender

A desktop utility (Electron + React + TypeScript) that reads contacts tagged **New** from the
`Emails` worksheet of a Google Sheet, sends each one a personalized email through
[Resend](https://resend.com), and marks the row **Sent** or **Failed**. It is built to avoid
duplicate sends, to survive crashes and partial failures, and to be easy to debug through logs.

> Only email contacts you are authorized to email.

## Features

- Google Sheets and Resend configuration with credentials encrypted by the operating system (`safeStorage`)
- Contact preview (up to 100 per campaign), template variables, live email preview
- Test email, dry run, confirmation step, live progress, cancel, results table
- Controlled concurrency (`p-limit`) and a send-rate throttle for Resend's rate limit
- Duplicate-send protection, crash recovery and a Review screen for ambiguous rows
- Persistent logs with masking and secret redaction, live log viewer
- Local campaign history (last 50)
- Windows installer (NSIS) via electron-builder

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the process model, security model and campaign algorithm.

## Requirements

- Node.js 22 or newer and npm
- A Google Cloud account (for a service account with Google Sheets API access)
- A Resend account with a verified sending domain

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

Unit and integration tests use an in-memory Google Sheet and a fake Resend client. No real API
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

## Resend setup

1. Create a [Resend](https://resend.com) account.
2. Add and verify your sending domain (Domains → Add Domain, then add the DNS records it shows).
3. Generate an API key (API Keys → Create API Key). "Sending access" is enough; "Full access" also lets the app check your verified domains.
4. Open Email Sender → **Settings**.
5. Paste the API key into **API Key**.
6. Set **From Name** and **From Email** (an address on your verified domain) and click **Save**.
   **Validate Resend Configuration** checks the key without sending anything.
7. On the **Campaign** page, use **Send Test Email** to send yourself a real message.

## Google Sheet format

Row 1 must contain headers. Columns are matched by name (case-insensitive, trimmed), in any order.

| Column | Required | Written by the app | Notes |
| --- | --- | --- | --- |
| `first_name` | yes | | Empty values use the fallback (default `there`) |
| `email` | yes | | Invalid or blank emails are skipped |
| `tag` | yes | yes | `New` → `Processing` → `Sent` or `Failed` |
| `last_name`, `company` | no | | Available as template variables |
| `unsubscribed` | no | | `true`, `yes`, `1` or `unsubscribed` means never email |
| `send_status` | tracking | yes | `processing`, `sent`, `failed`, `review` |
| `campaign_id` | tracking | yes | UUID of the campaign that processed the row |
| `sent_at` | tracking | yes | ISO timestamp |
| `resend_email_id` | tracking | yes | ID returned by Resend |
| `last_error` | tracking | yes | Sanitized error message |

Alternative layout: instead of `first_name` you can have a `Name` column (full name). The first
word becomes `{{first_name}}` and the rest `{{last_name}}` ("Lopez, Maria" is also understood).
Instead of `tag` you can use a `Batch Flag` column; the app reads `New` from it and writes
`Processing`, `Sent` or `Failed` back to it. Other columns (Location, Country, …) are ignored and never changed.

If tracking columns are missing, the app offers to add them to the right of your existing headers
(from Settings → Test Google Sheets, or in the send confirmation). Nothing else in the sheet is moved.

## Workflow

1. **Settings**: configure Google Sheets and Resend, then test both connections.
2. **Campaign**: write the subject and body. Variables: `{{first_name}}`, `{{last_name}}`, `{{email}}`, `{{company}}`.
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
- **Network error while sending**: Resend may or may not have delivered it. The row stays in
  `Processing` with `send_status = review` and is never resent automatically.
- **App closed or crashed mid-campaign**: rows left in `Processing` are listed on the **Review**
  screen at the next launch. Choose **Mark as New**, **Mark as Failed** or **Mark as Sent** for each.
  Nothing on that screen sends email, and **Mark as New** is refused for rows the app knows Resend accepted.
- **Resend accepted an email but the sheet update failed**: logged as a warning
  (`EMAIL_SENT_SHEET_UPDATE_FAILED`, find it under Logs → Warning) and listed on the Review screen
  with the Resend ID. Mark the row as Sent there.

## Where data is stored

All paths are inside Electron's user-data folder (`%APPDATA%\Email Sender` on Windows,
`~/Library/Application Support/Email Sender` on macOS, `~/.config/Email Sender` on Linux):

| Path | Contents |
| --- | --- |
| `settings.json` | Non-secret settings, campaign history, encrypted credentials (ciphertext only) |
| `logs/main.log` | All log entries (rotates to `main.old.log` at 5 MB) |
| `logs/campaign.log` | Campaign entries only |
| `journal/<campaign-id>.jsonl` | Per-contact send outcomes used for crash recovery (emails masked) |

Credentials are encrypted with the OS keychain (Windows DPAPI, macOS Keychain, Linux
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
  services/               config, google-sheets, sheet-parser, resend, campaign, recovery,
                          journal, logger, log-format, retry, template (re-export)
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
