import { google } from 'googleapis';
import { SEND_STATUS, TAG, TRACKING_COLUMNS } from '../../shared/constants';
import type { ContactRow, GoogleTestResult } from '../../shared/types';
import type { AppLogger } from '../types/logger';
import type { GoogleCredentials } from './config.service';
import { maskEmail } from './log-format';
import { withRetry } from './retry';
import {
  cellRange,
  findStaleProcessing,
  isNewTag,
  isStaleProcessing,
  looksAlreadySent,
  missingRequiredColumns,
  missingTrackingColumns,
  parseContacts,
  quoteSheetName,
  columnToLetter,
  type HeaderMap,
} from './sheet-parser';

// ---------------------------------------------------------------------------
// Gateway: the thin, mockable layer over the Google Sheets REST API.
// ---------------------------------------------------------------------------

export interface CellWrite {
  range: string;
  value: string;
}

export interface SheetsGateway {
  getSpreadsheet(spreadsheetId: string): Promise<{ title: string; sheets: { title: string; rowCount: number }[] }>;
  getValues(spreadsheetId: string, range: string): Promise<string[][]>;
  batchWrite(spreadsheetId: string, writes: CellWrite[]): Promise<void>;
}

/**
 * @param fetchImplementation optional fetch used for both the OAuth token request and API calls.
 *   The app passes Electron's `net.fetch` so the OS proxy/DNS settings apply (see network.ts).
 */
export function createSheetsClient(credentials: GoogleCredentials, fetchImplementation?: typeof fetch): SheetsGateway {
  const auth = new google.auth.JWT({
    email: credentials.clientEmail,
    key: credentials.privateKey,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    ...(fetchImplementation ? { transporterOptions: { fetchImplementation } } : {}),
  });
  const sheets = google.sheets({ version: 'v4', auth });

  return {
    async getSpreadsheet(spreadsheetId) {
      const res = await sheets.spreadsheets.get({
        spreadsheetId,
        fields: 'properties.title,sheets.properties.title,sheets.properties.gridProperties.rowCount',
      });
      return {
        title: res.data.properties?.title ?? '',
        sheets: (res.data.sheets ?? []).map((s) => ({
          title: s.properties?.title ?? '',
          rowCount: s.properties?.gridProperties?.rowCount ?? 0,
        })),
      };
    },
    async getValues(spreadsheetId, range) {
      const res = await sheets.spreadsheets.values.get({
        spreadsheetId,
        range,
        majorDimension: 'ROWS',
        valueRenderOption: 'FORMATTED_VALUE',
      });
      return (res.data.values ?? []).map((row) => row.map((v) => (v === null || v === undefined ? '' : String(v))));
    },
    async batchWrite(spreadsheetId, writes) {
      if (writes.length === 0) return;
      await sheets.spreadsheets.values.batchUpdate({
        spreadsheetId,
        requestBody: {
          // RAW: values are stored literally, so an error message starting with "=" can never become a formula.
          valueInputOption: 'RAW',
          data: writes.map((w) => ({ range: w.range, values: [[w.value]] })),
        },
      });
    },
  };
}

// ---------------------------------------------------------------------------
// Error handling
// ---------------------------------------------------------------------------

interface GaxiosLikeError {
  message?: string;
  code?: string | number;
  status?: number;
  response?: { status?: number; headers?: Record<string, string> };
}

function statusOf(error: unknown): number | undefined {
  const e = error as GaxiosLikeError;
  if (typeof e?.response?.status === 'number') return e.response.status;
  if (typeof e?.status === 'number') return e.status;
  if (typeof e?.code === 'number') return e.code;
  return undefined;
}

const NETWORK_CODES = ['ENOTFOUND', 'ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'EAI_AGAIN', 'ENETUNREACH'];

export function isRetryableGoogleError(error: unknown): boolean {
  const status = statusOf(error);
  if (status === 429 || status === 500 || status === 502 || status === 503 || status === 504) return true;
  const code = (error as GaxiosLikeError)?.code;
  if (typeof code === 'string' && NETWORK_CODES.includes(code)) return true;
  // Chromium network errors (Electron net.fetch), e.g. net::ERR_CONNECTION_RESET.
  return /net::ERR_(CONNECTION_(RESET|CLOSED|TIMED_OUT|ABORTED)|NETWORK_CHANGED|TIMED_OUT|INTERNET_DISCONNECTED)/.test(
    String((error as GaxiosLikeError)?.message ?? ''),
  );
}

export class GoogleSheetsError extends Error {
  constructor(message: string, readonly kind: string) {
    super(message);
    this.name = 'GoogleSheetsError';
  }
}

/** Maps Google API failures to messages an operator can act on. */
export function normalizeGoogleError(error: unknown, context: { serviceAccountEmail?: string; worksheetName?: string } = {}): GoogleSheetsError {
  if (error instanceof GoogleSheetsError) return error;
  const message = String((error as GaxiosLikeError)?.message ?? error ?? 'Unknown error');
  const status = statusOf(error);
  const code = (error as GaxiosLikeError)?.code;

  if (/invalid_grant|invalid_client|unauthorized_client/i.test(message)) {
    return new GoogleSheetsError(
      'Google rejected the service account credentials. Check the service account email and private key, and that your computer clock is correct.',
      'auth',
    );
  }
  if (/DECODER|PEM|private key|asn1|error:[0-9A-F]{8}/i.test(message)) {
    return new GoogleSheetsError('The Google private key could not be read. Re-import the service account JSON file.', 'private_key');
  }
  if (status === 401) {
    return new GoogleSheetsError('Google authentication failed. Re-import the service account JSON file.', 'auth');
  }
  if (status === 403) {
    const who = context.serviceAccountEmail ? ` with ${context.serviceAccountEmail}` : ' with the service account email';
    return new GoogleSheetsError(
      `Permission denied. Share the spreadsheet${who} as Editor, and make sure the Google Sheets API is enabled for the Cloud project.`,
      'permission',
    );
  }
  if (status === 404) {
    return new GoogleSheetsError('Spreadsheet not found. Check the Spreadsheet ID in Settings.', 'not_found');
  }
  if (status === 400 && /Unable to parse range/i.test(message)) {
    return new GoogleSheetsError(`Worksheet "${context.worksheetName ?? ''}" was not found in the spreadsheet.`, 'worksheet_not_found');
  }
  if (status === 429) {
    return new GoogleSheetsError('Google Sheets quota exceeded. Wait a minute and try again.', 'quota');
  }
  const chromiumError = /net::(ERR_[A-Z_]+)/.exec(message)?.[1];
  if ((typeof code === 'string' && NETWORK_CODES.includes(code)) || chromiumError) {
    return new GoogleSheetsError(
      `Could not reach Google (${chromiumError ?? code}). Check that this computer can open https://sheets.googleapis.com in a browser. ` +
        'If you use a VPN, proxy, firewall or antivirus web filter, allow googleapis.com and oauth2.googleapis.com.',
      'network',
    );
  }
  if (status && status >= 500) {
    return new GoogleSheetsError(`Google Sheets is temporarily unavailable (HTTP ${status}). Try again shortly.`, 'server');
  }
  return new GoogleSheetsError(`Google Sheets error: ${message}`, 'unknown');
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export type TrackedField = 'tag' | (typeof TRACKING_COLUMNS)[number];

export interface RowUpdate {
  sheetRow: number;
  email: string;
  /** Row must still carry this campaign ID (when set) before we overwrite it. */
  expectedCampaignId?: string;
  /** Row must currently be in this state: an untouched New contact, or a stale Processing/review row. */
  expectedState?: 'new' | 'stale';
  fields: Partial<Record<TrackedField, string>>;
}

export interface RowUpdateFailure {
  update: RowUpdate;
  reason: string;
}

export interface SheetSnapshot {
  headers: HeaderMap;
  headerNames: string[];
  contacts: ContactRow[];
  totalRows: number;
  missingTrackingColumns: string[];
}

export interface SheetTarget {
  spreadsheetId: string;
  worksheetName: string;
  serviceAccountEmail: string;
}

export interface GoogleSheetsServiceOptions {
  sleepFn?: (ms: number) => Promise<void>;
}

/**
 * All Google Sheets reads and writes. Every write targets the row's original sheet row
 * number and is verified against the current sheet contents first, so rows that moved
 * (someone inserted or sorted rows) are either re-located safely or left untouched.
 */
export class GoogleSheetsService {
  constructor(
    private readonly gateway: SheetsGateway,
    private readonly target: SheetTarget,
    private readonly logger: AppLogger,
    private readonly options: GoogleSheetsServiceOptions = {},
  ) {}

  private async call<T>(label: string, fn: () => Promise<T>): Promise<T> {
    try {
      return await withRetry(fn, {
        retries: 4,
        baseDelayMs: 1000,
        maxDelayMs: 20_000,
        isRetryable: isRetryableGoogleError,
        sleepFn: this.options.sleepFn,
        onRetry: (error, attempt, delay) =>
          this.logger.warn('google', `Google Sheets ${label} failed; retrying`, {
            attempt,
            delayMs: delay,
            reason: normalizeGoogleError(error, this.target).message,
          }),
      });
    } catch (error) {
      throw normalizeGoogleError(error, this.target);
    }
  }

  private get sheetRange(): string {
    return quoteSheetName(this.target.worksheetName);
  }

  async testConnection(): Promise<GoogleTestResult> {
    const meta = await this.call('metadata read', () => this.gateway.getSpreadsheet(this.target.spreadsheetId));
    const worksheets = meta.sheets.map((s) => s.title);
    if (!worksheets.includes(this.target.worksheetName)) {
      throw new GoogleSheetsError(
        `Worksheet "${this.target.worksheetName}" was not found. Available worksheets: ${worksheets.join(', ') || '(none)'}.`,
        'worksheet_not_found',
      );
    }
    const snapshot = await this.readSheet();
    this.logger.info('google', 'Google Sheets connection successful', {
      spreadsheet: meta.title,
      worksheet: this.target.worksheetName,
      rows: snapshot.totalRows,
    });
    return {
      spreadsheetTitle: meta.title,
      worksheetName: this.target.worksheetName,
      worksheets,
      rowCount: snapshot.contacts.length,
      newCount: snapshot.contacts.filter((c) => isNewTag(c.tag)).length,
      headers: snapshot.headerNames,
      missingTrackingColumns: snapshot.missingTrackingColumns,
    };
  }

  async getHeaders(): Promise<string[]> {
    const values = await this.call('header read', () =>
      this.gateway.getValues(this.target.spreadsheetId, `${this.sheetRange}!1:1`),
    );
    return (values[0] ?? []).map((h) => String(h));
  }

  /** Reads the whole worksheet once and parses it by header name. */
  async readSheet(): Promise<SheetSnapshot> {
    const values = await this.call('read', () => this.gateway.getValues(this.target.spreadsheetId, this.sheetRange));
    if (values.length === 0) {
      throw new GoogleSheetsError(`Worksheet "${this.target.worksheetName}" is empty. Row 1 must contain the headers.`, 'missing_headers');
    }
    const { headers, contacts } = parseContacts(values);
    const missing = missingRequiredColumns(headers);
    if (missing.length > 0) {
      throw new GoogleSheetsError(
        `Required column(s) missing from the header row: ${missing.join(', ')}. Found: ${(values[0] ?? []).join(', ')}`,
        'missing_headers',
      );
    }
    this.logger.info('google', `Loaded ${contacts.length} sheet rows`);
    return {
      headers,
      headerNames: (values[0] ?? []).map(String),
      contacts,
      totalRows: contacts.length,
      missingTrackingColumns: missingTrackingColumns(headers),
    };
  }

  async readContacts(): Promise<ContactRow[]> {
    return (await this.readSheet()).contacts;
  }

  async getNewContacts(): Promise<ContactRow[]> {
    const contacts = (await this.readContacts()).filter((c) => isNewTag(c.tag));
    this.logger.info('google', `Found ${contacts.length} New contacts`);
    return contacts;
  }

  async findStaleProcessingRows(): Promise<ContactRow[]> {
    return findStaleProcessing(await this.readContacts());
  }

  /** Appends any missing tracking columns to the right end of the header row. Returns the added names. */
  async initializeTrackingColumns(): Promise<string[]> {
    const headerRow = await this.getHeaders();
    const normalized = headerRow.map((h) => h.trim().toLowerCase());
    const missing = TRACKING_COLUMNS.filter((c) => !normalized.includes(c));
    if (missing.length === 0) return [];
    // Place new columns after the last non-empty header cell.
    let lastUsed = normalized.length - 1;
    while (lastUsed >= 0 && normalized[lastUsed] === '') lastUsed--;
    const writes = missing.map((name, i) => ({
      range: `${this.sheetRange}!${columnToLetter(lastUsed + 1 + i)}1`,
      value: name,
    }));
    await this.call('header write', () => this.gateway.batchWrite(this.target.spreadsheetId, writes));
    this.logger.info('google', `Added tracking columns: ${missing.join(', ')}`);
    return missing;
  }

  /**
   * Applies row updates after re-reading the sheet. Each update is written only if a row with
   * the same email (and campaign ID, when given) is found; rows that moved are re-located.
   * Returns the updates that could not be applied safely.
   */
  async applyRowUpdates(updates: RowUpdate[]): Promise<RowUpdateFailure[]> {
    if (updates.length === 0) return [];
    let snapshot: SheetSnapshot;
    try {
      snapshot = await this.readSheet();
    } catch (error) {
      const reason = normalizeGoogleError(error, this.target).message;
      return updates.map((update) => ({ update, reason }));
    }

    const failures: RowUpdateFailure[] = [];
    const writes: CellWrite[] = [];
    const applied: RowUpdate[] = [];
    const byRow = new Map(snapshot.contacts.map((c) => [c.sheetRow, c]));

    for (const update of updates) {
      const row = this.locateRow(update, byRow, snapshot.contacts);
      if (row === null) {
        failures.push({ update, reason: 'Row could not be located safely (email, campaign ID or status no longer match)' });
        continue;
      }
      const missingColumns = Object.keys(update.fields).filter((f) => !snapshot.headers.has(f));
      if (missingColumns.length > 0) {
        failures.push({ update, reason: `Missing column(s): ${missingColumns.join(', ')}` });
        continue;
      }
      if (row !== update.sheetRow) {
        this.logger.warn('google', 'Row moved since it was read; writing to its new position', {
          fromRow: update.sheetRow,
          toRow: row,
        });
      }
      for (const [field, value] of Object.entries(update.fields)) {
        const col = snapshot.headers.get(field);
        if (col !== undefined) writes.push({ range: cellRange(this.target.worksheetName, col, row), value: value ?? '' });
      }
      applied.push(update);
    }

    if (writes.length > 0) {
      try {
        await this.call('status write', () => this.gateway.batchWrite(this.target.spreadsheetId, writes));
      } catch (error) {
        const reason = normalizeGoogleError(error, this.target).message;
        return [...failures, ...applied.map((update) => ({ update, reason }))];
      }
    }
    return failures;
  }

  private locateRow(update: RowUpdate, byRow: Map<number, ContactRow>, contacts: ContactRow[]): number | null {
    const email = update.email.trim().toLowerCase();
    const matches = (c: ContactRow) =>
      c.email.trim().toLowerCase() === email &&
      (update.expectedCampaignId === undefined || c.campaignId === update.expectedCampaignId) &&
      (update.expectedState !== 'new' || (isNewTag(c.tag) && !looksAlreadySent(c))) &&
      (update.expectedState !== 'stale' || isStaleProcessing(c));
    const atRow = byRow.get(update.sheetRow);
    if (atRow && matches(atRow)) return update.sheetRow;
    const candidates = contacts.filter(matches);
    return candidates.length === 1 && candidates[0] ? candidates[0].sheetRow : null;
  }

  /** Generic single-row status update. */
  async updateRowStatus(update: RowUpdate): Promise<void> {
    const failures = await this.applyRowUpdates([update]);
    if (failures[0]) throw new GoogleSheetsError(failures[0].reason, 'update_failed');
  }

  /**
   * Reserves contacts before any email is sent. Done as one batch write right after the
   * sheet was read, verified against a fresh read so a row edited in between is not reserved.
   */
  async reserveContacts(contacts: ContactRow[], campaignId: string): Promise<RowUpdateFailure[]> {
    return this.applyRowUpdates(contacts.map((c) => reservationUpdate(c, campaignId)));
  }

  async reserveContact(contact: ContactRow, campaignId: string): Promise<void> {
    return this.updateRowStatus(reservationUpdate(contact, campaignId));
  }

  async markSent(contact: Pick<ContactRow, 'sheetRow' | 'email'>, campaignId: string, resendId: string): Promise<void> {
    return this.updateRowStatus(sentUpdate(contact, campaignId, resendId, new Date().toISOString()));
  }

  async markFailed(contact: Pick<ContactRow, 'sheetRow' | 'email'>, campaignId: string, error: string): Promise<void> {
    return this.updateRowStatus(failedUpdate(contact, campaignId, error));
  }

  describeRow(contact: Pick<ContactRow, 'sheetRow' | 'email'>): string {
    return `row=${contact.sheetRow} email=${maskEmail(contact.email)}`;
  }
}

// ---------------------------------------------------------------------------
// Row update builders (pure; shared with the campaign and recovery code)
// ---------------------------------------------------------------------------

export function reservationUpdate(contact: Pick<ContactRow, 'sheetRow' | 'email'>, campaignId: string): RowUpdate {
  return {
    sheetRow: contact.sheetRow,
    email: contact.email,
    expectedState: 'new',
    fields: { tag: TAG.Processing, send_status: SEND_STATUS.Processing, campaign_id: campaignId, last_error: '' },
  };
}

export function sentUpdate(
  contact: Pick<ContactRow, 'sheetRow' | 'email'>,
  campaignId: string,
  resendId: string,
  sentAt: string,
): RowUpdate {
  return {
    sheetRow: contact.sheetRow,
    email: contact.email,
    expectedCampaignId: campaignId,
    fields: {
      tag: TAG.Sent,
      send_status: SEND_STATUS.Sent,
      campaign_id: campaignId,
      sent_at: sentAt,
      resend_email_id: resendId,
      last_error: '',
    },
  };
}

export function failedUpdate(contact: Pick<ContactRow, 'sheetRow' | 'email'>, campaignId: string, error: string): RowUpdate {
  return {
    sheetRow: contact.sheetRow,
    email: contact.email,
    expectedCampaignId: campaignId,
    fields: { tag: TAG.Failed, send_status: SEND_STATUS.Failed, campaign_id: campaignId, last_error: error.slice(0, 500) },
  };
}

/** Delivery state unknown: keep the row out of the New pool and flag it for manual review. */
export function reviewUpdate(contact: Pick<ContactRow, 'sheetRow' | 'email'>, campaignId: string, error: string): RowUpdate {
  return {
    sheetRow: contact.sheetRow,
    email: contact.email,
    expectedCampaignId: campaignId,
    fields: {
      tag: TAG.Processing,
      send_status: SEND_STATUS.Review,
      campaign_id: campaignId,
      last_error: `Manual review required: ${error}`.slice(0, 500),
    },
  };
}

/** Returns a reserved-but-never-sent contact to the New pool. */
export function releaseUpdate(contact: Pick<ContactRow, 'sheetRow' | 'email'>, campaignId: string): RowUpdate {
  return {
    sheetRow: contact.sheetRow,
    email: contact.email,
    expectedCampaignId: campaignId,
    fields: { tag: TAG.New, send_status: '', campaign_id: '', last_error: '' },
  };
}
