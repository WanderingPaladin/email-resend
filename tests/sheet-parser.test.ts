import { describe, expect, it } from 'vitest';
import { MAX_BATCH_SIZE } from '../shared/constants';
import {
  buildHeaderMap,
  clampBatchSize,
  columnToLetter,
  findStaleProcessing,
  isValidEmail,
  missingRequiredColumns,
  normalizeHeader,
  parseContacts,
  quoteSheetName,
  selectContacts,
} from '../electron/services/sheet-parser';

const contact = (email: string, extra: Partial<Record<string, string>> = {}) => ({
  first_name: 'Ana',
  email,
  tag: 'New',
  ...extra,
});

function rows(headers: string[], records: Record<string, string>[]): string[][] {
  return [headers, ...records.map((r) => headers.map((h) => r[h.trim().toLowerCase()] ?? ''))];
}

describe('header parsing', () => {
  it('normalizes headers: trim, lowercase, and _ or - treated as a space', () => {
    expect(normalizeHeader('  First_Name ')).toBe('first name');
    expect(normalizeHeader('Batch-Flag')).toBe('batch flag');
    const map = buildHeaderMap([' EMAIL', 'Tag ', 'First_Name']);
    expect(map.get('email')).toBe(0);
    expect(map.get('tag')).toBe(1);
    expect(map.get('first name')).toBe(2);
  });

  it('reads only name, email and status, whatever else the sheet has', () => {
    const { contacts } = parseContacts([
      ['Company', 'First Name', 'Last Name', 'E-mail', 'Unsubscribed', 'Batch Flag'],
      ['Acme', 'Carlos', 'Lopez', 'carlos@example.com', 'yes', 'New'],
    ]);
    expect(contacts[0]).toEqual({ sheetRow: 2, firstName: 'Carlos', lastName: 'Lopez', email: 'carlos@example.com', tag: 'New' });
  });

  it('reads columns by name regardless of order', () => {
    const a = parseContacts(rows(['first_name', 'last_name', 'email', 'tag'], [{ first_name: 'Carlos', last_name: 'Lopez', email: 'carlos@example.com', tag: 'New' }]));
    const b = parseContacts(rows(['email', 'tag', 'company', 'first_name', 'last_name'], [{ first_name: 'Carlos', last_name: 'Lopez', email: 'carlos@example.com', tag: 'New', company: 'Acme' }]));
    for (const parsed of [a, b]) {
      expect(parsed.contacts[0]).toMatchObject({ firstName: 'Carlos', lastName: 'Lopez', email: 'carlos@example.com', tag: 'New' });
    }
  });

  it('reports missing required columns', () => {
    expect(missingRequiredColumns(buildHeaderMap(['Email', 'TAG']))).toEqual(['Name (or first_name)']);
    expect(missingRequiredColumns(buildHeaderMap(['Name']))).toEqual(['Email', 'Batch Flag']);
    expect(missingRequiredColumns(buildHeaderMap(['Name', 'Email', 'Batch Flag']))).toEqual([]);
  });

  it('tolerates short rows (Sheets omits trailing empty cells)', () => {
    const { contacts } = parseContacts([['first_name', 'email', 'tag', 'last_name'], ['Ana', 'ana@example.com', 'New']]);
    expect(contacts[0]?.lastName).toBe('');
  });
});

describe('row number preservation', () => {
  it('uses the real spreadsheet row, not the filtered index', () => {
    const values = [
      ['first_name', 'email', 'tag'],
      ['A', 'a@example.com', 'Sent'], // row 2
      ['', '', ''], // row 3 (blank)
      ['B', 'b@example.com', 'New'], // row 4
      ['C', 'c@example.com', 'Failed'], // row 5
      ['D', 'd@example.com', 'new'], // row 6
    ];
    const { contacts } = parseContacts(values);
    expect(contacts.map((c) => c.sheetRow)).toEqual([2, 4, 5, 6]);
    const { selected } = selectContacts(contacts, 100);
    expect(selected.map((c) => [c.email, c.sheetRow])).toEqual([
      ['b@example.com', 4],
      ['d@example.com', 6],
    ]);
  });
});

describe('contact selection', () => {
  const headers = ['first_name', 'email', 'tag'];

  it('selects only tag = New, case- and whitespace-insensitive', () => {
    const { contacts } = parseContacts(
      rows(headers, [contact('a@example.com', { tag: ' NEW ' }), contact('b@example.com', { tag: 'Sent' }), contact('c@example.com', { tag: 'Processing' }), contact('d@example.com', { tag: 'new' })]),
    );
    const result = selectContacts(contacts, 100);
    expect(result.totalNew).toBe(2);
    expect(result.selected.map((c) => c.email)).toEqual(['a@example.com', 'd@example.com']);
  });

  it('never selects more than MAX_BATCH_SIZE, even when asked for more', () => {
    const many = Array.from({ length: 250 }, (_, i) => contact(`user${i}@example.com`));
    const { contacts } = parseContacts(rows(headers, many));
    expect(selectContacts(contacts, 1000).selected).toHaveLength(MAX_BATCH_SIZE);
    expect(selectContacts(contacts, 100).selected).toHaveLength(100);
    expect(selectContacts(contacts, 7).selected).toHaveLength(7);
    expect(clampBatchSize(0)).toBe(1);
    expect(clampBatchSize(Number.NaN)).toBe(MAX_BATCH_SIZE);
  });

  it('skips blank and invalid emails', () => {
    const { contacts } = parseContacts(rows(headers, [contact(''), contact('not-an-email'), contact('ok@example.com')]));
    const result = selectContacts(contacts, 100);
    expect(result.selected.map((c) => c.email)).toEqual(['ok@example.com']);
    expect(result.skipped.map((s) => s.reason)).toEqual(['blank_email', 'invalid_email']);
  });

  it('skips duplicate emails within the campaign (case-insensitive)', () => {
    const { contacts } = parseContacts(rows(headers, [contact('Dup@Example.com'), contact('dup@example.com'), contact('other@example.com')]));
    const result = selectContacts(contacts, 100);
    expect(result.selected.map((c) => c.sheetRow)).toEqual([2, 4]);
    expect(result.skipped).toEqual([expect.objectContaining({ sheetRow: 3, reason: 'duplicate_in_campaign' })]);
  });

  it('skips emails awaiting manual review after an accepted send', () => {
    const { contacts } = parseContacts(rows(headers, [contact('a@example.com'), contact('c@example.com')]));
    const result = selectContacts(contacts, 100, new Set(['a@example.com']));
    expect(result.selected.map((c) => c.email)).toEqual(['c@example.com']);
    expect(result.skipped.map((s) => s.reason)).toEqual(['already_sent']);
  });

  it('skips an email that was already sent from another row', () => {
    const { contacts } = parseContacts(rows(headers, [contact('same@example.com', { tag: 'Sent' }), contact('SAME@example.com')]));
    const result = selectContacts(contacts, 100);
    expect(result.selected).toHaveLength(0);
    expect(result.skipped[0]?.reason).toBe('email_already_sent_elsewhere');
  });
});

describe('stale Processing detection', () => {
  it('finds rows left in Processing', () => {
    const { contacts } = parseContacts(
      rows(['first_name', 'email', 'tag'], [
        contact('a@example.com', { tag: 'Processing' }),
        contact('b@example.com', { tag: 'Sent' }),
        contact('c@example.com', { tag: ' processing ' }),
        contact('d@example.com'),
      ]),
    );
    expect(findStaleProcessing(contacts).map((c) => c.sheetRow)).toEqual([2, 4]);
  });
});

describe('email validation and A1 helpers', () => {
  it('validates emails with Zod', () => {
    expect(isValidEmail('maria@example.com')).toBe(true);
    expect(isValidEmail(' maria@example.com ')).toBe(true);
    for (const bad of ['', 'maria', 'maria@', '@example.com', 'a b@example.com']) expect(isValidEmail(bad)).toBe(false);
  });

  it('converts column indexes and quotes sheet names', () => {
    expect(columnToLetter(0)).toBe('A');
    expect(columnToLetter(25)).toBe('Z');
    expect(columnToLetter(26)).toBe('AA');
    expect(columnToLetter(701)).toBe('ZZ');
    expect(quoteSheetName("Bob's list")).toBe("'Bob''s list'");
  });
});
