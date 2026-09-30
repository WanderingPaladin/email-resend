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

Row 1 must contain headers. The app reads only three things, matched by header name
(case-insensitive; `_`, `-` and spaces are treated alike), in any order:

| What | Header | Notes |
| --- | --- | --- |
| Name | `Name` (full name), or `first_name` / `last_name` | With `Name`, the first word becomes `{{first_name}}` and the rest `{{last_name}}` ("Lopez, Maria" is also understood). Empty names use the fallback (default `there`) |
| Email | `Email` | Invalid or blank emails are skipped |
| Status | `Batch Flag` (or `tag`) | The app sends to `New` rows and writes `Processing`, then `Sent` or `Failed` |

Every other column (Location, Country, notes, …) is ignored and never changed. The app never adds
columns: the Batch Flag cell is the only cell it writes.

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

- **A contact fails**: its row becomes `Failed`; the reason is in the results table and Logs. The campaign continues.
- **Invalid API key, quota exhausted or unverified sender**: the campaign stops early and
  unstarted contacts go back to `New`.
- **Network error while sending**: the provider may or may not have delivered it. The row stays in
  `Processing` and is never resent automatically.
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
| `settings.json` | Non-secret settings, campaign history, encrypted credentials (ciphertext only) |
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
