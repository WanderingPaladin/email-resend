import { describe, expect, it } from 'vitest';
import { GoogleSheetsService } from '../electron/services/google-sheets.service';
import { FakeSheetsGateway, MemoryLogger, noSleep } from './helpers';

describe('Google Sheets connection test', () => {
  it('reports only the name, email, Batch Flag and tracking columns', async () => {
    const gateway = new FakeSheetsGateway([
      ['Name', 'Email', 'Location', 'Country', 'Role / Profile', 'Batch Flag', 'send_status', 'message_id'],
      ['Ana Lopez', 'ana@example.com', 'Austin', 'US', 'HR', 'New', '', ''],
      ['Bo Chen', '', 'Paris', 'FR', 'CTO', 'New', '', ''],
      ['', '', 'Only other columns', 'US', 'x', '', '', ''],
      ['Cy Diaz', 'cy@example.com', '', '', '', 'Sent', 'sent', 'm-1'],
    ]);
    const sheets = new GoogleSheetsService(gateway, { spreadsheetId: 's', worksheetName: 'Emails', serviceAccountEmail: '' }, new MemoryLogger(), { sleepFn: noSleep });
    const result = await sheets.testConnection();
    expect(result.columns).toEqual({ name: 'Name', email: 'Email', status: 'Batch Flag' });
    expect(result.trackingColumns).toEqual(['send_status', 'message_id']);
    expect(result.missingTrackingColumns).toEqual(['campaign_id', 'sent_at', 'last_error']);
    expect(result.rowCount).toBe(3);
    expect(result.newCount).toBe(1);
    expect(result.newWithoutEmailCount).toBe(1);
    expect(result).not.toHaveProperty('headers');
  });

  it('names only the columns it needs when one is missing', async () => {
    const gateway = new FakeSheetsGateway([['Name', 'Location', 'Batch Flag']]);
    const sheets = new GoogleSheetsService(gateway, { spreadsheetId: 's', worksheetName: 'Emails', serviceAccountEmail: '' }, new MemoryLogger(), { sleepFn: noSleep });
    const message = await sheets.testConnection().catch((e: Error) => e.message);
    expect(message).toContain('Required column(s) missing from the header row: Email.');
    expect(message).not.toContain('Location');
  });
});
