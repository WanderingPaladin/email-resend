import { google } from 'googleapis';
import { SEND_STATUS, TAG, type TrackingColumn } from '../../shared/constants';
import type { ContactRow, GoogleTestResult } from '../../shared/types';
import type { AppLogger } from '../types/logger';
import type { GoogleCredentials } from './config.service';
import { maskEmail } from './log-format';
import { withRetry } from './retry';
import {
  buildHeaderMap,
  cellRange,
  describeColumns,
  findStaleProcessing,
  isNewTag,
  isStaleProcessing,
  isValidEmail,
  looksAlreadySent,
  missingRequiredColumns,
  missingTrackingColumns,
  parseContacts,
  quoteSheetName,
  resolveColumns,
  columnToLetter,
  type HeaderMap,
  type SheetColumns,
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
  /** Reads several ranges in one request, in the same order. */
  getValuesBatch(spreadsheetId: string, ranges: string[]): Promise<string[][][]>;
  batchWrite(spreadsheetId: string, writes: CellWrite[]): Promise<void>;
  /** Adds columns to the worksheet's grid until it has at least `minColumns`. Google rejects writes outside the grid. */
  ensureColumnCount(spreadsheetId: string, worksheetName: string, minColumns: number): Promise<void>;
  /** Adds rows to the worksheet's grid until it has at least `minRows`. */
  ensureRowCount(spreadsheetId: string, worksheetName: string, minRows: number): Promise<void>;
  /** Adds a new, empty tab. */
  addWorksheet(spreadsheetId: string, title: string, rowCount: number, columnCount: number): Promise<void>;
  /** Writes a block of rows starting at `range` (e.g. 'Tab'!A1). */
  writeRows(spreadsheetId: string, range: string, rows: string[][]): Promise<void>;
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
    async getValuesBatch(spreadsheetId, ranges) {
      if (ranges.length === 0) return [];
      const res = await sheets.spreadsheets.values.batchGet({
        spreadsheetId,
        ranges,
        majorDimension: 'ROWS',
        valueRenderOption: 'FORMATTED_VALUE',
      });
      return (res.data.valueRanges ?? []).map((r) =>
        (r.values ?? []).map((row) => row.map((v) => (v === null || v === undefined ? '' : String(v)))),
      );
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
    async ensureColumnCount(spreadsheetId, worksheetName, minColumns) {
      const res = await sheets.spreadsheets.get({
        spreadsheetId,
        fields: 'sheets.properties.sheetId,sheets.properties.title,sheets.properties.gridProperties.columnCount',
      });
      const props = (res.data.sheets ?? []).find((s) => s.properties?.title === worksheetName)?.properties;
      if (props?.sheetId === undefined || props.sheetId === null) return;
      const columnCount = props.gridProperties?.columnCount ?? 0;
      if (columnCount >= minColumns) return;
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId,
        requestBody: {
          requests: [{ appendDimension: { sheetId: props.sheetId, dimension: 'COLUMNS', length: minColumns - columnCount } }],
        },
      });
    },
    async ensureRowCount(spreadsheetId, worksheetName, minRows) {
      const res = await sheets.spreadsheets.get({
        spreadsheetId,
        fields: 'sheets.properties.sheetId,sheets.properties.title,sheets.properties.gridProperties.rowCount',
      });
      const props = (res.data.sheets ?? []).find((s) => s.properties?.title === worksheetName)?.properties;
      if (props?.sheetId === undefined || props.sheetId === null) return;
      const rowCount = props.gridProperties?.rowCount ?? 0;
      if (rowCount >= minRows) return;
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId,
        requestBody: { requests: [{ appendDimension: { sheetId: props.sheetId, dimension: 'ROWS', length: minRows - rowCount } }] },
      });
    },
    async addWorksheet(spreadsheetId, title, rowCount, columnCount) {
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId,
        requestBody: { requests: [{ addSheet: { properties: { title, gridProperties: { rowCount, columnCount } } } }] },
      });
    },
    async writeRows(spreadsheetId, range, rows) {
      await sheets.spreadsheets.values.update({
        spreadsheetId,
        range,
        // RAW: text found on the web is stored literally and can never become a formula.
        valueInputOption: 'RAW',
        requestBody: { values: rows },
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

/** 'tag' is the status column (Batch Flag or tag); the rest are the app's tracking columns. */
export type TrackedField = 'tag' | TrackingColumn;

/**
 * A change to one row. Only the status column and the tracking columns are ever written.
 * Before writing, the row must still hold the same email (and campaign ID / state when given).
 */
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
  columns: SheetColumns;
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
      // The spreadsheet is reachable; the tab is chosen on the Campaign page.
      this.logger.info('google', 'Google Sheets connection successful; campaign tab not found', {
        spreadsheet: meta.title,
        worksheet: this.target.worksheetName,
      });
      return {
        spreadsheetTitle: meta.title,
        worksheetName: this.target.worksheetName,
        worksheetFound: false,
        worksheets,
        rowCount: 0,
        newCount: 0,
        newWithoutEmailCount: 0,
        columns: { name: '', email: '', status: '' },
        trackingColumns: [],
        missingTrackingColumns: [],
      };
    }
    const snapshot = await this.readSheet();
    const newRows = snapshot.contacts.filter((c) => isNewTag(c.tag));
    const withEmail = newRows.filter((c) => c.email !== '').length;
    this.logger.info('google', 'Google Sheets connection successful', {
      spreadsheet: meta.title,
      worksheet: this.target.worksheetName,
      rows: snapshot.totalRows,
    });
    return {
      spreadsheetTitle: meta.title,
      worksheetName: this.target.worksheetName,
      worksheetFound: true,
      worksheets,
      rowCount: snapshot.contacts.length,
      newCount: withEmail,
      newWithoutEmailCount: newRows.length - withEmail,
      columns: describeColumns(snapshot.columns, snapshot.headerNames),
      trackingColumns: Object.values(snapshot.columns.tracking).map((i) => String(snapshot.headerNames[i] ?? '').trim()),
      missingTrackingColumns: snapshot.missingTrackingColumns,
    };
  }

  /**
   * Every email address anywhere in the spreadsheet (all tabs, any column), lowercased.
   * Used to keep people found by Find Contacts out when they are already in any tab.
   */
  async readAllEmails(): Promise<Set<string>> {
    const meta = await this.call('metadata read', () => this.gateway.getSpreadsheet(this.target.spreadsheetId));
    const titles = meta.sheets.map((s) => s.title);
    const tabs = await this.call('read all tabs', () =>
      this.gateway.getValuesBatch(this.target.spreadsheetId, titles.map((t) => quoteSheetName(t))),
    );
    const emails = new Set<string>();
    for (const rows of tabs) {
      for (const row of rows) {
        for (const value of row) {
          const text = String(value ?? '').trim().replace(/^mailto:/i, '');
          if (text.includes('@') && isValidEmail(text)) emails.add(text.toLowerCase());
        }
      }
    }
    this.logger.info('google', `Read ${emails.size} email address(es) from ${titles.length} tab(s)`);
    return emails;
  }

  /**
   * Creates a new tab and fills it with `rows` (the first row is the header).
   * Refuses to touch an existing tab.
   */
  async createWorksheet(title: string, rows: string[][]): Promise<{ tabName: string; rows: number }> {
    const meta = await this.call('metadata read', () => this.gateway.getSpreadsheet(this.target.spreadsheetId));
    if (meta.sheets.some((s) => s.title.toLowerCase() === title.toLowerCase())) {
      throw new GoogleSheetsError(`A tab named "${title}" already exists. Choose another name.`, 'tab_exists');
    }
    const columns = Math.max(26, ...rows.map((r) => r.length));
    await this.call('add tab', async () => {
      try {
        await this.gateway.addWorksheet(this.target.spreadsheetId, title, rows.length + 100, columns);
      } catch (error) {
        // A retry after a lost response finds the tab already created: that is success.
        const again = await this.gateway.getSpreadsheet(this.target.spreadsheetId).catch(() => null);
        if (again?.sheets.some((s) => s.title === title)) return;
        throw error;
      }
    });
    await this.call('write new tab', () => this.gateway.writeRows(this.target.spreadsheetId, `${quoteSheetName(title)}!A1`, rows));
    this.logger.info('google', `Created tab "${title}" with ${rows.length - 1} row(s)`);
    return { tabName: title, rows: rows.length - 1 };
  }

  /** Tab names, in the spreadsheet's order. */
  async listWorksheets(): Promise<string[]> {
    const meta = await this.call('metadata read', () => this.gateway.getSpreadsheet(this.target.spreadsheetId));
    return meta.sheets.map((s) => s.title);
  }

  /** All values of a tab (the header row first). Empty when the tab is blank. */
  async readWorksheet(title: string): Promise<string[][]> {
    const titles = await this.listWorksheets();
    if (!titles.includes(title)) throw new GoogleSheetsError(`Tab "${title}" was not found in the spreadsheet.`, 'worksheet_not_found');
    return this.call('read tab', () => this.gateway.getValues(this.target.spreadsheetId, quoteSheetName(title)));
  }

  /**
   * Writes new rows below the last row in use of an existing tab, adding header cells for new
   * columns at the right. Existing cells are never written.
   */
  async appendToWorksheet(
    title: string,
    plan: { addedColumns: { index: number; label: string }[]; rows: string[][]; firstRow: number; width: number },
  ): Promise<{ tabName: string; rows: number; addedColumns: string[] }> {
    const id = this.target.spreadsheetId;
    const lastRow = plan.firstRow + plan.rows.length - 1;
    await this.call('grid resize', () => this.gateway.ensureColumnCount(id, title, plan.width));
    await this.call('grid resize', () => this.gateway.ensureRowCount(id, title, lastRow));
    if (plan.addedColumns.length > 0) {
      await this.call('header write', () =>
        this.gateway.batchWrite(
          id,
          plan.addedColumns.map((c) => ({ range: `${quoteSheetName(title)}!${columnToLetter(c.index)}1`, value: c.label })),
        ),
      );
    }
    await this.call('append rows', () => this.gateway.writeRows(id, `${quoteSheetName(title)}!A${plan.firstRow}`, plan.rows));
    this.logger.info('google', `Added ${plan.rows.length} row(s) to tab "${title}"`, {
      firstRow: plan.firstRow,
      addedColumns: plan.addedColumns.map((c) => c.label).join(','),
    });
    return { tabName: title, rows: plan.rows.length, addedColumns: plan.addedColumns.map((c) => c.label) };
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
    const { headers, columns, contacts } = parseContacts(values);
    const missing = missingRequiredColumns(headers);
    if (missing.length > 0) {
      throw new GoogleSheetsError(
        `Required column(s) missing from the header row: ${missing.join(', ')}. ` +
          'The app uses only Name (or First Name and Last Name), Email, Batch Flag and its tracking columns; other columns are ignored.',
        'missing_headers',
      );
    }
    this.logger.info('google', `Loaded ${contacts.length} sheet rows`);
    return {
      headers,
      columns,
      headerNames: (values[0] ?? []).map(String),
      contacts,
      totalRows: contacts.length,
      missingTrackingColumns: missingTrackingColumns(columns),
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
    const missing = missingTrackingColumns(resolveColumns(buildHeaderMap(headerRow)));
    if (missing.length === 0) return [];
    const normalized = headerRow.map((h) => h.trim());
    // Place new columns after the last non-empty header cell.
    let lastUsed = normalized.length - 1;
    while (lastUsed >= 0 && normalized[lastUsed] === '') lastUsed--;
    const writes = missing.map((name, i) => ({
      range: `${this.sheetRange}!${columnToLetter(lastUsed + 1 + i)}1`,
      value: name,
    }));
    const neededColumns = lastUsed + 1 + missing.length;
    await this.call('grid resize', () =>
      this.gateway.ensureColumnCount(this.target.spreadsheetId, this.target.worksheetName, neededColumns),
    );
    await this.call('header write', () => this.gateway.batchWrite(this.target.spreadsheetId, writes));
    this.logger.info('google', `Added tracking columns: ${missing.join(', ')}`);
    return missing;
  }

  /**
   * Applies row updates after re-reading the sheet. Each update is written only if a row with
   * the same email (and campaign ID / state, when given) is found; rows that moved are re-located.
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
      const columnOf = (field: TrackedField) =>
        field === 'tag' ? snapshot.columns.status : snapshot.columns.tracking[field];
      const fields = Object.keys(update.fields) as TrackedField[];
      if (fields.includes('tag') && columnOf('tag') === undefined) {
        failures.push({ update, reason: 'Missing column: Batch Flag' });
        continue;
      }
      // Tracking columns are added before a real campaign; a sheet without them still gets its status written.
      if (row !== update.sheetRow) {
        this.logger.warn('google', 'Row moved since it was read; writing to its new position', {
          fromRow: update.sheetRow,
          toRow: row,
        });
      }
      for (const field of fields) {
        const col = columnOf(field);
        if (col !== undefined) writes.push({ range: cellRange(this.target.worksheetName, col, row), value: update.fields[field] ?? '' });
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
  messageId: string,
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
      message_id: messageId,
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
