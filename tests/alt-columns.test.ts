import { describe, expect, it } from 'vitest';
import { settingsSchema } from '../shared/schemas';
import { CampaignService } from '../electron/services/campaign.service';
import { createMemoryJournal } from '../electron/services/journal.service';
import { buildHeaderMap, missingRequiredColumns, parseContacts, selectContacts, splitFullName } from '../electron/services/sheet-parser';
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

  it('treats Batch Flag as the tag column and Name as the first-name source', () => {
    const headers = buildHeaderMap(HEADERS);
    expect(headers.get('tag')).toBe(9);
    expect(missingRequiredColumns(headers)).toEqual([]);
    const { contacts } = parseContacts([HEADERS, row('Maria Lopez', 'maria@example.com', 'New'), row('Old One', 'old@example.com', 'Sent')]);
    expect(contacts[0]).toMatchObject({ sheetRow: 2, firstName: 'Maria', lastName: 'Lopez', email: 'maria@example.com', tag: 'New' });
    expect(selectContacts(contacts, 100).selected.map((c) => c.email)).toEqual(['maria@example.com']);
  });

  it('prefers real first_name/tag columns when both layouts are present', () => {
    const { contacts } = parseContacts([
      ['Name', 'first_name', 'email', 'tag', 'Batch Flag'],
      ['Maria Lopez', 'Mari', 'maria@example.com', 'New', 'Sent'],
    ]);
    expect(contacts[0]).toMatchObject({ firstName: 'Mari', tag: 'New' });
  });

  it('reports the accepted alternatives when columns are missing', () => {
    expect(missingRequiredColumns(buildHeaderMap(['Email']))).toEqual(['first_name or Name', 'tag or Batch Flag']);
  });

  it('runs a campaign that personalizes from Name and writes status to Batch Flag', async () => {
    const h = createHarness([[...HEADERS], row('Maria Lopez', 'maria@example.com', 'New'), row('', 'noname@example.com', 'New')]);
    // The grid is exactly as wide as the headers (10 columns), like a copied sheet.
    h.gateway.columnCount = 10;
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
      initializeTrackingColumns: true,
    });
    await service.whenIdle();

    expect(h.client.calls.find((c) => c.to === 'maria@example.com')?.text.startsWith('Hi Maria,')).toBe(true);
    expect(h.client.calls.find((c) => c.to === 'noname@example.com')?.subject).toBe('Hi there');
    // Status goes to Batch Flag; tracking columns are appended after it; other columns untouched.
    expect(h.gateway.rows[0]?.slice(0, 10)).toEqual(HEADERS);
    expect(h.gateway.rows[0]?.slice(10)).toEqual(['send_status', 'campaign_id', 'sent_at', 'resend_email_id', 'last_error']);
    expect(h.gateway.rowObject(2)).toMatchObject({ 'batch flag': 'Sent', send_status: 'sent', name: 'Maria Lopez', country: 'Peru' });
    expect(h.gateway.rowObject(2)['tag']).toBeUndefined();
    expect(h.gateway.columnCount).toBe(15);
    expect(h.gateway.gridResizes).toBe(1);
  });
});
