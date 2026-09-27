import {
  MAX_BATCH_SIZE,
  REQUIRED_COLUMNS,
  SEND_STATUS,
  TAG,
  TRACKING_COLUMNS,
  UNSUBSCRIBED_VALUES,
} from '../../shared/constants';
import { emailSchema } from '../../shared/schemas';
import type { ContactRow, SkippedContact } from '../../shared/types';

/**
 * Pure spreadsheet parsing and contact-selection logic.
 * Kept free of Google/Electron imports so every rule can be unit tested.
 */

export type HeaderMap = Map<string, number>;

export function normalizeHeader(header: string): string {
  return header.trim().toLowerCase();
}

/**
 * Alternative header names. When the canonical column is absent, the first alias present is
 * used for reading and for status writes, e.g. a sheet with "Batch Flag" instead of "tag".
 */
export const COLUMN_ALIASES: Record<string, readonly string[]> = {
  tag: ['batch flag', 'batch_flag'],
};

/** Headers holding a full name, used to derive first_name/last_name when those columns are absent. */
export const FULL_NAME_HEADERS = ['name', 'full name', 'full_name'] as const;

/** Maps normalized header name → zero-based column index. The first occurrence wins. */
export function buildHeaderMap(headerRow: readonly unknown[]): HeaderMap {
  const map: HeaderMap = new Map();
  headerRow.forEach((cell, index) => {
    const name = normalizeHeader(String(cell ?? ''));
    if (name && !map.has(name)) map.set(name, index);
  });
  for (const [canonical, aliases] of Object.entries(COLUMN_ALIASES)) {
    if (map.has(canonical)) continue;
    const alias = aliases.find((a) => map.has(a));
    if (alias !== undefined) map.set(canonical, map.get(alias) as number);
  }
  return map;
}

function fullNameColumn(headers: HeaderMap): string | undefined {
  return FULL_NAME_HEADERS.find((h) => headers.has(h));
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

const HEADER_HINTS: Record<string, string> = { first_name: 'first_name or Name', tag: 'tag or Batch Flag' };

export function missingRequiredColumns(headers: HeaderMap): string[] {
  return REQUIRED_COLUMNS.filter((c) => !headers.has(c) && !(c === 'first_name' && fullNameColumn(headers))).map(
    (c) => HEADER_HINTS[c] ?? c,
  );
}

export function missingTrackingColumns(headers: HeaderMap): string[] {
  return TRACKING_COLUMNS.filter((c) => !headers.has(c));
}

function cell(row: readonly unknown[], headers: HeaderMap, name: string): string {
  const index = headers.get(name);
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
export function parseContacts(values: readonly (readonly unknown[])[]): { headers: HeaderMap; contacts: ContactRow[] } {
  const headers = buildHeaderMap(values[0] ?? []);
  const nameColumn = headers.has('first_name') ? undefined : fullNameColumn(headers);
  const contacts: ContactRow[] = [];
  for (let i = 1; i < values.length; i++) {
    const row = values[i] ?? [];
    if (row.every((c) => String(c ?? '').trim() === '')) continue;
    const derived = nameColumn ? splitFullName(cell(row, headers, nameColumn)) : null;
    contacts.push({
      sheetRow: i + 1,
      firstName: derived ? derived.firstName : cell(row, headers, 'first_name'),
      lastName: headers.has('last_name') || !derived ? cell(row, headers, 'last_name') : derived.lastName,
      email: cell(row, headers, 'email'),
      company: cell(row, headers, 'company'),
      tag: cell(row, headers, 'tag'),
      sendStatus: cell(row, headers, 'send_status'),
      campaignId: cell(row, headers, 'campaign_id'),
      sentAt: cell(row, headers, 'sent_at'),
      resendEmailId: cell(row, headers, 'resend_email_id'),
      lastError: cell(row, headers, 'last_error'),
      unsubscribed: cell(row, headers, 'unsubscribed'),
    });
  }
  return { headers, contacts };
}

export function isNewTag(tag: string): boolean {
  return tag.trim().toLowerCase() === TAG.New.toLowerCase();
}

export function isUnsubscribed(value: string): boolean {
  return (UNSUBSCRIBED_VALUES as readonly string[]).includes(value.trim().toLowerCase());
}

export function isValidEmail(email: string): boolean {
  return emailSchema.safeParse(email.trim()).success;
}

/** True when the row shows any sign of a previous successful send. */
export function looksAlreadySent(contact: ContactRow): boolean {
  return (
    contact.tag.trim().toLowerCase() === TAG.Sent.toLowerCase() ||
    contact.sendStatus.trim().toLowerCase() === SEND_STATUS.Sent ||
    contact.resendEmailId.trim() !== ''
  );
}

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
  totalNew: number;
  selected: ContactRow[];
  skipped: SkippedContact[];
}

/**
 * Walks New contacts in sheet order and picks up to `batchSize` eligible ones.
 * Ineligible New contacts seen along the way are reported as skipped.
 * The batch size is clamped to MAX_BATCH_SIZE here, so no caller can exceed it.
 */
export function selectContacts(contacts: readonly ContactRow[], requestedBatchSize: number): SelectionResult {
  const batchSize = clampBatchSize(requestedBatchSize);
  const newContacts = contacts.filter((c) => isNewTag(c.tag));

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

    if (!email) {
      skip(contact, 'blank_email', 'Email is blank');
    } else if (isUnsubscribed(contact.unsubscribed)) {
      skip(contact, 'unsubscribed', 'Contact is unsubscribed');
    } else if (!isValidEmail(email)) {
      skip(contact, 'invalid_email', 'Email address is not valid');
    } else if (contact.resendEmailId || contact.sendStatus.trim().toLowerCase() === SEND_STATUS.Sent) {
      skip(contact, 'already_sent', 'Row already has a successful send recorded');
    } else if (seen.has(key)) {
      skip(contact, 'duplicate_in_campaign', 'Same email appears earlier in this campaign');
    } else if (alreadySentRows.has(key)) {
      skip(contact, 'email_already_sent_elsewhere', `Email was already sent in row ${alreadySentRows.get(key)}`);
    } else {
      seen.add(key);
      selected.push(contact);
    }
  }

  return { totalNew: newContacts.length, selected, skipped };
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
