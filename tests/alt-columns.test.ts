import { describe, expect, it } from 'vitest';
import { settingsSchema } from '../shared/schemas';
import { CampaignService } from '../electron/services/campaign.service';
import { createMemoryJournal } from '../electron/services/journal.service';
import { buildHeaderMap, missingRequiredColumns, parseContacts, resolveColumns, selectContacts, splitFullName } from '../electron/services/sheet-parser';
import { createHarness } from './helpers';

// Xing's sheet layout.
const HEADERS = [
  'Name',
  'Email',
  'Location',
  'Country',
  'Role / Profile',
  'English Evidence',
  'Contact / Availability Evidence',
  'Source URL',
  'Latams Duplicate',
  'Batch Flag',
];
const row = (name: string, email: string, flag: string) => [name, email, 'Lima', 'Peru', 'Engineer', 'C1', 'Open', 'https://example.com', '', flag];

describe('Name / Batch Flag layout', () => {
  it('splits full names', () => {
    expect(splitFullName('Maria Lopez')).toEqual({ firstName: 'Maria', lastName: 'Lopez' });
    expect(splitFullName('  Carlos   de la Cruz ')).toEqual({ firstName: 'Carlos', lastName: 'de la Cruz' });
    expect(splitFullName('Lopez, Maria Jose')).toEqual({ firstName: 'Maria', lastName: 'Jose Lopez' });
    expect(splitFullName('Ana')).toEqual({ firstName: 'Ana', lastName: '' });
    expect(splitFullName('')).toEqual({ firstName: '', lastName: '' });
  });

  it('treats Batch Flag as the status column and Name as the first-name source', () => {
    const headers = buildHeaderMap(HEADERS);
    expect(resolveColumns(headers)).toMatchObject({ status: 9, email: 1, fullName: 0 });
    expect(missingRequiredColumns(headers)).toEqual([]);
    const { contacts } = parseContacts([HEADERS, row('Maria Lopez', 'maria@example.com', 'New'), row('Old One', 'old@example.com', 'Sent')]);
    expect(contacts[0]).toMatchObject({ sheetRow: 2, firstName: 'Maria', lastName: 'Lopez', email: 'maria@example.com', tag: 'New' });
    expect(selectContacts(contacts, 100).selected.map((c) => c.email)).toEqual(['maria@example.com']);
  });

  it('prefers first_name over Name, and Batch Flag over tag, when both are present', () => {
    const { contacts } = parseContacts([
      ['Name', 'first_name', 'email', 'tag', 'Batch Flag'],
      ['Maria Lopez', 'Mari', 'maria@example.com', 'New', 'Sent'],
    ]);
    expect(contacts[0]).toMatchObject({ firstName: 'Mari', tag: 'Sent' });
  });

  it('reports the accepted alternatives when columns are missing', () => {
    expect(missingRequiredColumns(buildHeaderMap(['Email']))).toEqual(['Name (or first_name)', 'Batch Flag']);
  });

  it('runs a campaign that personalizes from Name and writes status to Batch Flag', async () => {
    const h = createHarness([[...HEADERS], row('Maria Lopez', 'maria@example.com', 'New'), row('', 'noname@example.com', 'New')]);
    const summaries: unknown[] = [];
    const service = new CampaignService({
      logger: h.logger,
      repo: h.repo,
      journal: createMemoryJournal(),
      events: { progress: () => undefined, complete: (s) => summaries.push(s) },
      getSettings: () => settingsSchema.parse({}),
      createSheets: () => h.sheets,
      createMailer: () => h.mailer,
      flushIntervalMs: 5,
    });
    await service.startCampaign({
      fromName: 'Julio',
      fromEmail: 'julio@example.com',
      subject: 'Hi {{first_name}}',
      body: 'Hi {{first_name}},\n\nBest,\nJulio',
      bodyFormat: 'text',
      batchSize: 100,
      concurrency: 2,
      dryRun: false,
    });
    await service.whenIdle();

    expect(h.client.calls.find((c) => c.to === 'maria@example.com')?.text.startsWith('Hi Maria,')).toBe(true);
    expect(h.client.calls.find((c) => c.to === 'noname@example.com')?.subject).toBe('Hi there');
    // Status goes to Batch Flag; no columns are added and every other column is untouched.
    expect(h.gateway.rows[0]).toEqual(HEADERS);
    expect(h.gateway.rows[1]).toEqual(row('Maria Lopez', 'maria@example.com', 'Sent'));
    expect(h.gateway.rows[2]).toEqual(row('', 'noname@example.com', 'Sent'));
  });
});
