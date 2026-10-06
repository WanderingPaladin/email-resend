import { describe, expect, it } from 'vitest';
import { EMAIL_SENT_SHEET_UPDATE_FAILED } from '../shared/constants';
import { settingsSchema, type CampaignStartInput } from '../shared/schemas';
import type { CampaignProgress, CampaignSummary } from '../shared/types';
import { CampaignService } from '../electron/services/campaign.service';
import { createMemoryJournal } from '../electron/services/journal.service';
import { RecoveryService } from '../electron/services/recovery.service';
import { createHarness, sheetRows } from './helpers';

const BODY = 'Hi {{first_name}},\n\nI wanted to reach out regarding an opportunity that may be relevant to you.\n\nBest,\nJulio';

const INPUT: CampaignStartInput = {
  fromName: 'Julio',
  fromEmail: 'julio@example.com',
  subject: 'Engineering Opportunity',
  body: BODY,
  bodyFormat: 'text',
  batchSize: 100,
  concurrency: 5,
  dryRun: false,
  initializeTrackingColumns: false,
};

function setup(rows: string[][]) {
  const h = createHarness(rows);
  const journal = createMemoryJournal();
  const progress: CampaignProgress[] = [];
  const summaries: CampaignSummary[] = [];
  const service = new CampaignService({
    logger: h.logger,
    repo: h.repo,
    journal,
    events: { progress: (p) => progress.push(p), complete: (s) => summaries.push(s) },
    getSettings: () => settingsSchema.parse({ firstNameFallback: 'there' }),
    createSheets: () => h.sheets,
    createMailer: () => h.mailer,
    flushIntervalMs: 5,
  });
  const recovery = new RecoveryService({
    logger: h.logger,
    repo: h.repo,
    journal,
    isGoogleConfigured: () => true,
    createSheets: () => h.sheets,
    isCampaignRunning: () => service.isCampaignRunning(),
  });
  const run = async (input: Partial<CampaignStartInput> = {}) => {
    const started = await service.startCampaign({ ...INPUT, ...input });
    await service.whenIdle();
    const summary = summaries.at(-1);
    if (!summary) throw new Error('campaign did not complete');
    return { started, summary };
  };
  return { ...h, journal, progress, summaries, service, recovery, run };
}

const people: Record<string, string>[] = [
  { first_name: 'Maria', last_name: 'Lopez', email: 'maria@example.com', tag: 'New', notes: 'met at conf' },
  { first_name: 'Carlos', last_name: 'Perez', email: 'carlos@example.com', tag: 'New' },
  { first_name: '', last_name: 'Nameless', email: 'noname@example.com', tag: 'New' },
];

describe('successful campaign', () => {
  it('personalizes, sends and marks rows Sent with tracking data', async () => {
    const t = setup(sheetRows(people));
    t.client.script('maria@example.com', { id: 'f4ae7289-1' });
    const { summary, started } = await t.run();

    expect(summary).toMatchObject({ selected: 3, sent: 3, failed: 0, skipped: 0 });
    const maria = t.client.calls.find((c) => c.to === 'maria@example.com');
    expect(maria?.text).toBe(BODY.replace('{{first_name}}', 'Maria'));
    expect(maria?.from).toBe('Julio <julio@example.com>');
    expect(maria?.subject).toBe('Engineering Opportunity');
    expect(t.client.calls.find((c) => c.to === 'noname@example.com')?.text.startsWith('Hi there,')).toBe(true);

    const row = t.gateway.rowObject(2);
    expect(row).toMatchObject({
      tag: 'Sent',
      send_status: 'sent',
      campaign_id: started.campaignId,
      message_id: 'f4ae7289-1',
      last_error: '',
    });
    expect(new Date(row['sent_at'] ?? '').toISOString()).toBe(row['sent_at']);
    expect(row['notes']).toBe('met at conf');
    expect(t.repo.get('campaignHistory')[0]).toMatchObject({ id: started.campaignId, sent: 3, total: 3 });
    expect(t.repo.get('activeCampaign')).toBeNull();
  });

  it('reserves each contact as Processing before calling the provider', async () => {
    const t = setup(sheetRows(people));
    const seen: Record<string, string>[] = [];
    const original = t.client.emails.send;
    t.client.emails.send = async (payload, options) => {
      const rowIndex = t.gateway.rows.findIndex((r) => r.includes(payload.to));
      seen.push(t.gateway.rowObject(rowIndex + 1));
      return original(payload, options);
    };
    const { started } = await t.run();
    expect(seen).toHaveLength(3);
    for (const row of seen) {
      expect(row).toMatchObject({ tag: 'Processing', send_status: 'processing', campaign_id: started.campaignId });
    }
  });

  it('updates the original sheet rows, not filtered positions', async () => {
    const rows = sheetRows([
      { first_name: 'Old', email: 'old@example.com', tag: 'Sent', message_id: 'x' },
      {},
      { first_name: 'Ana', email: 'ana@example.com', tag: 'New' },
      { first_name: 'Bo', email: 'bo@example.com', tag: 'Failed' },
      { first_name: 'Cy', email: 'cy@example.com', tag: 'new' },
    ]);
    const t = setup(rows);
    const { summary } = await t.run();
    expect(summary.results.map((r) => [r.email, r.sheetRow, r.status])).toEqual([
      ['ana@example.com', 4, 'sent'],
      ['cy@example.com', 6, 'sent'],
    ]);
    expect(t.gateway.rowObject(2)['tag']).toBe('Sent');
    expect(t.gateway.rowObject(2)['message_id']).toBe('x');
    expect(t.gateway.rowObject(4)['tag']).toBe('Sent');
    expect(t.gateway.rowObject(5)['tag']).toBe('Failed');
    expect(t.gateway.rowObject(6)['tag']).toBe('Sent');
  });

  it('logs masked emails only', async () => {
    const t = setup(sheetRows(people));
    await t.run();
    const text = t.logger.text();
    expect(text).toContain('ma***@example.com');
    expect(text).not.toContain('maria@example.com');
    expect(text).toMatch(/Campaign completed\..*sent=3/);
  });
});

describe('failed sends', () => {
  it('marks failures Failed (never Sent) and keeps going', async () => {
    const t = setup(sheetRows(people));
    t.client.script('carlos@example.com', { error: { name: 'validation_error', message: 'Invalid `to` field.', statusCode: 422 } });
    const { summary } = await t.run();
    expect(summary).toMatchObject({ sent: 2, failed: 1 });
    expect(t.gateway.rowObject(3)).toMatchObject({ tag: 'Failed', send_status: 'failed', message_id: '', sent_at: '' });
    expect(t.gateway.rowObject(3)['last_error']).toContain('Invalid `to` field.');
    expect(t.gateway.rowObject(4)['tag']).toBe('Sent');
    expect(t.logger.lines.some((l) => l.level === 'error' && l.message.startsWith('Email failed'))).toBe(true);
  });

  it('parks ambiguous outcomes for manual review instead of marking them New or Sent', async () => {
    const t = setup(sheetRows(people));
    const boom = { throw: new TypeError('socket hang up') };
    t.client.script('maria@example.com', boom, boom, boom, boom);
    const { summary } = await t.run();
    expect(summary.needsReview).toBe(1);
    expect(t.gateway.rowObject(2)).toMatchObject({ tag: 'Processing', send_status: 'review' });
    // Retries reused the idempotency key, so Resend cannot deliver twice.
    const keys = t.client.calls.filter((c) => c.to === 'maria@example.com').map((c) => c.idempotencyKey);
    expect(new Set(keys).size).toBe(1);
  });

  it('stops scheduling on fatal errors and returns unstarted contacts to New', async () => {
    const t = setup(sheetRows(people));
    t.client.script('maria@example.com', { error: { name: 'invalid_api_key', message: 'API key is invalid', statusCode: 403 } });
    const { summary } = await t.run({ concurrency: 1 });
    expect(summary.abortReason).toMatch(/Campaign stopped/);
    expect(summary.sent).toBe(0);
    expect(t.client.calls).toHaveLength(1);
    for (const row of [2, 3, 4]) expect(t.gateway.rowObject(row)).toMatchObject({ tag: 'New', campaign_id: '', send_status: '' });
  });
});

describe('duplicate-send protection', () => {
  it('rejects a second campaign while one is running (double-click)', async () => {
    const t = setup(sheetRows(people));
    const first = t.service.startCampaign(INPUT);
    await expect(t.service.startCampaign(INPUT)).rejects.toThrow('A campaign is already running.');
    await first;
    await t.service.whenIdle();
    expect(t.client.calls).toHaveLength(3);
  });

  it('never selects an email the provider accepted but whose row could not be marked Sent', async () => {
    const t = setup(sheetRows(people));
    t.repo.set('manualReview', [
      {
        id: 'x:2',
        kind: EMAIL_SENT_SHEET_UPDATE_FAILED,
        campaignId: '11111111-1111-1111-1111-111111111111',
        sheetRow: 2,
        email: 'Maria@Example.com',
        resendId: 'm-1',
        timestamp: '2026-09-30T00:00:00Z',
        error: 'quota',
      },
    ]);
    const { summary } = await t.run();
    expect(t.client.calls.map((c) => c.to)).not.toContain('maria@example.com');
    expect(summary.results.find((r) => r.sheetRow === 2)?.status).toBe('skipped');
  });

  it('never resends contacts on a second run', async () => {
    const t = setup(sheetRows(people));
    await t.run();
    await expect(t.service.startCampaign(INPUT)).rejects.toThrow(/no eligible New contacts/);
    expect(t.client.calls).toHaveLength(3);
  });

  it('uses a unique idempotency key per campaign row', async () => {
    const t = setup(sheetRows(people));
    const { started } = await t.run();
    expect(t.client.calls.map((c) => c.idempotencyKey).sort()).toEqual(
      [2, 3, 4].map((r) => `${started.campaignId}:${r}`).sort(),
    );
  });

  it('does not reserve a row that changed between reading and reserving', async () => {
    const t = setup(sheetRows(people));
    let reads = 0;
    t.gateway.beforeRead = () => {
      reads++;
      // Second read happens during reservation: someone else already sent to Carlos.
      if (reads === 2) {
        const row = t.gateway.rows[2];
        if (row) row[3] = 'Sent';
      }
    };
    const { summary } = await t.run();
    expect(t.client.calls.map((c) => c.to)).not.toContain('carlos@example.com');
    expect(summary.results.find((r) => r.email === 'carlos@example.com')?.status).toBe('skipped');
  });
});

describe('limits', () => {
  const many = Array.from({ length: 150 }, (_, i) => ({ first_name: `U${i}`, email: `user${i}@example.com`, tag: 'New' }));

  it('sends up to the chosen email limit, which can be above 100', async () => {
    const t = setup(sheetRows(many));
    const { summary } = await t.run({ batchSize: 120 });
    expect(summary.selected).toBe(120);
    expect(t.client.calls).toHaveLength(120);
    expect(t.gateway.rowObject(122)['tag']).toBe('New');
  });

  it('limits concurrent sends', async () => {
    const t = setup(sheetRows(many.slice(0, 20)));
    let active = 0;
    let peak = 0;
    const original = t.client.emails.send;
    t.client.emails.send = async (payload, options) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 2));
      active--;
      return original(payload, options);
    };
    await t.run({ concurrency: 3 });
    expect(peak).toBeLessThanOrEqual(3);
    expect(peak).toBeGreaterThan(1);
  });
});

describe('dry run', () => {
  it('renders and logs without sending or touching the sheet', async () => {
    const t = setup(sheetRows(people));
    const before = JSON.stringify(t.gateway.rows);
    const { summary } = await t.run({ dryRun: true });
    expect(t.client.calls).toHaveLength(0);
    expect(t.gateway.writeBatches).toHaveLength(0);
    expect(JSON.stringify(t.gateway.rows)).toBe(before);
    expect(summary.results.every((r) => r.status === 'dry_run')).toBe(true);
    expect(t.logger.text()).toContain('[DRY RUN] Would send to ma***@example.com');
    expect(t.repo.get('campaignHistory')).toHaveLength(0);
  });
});

describe('cancellation', () => {
  it('lets in-flight sends finish and returns unstarted contacts to New', async () => {
    const list = Array.from({ length: 6 }, (_, i) => ({ first_name: `U${i}`, email: `u${i}@example.com`, tag: 'New' }));
    const t = setup(sheetRows(list));
    const original = t.client.emails.send;
    t.client.emails.send = async (payload, options) => {
      if (payload.to === 'u0@example.com') t.service.cancelCampaign();
      await new Promise((r) => setTimeout(r, 2));
      return original(payload, options);
    };
    const { summary } = await t.run({ concurrency: 2 });
    expect(summary.cancelled).toBe(true);
    expect(summary.sent).toBe(2); // u0 and u1 were already in flight
    expect(summary.notStarted).toBe(4);
    expect(t.gateway.rowObject(2)['tag']).toBe('Sent');
    expect(t.gateway.rowObject(3)['tag']).toBe('Sent');
    for (const row of [4, 5, 6, 7]) expect(t.gateway.rowObject(row)).toMatchObject({ tag: 'New', campaign_id: '' });
  });
});

describe('sheet update failure after the provider accepted the email', () => {
  it('records EMAIL_SENT_SHEET_UPDATE_FAILED, never resends, and supports manual recovery', async () => {
    const t = setup(sheetRows(people.slice(0, 1)));
    t.client.script('maria@example.com', { id: 're-accepted-1' });
    const original = t.client.emails.send;
    t.client.emails.send = async (payload, options) => {
      const result = await original(payload, options);
      t.gateway.failWrites = 100; // every sheet write from now on fails
      return result;
    };
    const { summary, started } = await t.run();

    expect(summary.sent).toBe(1);
    expect(t.gateway.rowObject(2)).toMatchObject({ tag: 'Processing', message_id: '' });
    const warning = t.logger.lines.find((l) => l.level === 'warn' && l.message.includes(EMAIL_SENT_SHEET_UPDATE_FAILED));
    expect(warning?.message).toContain('Email provider accepted email but Google Sheet status update failed. Manual review required.');
    expect(warning?.message).toContain('resendId=re-accepted-1');
    expect(warning?.message).toContain(`campaignId=${started.campaignId}`);
    expect(t.repo.get('manualReview')).toEqual([
      expect.objectContaining({ campaignId: started.campaignId, sheetRow: 2, resendId: 're-accepted-1', kind: EMAIL_SENT_SHEET_UPDATE_FAILED }),
    ]);

    // Next run: the row is not New, so nothing is sent again.
    t.gateway.failWrites = 0;
    await expect(t.service.startCampaign(INPUT)).rejects.toThrow(/no eligible/);
    expect(t.client.calls).toHaveLength(1);

    // Recovery shows it as accepted and refuses to mark it New.
    const state = await t.recovery.scan();
    expect(state.staleContacts).toEqual([expect.objectContaining({ sheetRow: 2, journalOutcome: 'accepted', journalResendId: 're-accepted-1' })]);
    const refused = await t.recovery.apply({ action: 'mark_new', rows: [{ sheetRow: 2, email: 'maria@example.com' }] });
    expect(refused.updated).toBe(0);
    expect(t.gateway.rowObject(2)['tag']).toBe('Processing');

    const fixed = await t.recovery.apply({ action: 'mark_sent', rows: [{ sheetRow: 2, email: 'maria@example.com' }] });
    expect(fixed.updated).toBe(1);
    expect(t.gateway.rowObject(2)).toMatchObject({ tag: 'Sent', send_status: 'sent', message_id: 're-accepted-1' });
    expect(t.repo.get('manualReview')).toHaveLength(0);
  });
});

describe('sheet structure', () => {
  const minimal = [['First_Name', 'EMAIL', 'Tag'], ['Maria', 'maria@example.com', 'New']];

  it('requires confirmation before adding tracking columns', async () => {
    const t = setup(minimal.map((r) => [...r]));
    await expect(t.service.startCampaign(INPUT)).rejects.toThrow(/missing tracking columns/);
    expect(t.client.calls).toHaveLength(0);
    expect(t.service.isCampaignRunning()).toBe(false);
  });

  it('adds tracking columns after confirmation and then sends', async () => {
    const t = setup(minimal.map((r) => [...r]));
    const { summary } = await t.run({ initializeTrackingColumns: true });
    expect(summary.sent).toBe(1);
    expect(t.gateway.rows[0]).toEqual(['First_Name', 'EMAIL', 'Tag', 'send_status', 'campaign_id', 'sent_at', 'message_id', 'last_error']);
    expect(t.gateway.rowObject(2)).toMatchObject({ tag: 'Sent', send_status: 'sent' });
  });

  it('refuses to start when a required column is missing', async () => {
    const t = setup([['Name', 'Email'], ['Maria', 'maria@example.com']]);
    await expect(t.service.startCampaign(INPUT)).rejects.toThrow(/Batch Flag/);
    expect(t.client.calls).toHaveLength(0);
    expect(t.service.isCampaignRunning()).toBe(false);
  });

  it('ignores New rows without an email: nothing is sent and the row is not changed', async () => {
    const t = setup(
      sheetRows([
        { first_name: 'Blank', email: '', tag: 'New' },
        { first_name: 'Spaces', email: '   ', tag: 'New' },
        { first_name: 'Maria', email: 'maria@example.com', tag: 'New' },
      ]),
    );
    const { summary } = await t.run();
    expect(t.client.calls.map((c) => c.to)).toEqual(['maria@example.com']);
    expect(summary.results.map((r) => r.sheetRow)).toEqual([4]);
    expect(t.gateway.rowObject(2)).toMatchObject({ tag: 'New', send_status: '', campaign_id: '' });
    expect(t.gateway.rowObject(3)).toMatchObject({ tag: 'New', send_status: '', campaign_id: '' });
    const preview = await t.service.previewContacts(100);
    expect(preview).toMatchObject({ blankEmailCount: 2, totalNew: 0, skipped: [] });
  });

  it('follows a row that moved during the campaign', async () => {
    const t = setup(sheetRows(people.slice(0, 1)));
    const original = t.client.emails.send;
    t.client.emails.send = async (payload, options) => {
      // Someone inserts a row above Maria while her email is being sent.
      t.gateway.rows.splice(1, 0, ['Zed', '', 'zed@example.com', 'Lead', '']);
      return original(payload, options);
    };
    await t.run();
    expect(t.gateway.rowObject(2)['email']).toBe('zed@example.com');
    expect(t.gateway.rowObject(2)['tag']).toBe('Lead');
    expect(t.gateway.rowObject(3)).toMatchObject({ email: 'maria@example.com', tag: 'Sent' });
  });
});

describe('crash recovery', () => {
  it('detects stale Processing rows and never resends them automatically', async () => {
    const rows = sheetRows([
      { first_name: 'A', email: 'a@example.com', tag: 'Processing', send_status: 'processing', campaign_id: '11111111-1111-1111-1111-111111111111' },
      { first_name: 'B', email: 'b@example.com', tag: 'New' },
    ]);
    const t = setup(rows);
    t.repo.set('activeCampaign', { campaignId: '11111111-1111-1111-1111-111111111111', startedAt: '2026-09-27T10:00:00Z' });

    const state = await t.recovery.scan();
    expect(state.interruptedCampaignId).toBe('11111111-1111-1111-1111-111111111111');
    expect(state.staleContacts).toEqual([expect.objectContaining({ sheetRow: 2, journalOutcome: 'none' })]);

    await t.run();
    expect(t.client.calls.map((c) => c.to)).toEqual(['b@example.com']);

    const result = await t.recovery.apply({ action: 'mark_failed', rows: [{ sheetRow: 2, email: 'a@example.com' }] });
    expect(result.updated).toBe(1);
    expect(t.gateway.rowObject(2)['tag']).toBe('Failed');
  });

  it('refuses recovery actions on rows whose email no longer matches', async () => {
    const t = setup(sheetRows([{ first_name: 'A', email: 'a@example.com', tag: 'Processing', send_status: 'processing' }]));
    const result = await t.recovery.apply({ action: 'mark_new', rows: [{ sheetRow: 2, email: 'other@example.com' }] });
    expect(result.updated).toBe(0);
    expect(t.gateway.rowObject(2)['tag']).toBe('Processing');
  });
});

describe('test email', () => {
  it('uses mock values and never touches the sheet', async () => {
    const t = setup(sheetRows(people));
    const result = await t.service.sendTest({ ...INPUT, to: 'me@example.com' });
    expect(result.resendId).toMatch(/^re-/);
    expect(t.client.calls[0]?.text.startsWith('Hi John,')).toBe(true);
    expect(t.gateway.reads).toBe(0);
    expect(t.gateway.writeBatches).toHaveLength(0);
  });
});
