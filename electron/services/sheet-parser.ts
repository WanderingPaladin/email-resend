import { MAX_BATCH_SIZE, SEND_STATUS, TAG, TRACKING_COLUMNS, type TrackingColumn } from '../../shared/constants';
import { emailSchema } from '../../shared/schemas';
import type { ContactRow, SkippedContact } from '../../shared/types';

/**
 * Pure spreadsheet parsing and contact-selection logic.
 * Kept free of Google/Electron imports so every rule can be unit tested.
 *
 * Contacts are read from three things: a name (Name, or first_name/last_name), the email
 * address, and the status column (Batch Flag, or tag). The app's own tracking columns are read
 * too. All other columns are ignored.
 */

export type HeaderMap = Map<string, number>;

export function normalizeHeader(header: string): string {
  return header.trim().toLowerCase().replace(/[\s_-]+/g, ' ');
}

/** Accepted header names per field, in order of preference (already normalized). */
export const COLUMN_NAMES = {
  status: ['batch flag', 'tag'],
  email: ['email', 'email address', 'e mail'],
  firstName: ['first name', 'firstname'],
  lastName: ['last name', 'lastname', 'surname'],
  fullName: ['name', 'full name', 'fullname'],
} as const;

/** Accepted header names per tracking column (normalized). */
const TRACKING_NAMES: Record<TrackingColumn, readonly string[]> = {
  send_status: ['send status'],
  campaign_id: ['campaign id'],
  sent_at: ['sent at'],
  message_id: ['message id', 'resend email id'],
  last_error: ['last error'],
};

export interface SheetColumns {
  status?: number;
  email?: number;
  firstName?: number;
  lastName?: number;
  fullName?: number;
  tracking: Partial<Record<TrackingColumn, number>>;
}

/** Maps normalized header name → zero-based column index. The first occurrence wins. */
export function buildHeaderMap(headerRow: readonly unknown[]): HeaderMap {
  const map: HeaderMap = new Map();
  headerRow.forEach((cell, index) => {
    const name = normalizeHeader(String(cell ?? ''));
    if (name && !map.has(name)) map.set(name, index);
  });
  return map;
}

export function resolveColumns(headers: HeaderMap): SheetColumns {
  const find = (names: readonly string[]) => names.map((n) => headers.get(n)).find((i) => i !== undefined);
  return {
    status: find(COLUMN_NAMES.status),
    email: find(COLUMN_NAMES.email),
    firstName: find(COLUMN_NAMES.firstName),
    lastName: find(COLUMN_NAMES.lastName),
    fullName: find(COLUMN_NAMES.fullName),
    tracking: Object.fromEntries(
      TRACKING_COLUMNS.map((c) => [c, find(TRACKING_NAMES[c])]).filter(([, i]) => i !== undefined),
    ) as Partial<Record<TrackingColumn, number>>,
  };
}

export function missingTrackingColumns(columns: SheetColumns): TrackingColumn[] {
  return TRACKING_COLUMNS.filter((c) => columns.tracking[c] === undefined);
}

/** Header text of each column in use, for display. */
export function describeColumns(columns: SheetColumns, headerRow: readonly unknown[]): { name: string; email: string; status: string } {
  const label = (i: number | undefined) => (i === undefined ? '' : String(headerRow[i] ?? '').trim());
  const name =
    columns.firstName !== undefined
      ? [label(columns.firstName), label(columns.lastName)].filter(Boolean).join(' + ')
      : label(columns.fullName);
  return { name, email: label(columns.email), status: label(columns.status) };
}

/** "Maria Lopez" → ["Maria", "Lopez"]; "Lopez, Maria" → ["Maria", "Lopez"]. */
export function splitFullName(fullName: string): { firstName: string; lastName: string } {
  const value = fullName.trim().replace(/\s+/g, ' ');
  if (!value) return { firstName: '', lastName: '' };
  if (value.includes(',')) {
    const [last = '', rest = ''] = value.split(',', 2).map((p) => p.trim());
    const [first = '', ...more] = rest.split(' ');
    return { firstName: first, lastName: [...more, last].filter(Boolean).join(' ') };
  }
  const [first = '', ...rest] = value.split(' ');
  return { firstName: first, lastName: rest.join(' ') };
}

export function missingRequiredColumns(headers: HeaderMap): string[] {
  const columns = resolveColumns(headers);
  const missing: string[] = [];
  if (columns.firstName === undefined && columns.fullName === undefined) missing.push('Name (or first_name)');
  if (columns.email === undefined) missing.push('Email');
  if (columns.status === undefined) missing.push('Batch Flag');
  return missing;
}

function cell(row: readonly unknown[], index: number | undefined): string {
  if (index === undefined) return '';
  const value = row[index];
  return value === undefined || value === null ? '' : String(value).trim();
}

/**
 * Converts raw sheet values (row 0 = header) into contacts.
 * `sheetRow` is the real spreadsheet row number: array index + 1 (1-based) and the header
 * is row 1, so data row i (0-based, excluding header) is sheet row i + 2.
 * Completely empty rows are ignored but still consume a row number.
 */
export function parseContacts(values: readonly (readonly unknown[])[]): {
  headers: HeaderMap;
  columns: SheetColumns;
  contacts: ContactRow[];
} {
  const headers = buildHeaderMap(values[0] ?? []);
  const columns = resolveColumns(headers);
  const used = [columns.status, columns.email, columns.firstName, columns.lastName, columns.fullName, ...Object.values(columns.tracking)];
  const contacts: ContactRow[] = [];
  for (let i = 1; i < values.length; i++) {
    const row = values[i] ?? [];
    if (used.every((index) => cell(row, index) === '')) continue;
    let firstName = cell(row, columns.firstName);
    let lastName = cell(row, columns.lastName);
    if (columns.firstName === undefined) {
      const split = splitFullName(cell(row, columns.fullName));
      firstName = split.firstName;
      if (columns.lastName === undefined) lastName = split.lastName;
    }
    contacts.push({
      sheetRow: i + 1,
      firstName,
      lastName,
      email: cell(row, columns.email),
      tag: cell(row, columns.status),
      sendStatus: cell(row, columns.tracking.send_status),
      campaignId: cell(row, columns.tracking.campaign_id),
      sentAt: cell(row, columns.tracking.sent_at),
      messageId: cell(row, columns.tracking.message_id),
      lastError: cell(row, columns.tracking.last_error),
    });
  }
  return { headers, columns, contacts };
}

export function isNewTag(tag: string): boolean {
  return tag.trim().toLowerCase() === TAG.New.toLowerCase();
}

export function isValidEmail(email: string): boolean {
  return emailSchema.safeParse(email.trim()).success;
}

/** True when the row shows any sign of a previous successful send. */
export function looksAlreadySent(contact: ContactRow): boolean {
  return (
    contact.tag.trim().toLowerCase() === TAG.Sent.toLowerCase() ||
    contact.sendStatus.trim().toLowerCase() === SEND_STATUS.Sent ||
    contact.messageId.trim() !== ''
  );
}

/** Reserved by a campaign that never finished with it (crash, unknown delivery, failed sheet write). */
export function isStaleProcessing(contact: ContactRow): boolean {
  const status = contact.sendStatus.trim().toLowerCase();
  return (
    contact.tag.trim().toLowerCase() === TAG.Processing.toLowerCase() ||
    status === SEND_STATUS.Processing ||
    status === SEND_STATUS.Review
  );
}

export function findStaleProcessing(contacts: readonly ContactRow[]): ContactRow[] {
  return contacts.filter(isStaleProcessing);
}

export function clampBatchSize(requested: number): number {
  if (!Number.isFinite(requested)) return MAX_BATCH_SIZE;
  return Math.max(1, Math.min(MAX_BATCH_SIZE, Math.floor(requested)));
}

export interface SelectionResult {
  /** New rows that have an email address. */
  totalNew: number;
  /** New rows with an empty email cell. They are ignored entirely: never sent, never written. */
  blankEmailCount: number;
  selected: ContactRow[];
  skipped: SkippedContact[];
}

/**
 * Walks New contacts in sheet order and picks up to `batchSize` eligible ones.
 * New rows with an empty email are ignored (only counted). Other ineligible New contacts seen
 * along the way are reported as skipped.
 * The batch size is clamped to MAX_BATCH_SIZE here, so no caller can exceed it.
 * `pendingSentEmails` are addresses the provider accepted but whose row could not be marked
 * Sent (kept locally for manual review); they are never emailed again automatically.
 */
export function selectContacts(
  contacts: readonly ContactRow[],
  requestedBatchSize: number,
  pendingSentEmails: ReadonlySet<string> = new Set(),
): SelectionResult {
  const batchSize = clampBatchSize(requestedBatchSize);
  const newRows = contacts.filter((c) => isNewTag(c.tag));
  const newContacts = newRows.filter((c) => c.email.trim() !== '');

  // Emails that already received a message from any row are never emailed again automatically.
  const alreadySentRows = new Map<string, number>();
  for (const c of contacts) {
    if (looksAlreadySent(c) && c.email) {
      const key = c.email.trim().toLowerCase();
      if (!alreadySentRows.has(key)) alreadySentRows.set(key, c.sheetRow);
    }
  }

  const selected: ContactRow[] = [];
  const skipped: SkippedContact[] = [];
  const seen = new Set<string>();

  const skip = (c: ContactRow, reason: SkippedContact['reason'], detail: string) =>
    skipped.push({ sheetRow: c.sheetRow, email: c.email, firstName: c.firstName, reason, detail });

  for (const contact of newContacts) {
    if (selected.length >= batchSize) break;
    const email = contact.email.trim();
    const key = email.toLowerCase();

    if (!isValidEmail(email)) {
      skip(contact, 'invalid_email', 'Email address is not valid');
    } else if (contact.messageId.trim() || contact.sendStatus.trim().toLowerCase() === SEND_STATUS.Sent) {
      skip(contact, 'already_sent', 'Row already has a successful send recorded');
    } else if (pendingSentEmails.has(key)) {
      skip(contact, 'already_sent', 'An earlier campaign already sent this email but could not mark the row Sent (see Review)');
    } else if (seen.has(key)) {
      skip(contact, 'duplicate_in_campaign', 'Same email appears earlier in this campaign');
    } else if (alreadySentRows.has(key)) {
      skip(contact, 'email_already_sent_elsewhere', `Email was already sent in row ${alreadySentRows.get(key)}`);
    } else {
      seen.add(key);
      selected.push(contact);
    }
  }

  return { totalNew: newContacts.length, blankEmailCount: newRows.length - newContacts.length, selected, skipped };
}

/** 0 → A, 25 → Z, 26 → AA. */
export function columnToLetter(index: number): string {
  let n = index + 1;
  let letters = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    letters = String.fromCharCode(65 + rem) + letters;
    n = Math.floor((n - 1) / 26);
  }
  return letters;
}

/** Quotes a worksheet name for A1 notation: My 'Sheet' → 'My ''Sheet'''. */
export function quoteSheetName(name: string): string {
  return `'${name.replace(/'/g, "''")}'`;
}

export function cellRange(sheetName: string, columnIndex: number, row: number): string {
  return `${quoteSheetName(sheetName)}!${columnToLetter(columnIndex)}${row}`;
}
