import { FINDER_TAB_HEADERS, TRACKING_COLUMNS } from '../../shared/constants';
import type { FoundContact } from '../../shared/types';
import { buildHeaderMap, resolveColumns, splitFullName } from './sheet-parser';

const ON_PAGE_LABEL: Record<FoundContact['emailOnPage'], string> = { yes: 'Yes', no: 'No', unknown: 'Could not check' };

/** Header row plus one row per contact for a new tab. Batch Flag stays empty until the operator reviews each contact. */
export function finderTabRows(contacts: readonly FoundContact[]): string[][] {
  const header = [...FINDER_TAB_HEADERS, ...TRACKING_COLUMNS];
  const blanks = TRACKING_COLUMNS.map(() => '');
  return [
    header,
    ...contacts.map((c) => [c.name, c.email, c.organization, c.role, c.sourceUrl, ON_PAGE_LABEL[c.emailOnPage], '', ...blanks]),
  ];
}

/** Optional columns filled only when the tab already has them (normalized header names). */
const OPTIONAL_NAMES = {
  organization: ['organization', 'organisation', 'company', 'company name'],
  role: ['role', 'title', 'job title', 'position', 'role / profile', 'role/profile'],
  emailOnPage: ['email on page'],
} as const;
const SOURCE_NAMES = ['source url', 'source', 'url'];

export interface AppendPlan {
  /** Columns added to the right of the existing headers (zero-based index and header text). */
  addedColumns: { index: number; label: string }[];
  /** One row per contact, as wide as the header row after the additions. */
  rows: string[][];
  /** Sheet row number where the first contact goes (below the last row in use). */
  firstRow: number;
  width: number;
}

/**
 * Places contacts into an existing tab by its own header names. Missing Name, Email, Batch Flag
 * and Source URL columns are added at the end; nothing is reordered and no existing cell changes.
 * Organization, Role and "Email on page" are filled only when the tab has such columns.
 */
export function planAppend(values: readonly (readonly string[])[], contacts: readonly FoundContact[]): AppendPlan {
  const headerRow = [...(values[0] ?? [])].map(String);
  // The header row may be shorter than the data rows; never place a new column over data.
  let width = Math.max(headerRow.length, ...values.map((r) => r.length));
  const headers = buildHeaderMap(headerRow);
  const columns = resolveColumns(headers);
  const find = (names: readonly string[]) => names.map((n) => headers.get(n)).find((i) => i !== undefined);
  const addedColumns: AppendPlan['addedColumns'] = [];
  const add = (label: string) => {
    addedColumns.push({ index: width, label });
    return width++;
  };

  const nameCol = columns.fullName ?? columns.firstName ?? add('Name');
  const splitName = columns.fullName === undefined && columns.firstName !== undefined;
  const emailCol = columns.email ?? add('Email');
  if (columns.status === undefined) add('Batch Flag');
  const sourceCol = find(SOURCE_NAMES) ?? add('Source URL');
  const orgCol = find(OPTIONAL_NAMES.organization);
  const roleCol = find(OPTIONAL_NAMES.role);
  const onPageCol = find(OPTIONAL_NAMES.emailOnPage);

  const rows = contacts.map((c) => {
    const row = Array.from({ length: width }, () => '');
    if (splitName) {
      const { firstName, lastName } = splitFullName(c.name);
      row[nameCol] = firstName;
      if (columns.lastName !== undefined) row[columns.lastName] = lastName;
    } else {
      row[nameCol] = c.name;
    }
    row[emailCol] = c.email;
    row[sourceCol] = c.sourceUrl;
    if (orgCol !== undefined) row[orgCol] = c.organization;
    if (roleCol !== undefined) row[roleCol] = c.role;
    if (onPageCol !== undefined) row[onPageCol] = ON_PAGE_LABEL[c.emailOnPage];
    return row;
  });

  return { addedColumns, rows, firstRow: Math.max(values.length, 1) + 1, width };
}
