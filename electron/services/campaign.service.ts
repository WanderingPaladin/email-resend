import { randomUUID } from 'node:crypto';
import pLimit from 'p-limit';
import {
  CAMPAIGN_HISTORY_LIMIT,
  EMAIL_SENT_SHEET_UPDATE_FAILED,
  MAX_BATCH_SIZE,
  MAX_CONCURRENCY,
  MIN_CONCURRENCY,
  TEST_EMAIL_VARIABLES,
} from '../../shared/constants';
import type { CampaignStartInput, SendTestInput, Settings } from '../../shared/schemas';
import type {
  CampaignHistoryEntry,
  CampaignProgress,
  CampaignStartResult,
  CampaignState,
  CampaignSummary,
  ContactResult,
  ContactRow,
  ManualReviewItem,
  PreviewResult,
  SkippedContact,
  TestEmailResult,
} from '../../shared/types';
import type { SettingsRepository } from '../repositories/settings.repository';
import type { AppLogger } from '../types/logger';
import {
  failedUpdate,
  releaseUpdate,
  reviewUpdate,
  sentUpdate,
  type GoogleSheetsService,
  type RowUpdate,
} from './google-sheets.service';
import type { CampaignJournal } from './journal.service';
import { maskEmail } from './log-format';
import type { Mailer } from './mailer';

export { formatFrom } from './mailer';
import { findStaleProcessing, selectContacts } from './sheet-parser';
import { buildVariables, renderEmail, validateTemplate } from './template.service';

export interface CampaignEvents {
  progress(progress: CampaignProgress): void;
  complete(summary: CampaignSummary): void;
}

export interface CampaignServiceDeps {
  logger: AppLogger;
  repo: SettingsRepository;
  journal: CampaignJournal;
  events: CampaignEvents;
  getSettings(): Settings;
  /** Throws a user-facing error when Google is not configured. */
  createSheets(): GoogleSheetsService;
  /** Throws a user-facing error when the selected email provider is not configured. */
  createMailer(): Mailer;
  newId?: () => string;
  now?: () => Date;
  /** How often buffered sheet status updates are written. */
  flushIntervalMs?: number;
}

interface PreparedCampaign {
  campaignId: string;
  input: CampaignStartInput;
  settings: Settings;
  contacts: ContactRow[];
  skipped: SkippedContact[];
  sheets: GoogleSheetsService | null;
  mailer: Mailer | null;
  startedAt: string;
}

interface RunContext {
  prepared: PreparedCampaign;
  progress: CampaignProgress;
  results: Map<number, ContactResult>;
  cancelRequested: boolean;
  abortReason: string;
  writer: StatusWriter | null;
}

type WriteKind = 'sent' | 'failed' | 'review';

interface QueuedWrite {
  update: RowUpdate;
  kind: WriteKind;
  resendId: string;
}

/**
 * Buffers per-contact sheet updates and writes them in batches. Google Sheets allows about
 * 60 write requests per minute per user, so one write per contact would hit the quota on a
 * 100-contact campaign. Each flush is a single verified batch write.
 */
class StatusWriter {
  private pending: QueuedWrite[] = [];
  private chain: Promise<void> = Promise.resolve();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly sheets: GoogleSheetsService,
    private readonly intervalMs: number,
    private readonly onFailure: (item: QueuedWrite, reason: string) => void,
  ) {}

  start(): void {
    this.timer = setInterval(() => void this.flush(), this.intervalMs);
  }

  enqueue(item: QueuedWrite): void {
    this.pending.push(item);
    if (this.pending.length >= 25) void this.flush();
  }

  flush(): Promise<void> {
    this.chain = this.chain.then(() => this.flushNow());
    return this.chain;
  }

  private async flushNow(): Promise<void> {
    const batch = this.pending.splice(0);
    if (batch.length === 0) return;
    let failures: { update: RowUpdate; reason: string }[];
    try {
      failures = await this.sheets.applyRowUpdates(batch.map((b) => b.update));
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      failures = batch.map((b) => ({ update: b.update, reason }));
    }
    for (const failure of failures) {
      const item = batch.find((b) => b.update === failure.update);
      if (item) this.onFailure(item, failure.reason);
    }
  }

  async close(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.flush();
  }
}

/**
 * Orchestrates campaigns: contact selection, reservation, rendering, sending, status updates,
 * progress events and history. Duplicate-send protection lives here:
 * - one campaign at a time (in-memory lock taken synchronously, before any await)
 * - contacts are reserved (Batch Flag = Processing, campaign_id) in the sheet before any email is sent
 * - rows with any sign of a previous send are never selected, nor emails awaiting manual review
 * - retries happen only when they cannot duplicate (rate limits, or provider idempotency keys)
 * - ambiguous outcomes are parked for manual review (send_status = review) instead of retried
 */
export class CampaignService {
  private running = false;
  private context: RunContext | null = null;
  private lastSummary: CampaignSummary | null = null;
  private currentRun: Promise<void> | null = null;
  private readonly newId: () => string;
  private readonly now: () => Date;

  constructor(private readonly deps: CampaignServiceDeps) {
    this.newId = deps.newId ?? randomUUID;
    this.now = deps.now ?? (() => new Date());
  }

  isCampaignRunning(): boolean {
    return this.running;
  }

  getState(): CampaignState {
    return {
      running: this.running,
      progress: this.context ? { ...this.context.progress } : null,
      lastSummary: this.lastSummary,
    };
  }

  getHistory(): CampaignHistoryEntry[] {
    return this.deps.repo.get('campaignHistory');
  }

  /** Resolves when the current campaign (if any) has fully finished. Used by tests and shutdown. */
  async whenIdle(): Promise<void> {
    await this.currentRun;
  }

  async previewContacts(batchSize: number): Promise<PreviewResult> {
    const sheets = this.deps.createSheets();
    const snapshot = await sheets.readSheet();
    const selection = selectContacts(snapshot.contacts, batchSize, this.pendingSentEmails());
    this.deps.logger.info('google', `Found ${selection.totalNew} New contacts`, {
      selected: selection.selected.length,
      skipped: selection.skipped.length,
    });
    return {
      totalRows: snapshot.totalRows,
      totalNew: selection.totalNew,
      batchSize: Math.min(batchSize, MAX_BATCH_SIZE),
      selected: selection.selected.map((c) => ({
        sheetRow: c.sheetRow,
        firstName: c.firstName,
        lastName: c.lastName,
        email: c.email,
        tag: c.tag,
      })),
      skipped: selection.skipped,
      blankEmailCount: selection.blankEmailCount,
      missingTrackingColumns: snapshot.missingTrackingColumns,
      staleProcessingCount: findStaleProcessing(snapshot.contacts).length,
    };
  }

  async sendTest(input: SendTestInput): Promise<TestEmailResult> {
    const templateError = validateTemplate(input);
    if (templateError) throw new Error(templateError);
    const mailer = this.deps.createMailer();
    const rendered = renderEmail(input, { ...TEST_EMAIL_VARIABLES });
    this.deps.logger.info('resend', `Sending test email via ${mailer.providerLabel}`, { to: maskEmail(input.to) });
    const result = await mailer.sendEmail({
      fromName: input.fromName,
      fromEmail: input.fromEmail,
      to: input.to,
      subject: rendered.subject,
      html: rendered.html,
      text: rendered.text,
      idempotencyKey: `test:${this.newId()}`,
    });
    if (!result.success) {
      this.deps.logger.error('resend', 'Test email failed', { to: maskEmail(input.to), reason: result.error });
      throw new Error(result.error);
    }
    this.deps.logger.info('resend', 'Test email sent', { to: maskEmail(input.to), resendId: result.id });
    return { resendId: result.id };
  }

  /**
   * Validates, reads the sheet, selects and reserves contacts, then starts sending in the
   * background. Resolves once sending has started; progress arrives through events.
   */
  async startCampaign(input: CampaignStartInput): Promise<CampaignStartResult> {
    // The lock is taken synchronously so a double-click cannot start two campaigns.
    if (this.running) throw new Error('A campaign is already running.');
    this.running = true;
    let prepared: PreparedCampaign;
    try {
      prepared = await this.prepare(input);
    } catch (error) {
      this.running = false;
      throw error;
    }
    this.currentRun = this.run(prepared)
      .catch((error: unknown) => {
        const reason = error instanceof Error ? error.message : String(error);
        this.deps.logger.error('campaign', 'Campaign stopped unexpectedly; unfinished rows remain in Processing for review', {
          campaignId: prepared.campaignId,
          reason,
        });
        if (this.context) {
          this.context.abortReason = `Campaign stopped unexpectedly: ${reason}`;
          const summary = this.buildSummary(this.context);
          this.lastSummary = summary;
          this.deps.events.complete(summary);
        }
      })
      .finally(() => {
        this.running = false;
        this.context = null;
      });
    return { campaignId: prepared.campaignId, selected: prepared.contacts.length, skipped: prepared.skipped.length };
  }

  /** Stops scheduling new contacts. Sends already in flight finish and are recorded normally. */
  cancelCampaign(): boolean {
    const ctx = this.context;
    if (!this.running || !ctx) return false;
    if (!ctx.cancelRequested) {
      ctx.cancelRequested = true;
      ctx.progress.cancelRequested = true;
      this.deps.logger.warn('campaign', 'Campaign cancellation requested. Active sends will finish; no new contacts will start.', {
        campaignId: ctx.prepared.campaignId,
      });
      this.deps.events.progress({ ...ctx.progress });
    }
    return true;
  }

  /** Emails the provider accepted whose row could not be marked Sent; never selected again automatically. */
  private pendingSentEmails(): Set<string> {
    return new Set(this.deps.repo.get('manualReview').map((r) => r.email.trim().toLowerCase()));
  }

  // -------------------------------------------------------------------------

  private async prepare(input: CampaignStartInput): Promise<PreparedCampaign> {
    const { logger } = this.deps;
    const templateError = validateTemplate(input);
    if (templateError) throw new Error(templateError);

    // Re-clamp everything the renderer sent, even though the IPC schema already validated it.
    const batchSize = Math.max(1, Math.min(MAX_BATCH_SIZE, Math.floor(input.batchSize)));
    const concurrency = Math.max(MIN_CONCURRENCY, Math.min(MAX_CONCURRENCY, Math.floor(input.concurrency)));
    const safeInput: CampaignStartInput = { ...input, batchSize, concurrency };

    const settings = this.deps.getSettings();
    const sheets = this.deps.createSheets();
    const mailer = input.dryRun ? null : this.deps.createMailer();

    const interrupted = this.deps.repo.get('activeCampaign');
    if (interrupted && !input.dryRun) {
      logger.warn('campaign', 'A previous campaign did not finish cleanly; its Processing rows are excluded and need review', {
        previousCampaignId: interrupted.campaignId,
      });
    }

    let snapshot = await sheets.readSheet();
    if (snapshot.missingTrackingColumns.length > 0 && !input.dryRun) {
      if (!input.initializeTrackingColumns) {
        throw new Error(
          `The sheet is missing tracking columns: ${snapshot.missingTrackingColumns.join(', ')}. Confirm that they may be added and try again.`,
        );
      }
      await sheets.initializeTrackingColumns();
      snapshot = await sheets.readSheet();
    }

    const selection = selectContacts(snapshot.contacts, batchSize, this.pendingSentEmails());
    if (selection.blankEmailCount > 0) {
      logger.info('campaign', `Ignored ${selection.blankEmailCount} New row(s) with no email address`);
    }
    logger.info('campaign', `Found ${selection.totalNew} New contacts`);
    for (const s of selection.skipped) {
      logger.info('campaign', 'Skipped contact', { row: s.sheetRow, email: maskEmail(s.email), reason: s.detail });
    }
    if (selection.selected.length === 0) {
      throw new Error('There are no eligible New contacts to send to.');
    }

    const campaignId = this.newId();
    const startedAt = this.now().toISOString();
    let contacts = selection.selected;
    const skipped = [...selection.skipped];

    if (!input.dryRun) {
      this.deps.repo.set('activeCampaign', { campaignId, startedAt });
      this.deps.journal.record({ ts: startedAt, campaignId, event: 'campaign_started' });
      const failures = await sheets.reserveContacts(contacts, campaignId);
      if (failures.length > 0) {
        const failedRows = new Set(failures.map((f) => f.update.sheetRow));
        for (const f of failures) {
          logger.warn('campaign', 'Could not reserve contact; it will not be emailed', {
            row: f.update.sheetRow,
            email: maskEmail(f.update.email),
            reason: f.reason,
          });
        }
        const reservedCount = contacts.length - failedRows.size;
        if (reservedCount === 0) {
          this.deps.repo.set('activeCampaign', null);
          throw new Error(`Could not reserve any contacts in the sheet: ${failures[0]?.reason ?? 'unknown error'}`);
        }
        for (const c of contacts) {
          if (failedRows.has(c.sheetRow)) {
            skipped.push({
              sheetRow: c.sheetRow,
              email: c.email,
              firstName: c.firstName,
              reason: 'already_sent',
              detail: 'Row changed before it could be reserved',
            });
          }
        }
        contacts = contacts.filter((c) => !failedRows.has(c.sheetRow));
      }
      for (const c of contacts) {
        this.deps.journal.record({
          ts: this.now().toISOString(),
          campaignId,
          event: 'reserved',
          sheetRow: c.sheetRow,
          maskedEmail: maskEmail(c.email),
        });
      }
    }

    logger.info('campaign', `${input.dryRun ? '[DRY RUN] ' : ''}Campaign started`, {
      campaignId,
      provider: mailer?.providerLabel ?? '',
      contacts: contacts.length,
      skipped: skipped.length,
      concurrency,
    });

    return { campaignId, input: safeInput, settings, contacts, skipped, sheets, mailer, startedAt };
  }

  private async run(prepared: PreparedCampaign): Promise<void> {
    const { logger, events } = this.deps;
    const { campaignId, input } = prepared;

    const results = new Map<number, ContactResult>();
    for (const s of prepared.skipped) {
      results.set(s.sheetRow, {
        sheetRow: s.sheetRow,
        name: s.firstName,
        email: s.email,
        status: 'skipped',
        resendId: '',
        error: s.detail,
      });
    }

    const ctx: RunContext = {
      prepared,
      results,
      cancelRequested: false,
      abortReason: '',
      writer: null,
      progress: {
        campaignId,
        dryRun: input.dryRun,
        processed: 0,
        total: prepared.contacts.length,
        sent: 0,
        failed: 0,
        skipped: prepared.skipped.length,
        needsReview: 0,
        currentEmail: '',
        cancelRequested: false,
      },
    };
    this.context = ctx;

    if (!input.dryRun && prepared.sheets) {
      ctx.writer = new StatusWriter(prepared.sheets, this.deps.flushIntervalMs ?? 3000, (item, reason) =>
        this.handleWriteFailure(ctx, item, reason),
      );
      ctx.writer.start();
    }

    events.progress({ ...ctx.progress });

    const limit = pLimit(input.concurrency);
    await Promise.all(prepared.contacts.map((contact) => limit(() => this.processContact(ctx, contact))));

    ctx.progress.currentEmail = '';
    if (ctx.writer) await ctx.writer.close();

    // Contacts reserved but never started go back to New: they were definitely not emailed.
    const notStarted = prepared.contacts.filter((c) => results.get(c.sheetRow)?.status === 'not_started');
    if (notStarted.length > 0 && !input.dryRun && prepared.sheets) {
      const failures = await prepared.sheets.applyRowUpdates(notStarted.map((c) => releaseUpdate(c, campaignId)));
      logger.info('campaign', `Returned ${notStarted.length - failures.length} unstarted contact(s) to New`);
      for (const f of failures) {
        logger.warn('campaign', 'Could not return unstarted contact to New; it remains in Processing for review', {
          row: f.update.sheetRow,
          reason: f.reason,
        });
      }
    }

    const summary = this.buildSummary(ctx);
    this.lastSummary = summary;

    if (!input.dryRun) {
      this.saveHistory(summary);
      this.deps.journal.record({ ts: summary.completedAt, campaignId, event: 'campaign_completed' });
      this.deps.repo.set('activeCampaign', null);
    }

    const label = input.dryRun ? '[DRY RUN] Campaign completed.' : 'Campaign completed.';
    logger.info('campaign', label, {
      campaignId,
      selected: summary.selected,
      sent: summary.sent,
      failed: summary.failed,
      skipped: summary.skipped,
      needsReview: summary.needsReview,
      notStarted: summary.notStarted,
      cancelled: summary.cancelled,
    });
    events.progress({ ...ctx.progress });
    events.complete(summary);
  }

  private async processContact(ctx: RunContext, contact: ContactRow): Promise<void> {
    const { logger, events } = this.deps;
    const { prepared } = ctx;
    const { campaignId, input } = prepared;
    const masked = maskEmail(contact.email);
    const name = [contact.firstName, contact.lastName].filter(Boolean).join(' ');
    const setResult = (status: ContactResult['status'], resendId = '', error = '') =>
      ctx.results.set(contact.sheetRow, { sheetRow: contact.sheetRow, name, email: contact.email, status, resendId, error });

    if (ctx.cancelRequested || ctx.abortReason) {
      setResult('not_started', '', ctx.abortReason || 'Campaign cancelled before this contact was started');
      return;
    }

    ctx.progress.currentEmail = contact.email;
    logger.info('campaign', 'Processing', { row: contact.sheetRow, email: masked });

    const rendered = renderEmail(input, buildVariables(contact, prepared.settings.firstNameFallback));

    if (input.dryRun || !prepared.mailer) {
      logger.info('campaign', `[DRY RUN] Would send to ${masked}`, { row: contact.sheetRow, subject: rendered.subject });
      setResult('dry_run');
      ctx.progress.processed++;
      events.progress({ ...ctx.progress });
      // Yield so progress events reach the renderer during large dry runs.
      await new Promise((resolve) => setImmediate(resolve));
      return;
    }

    const result = await prepared.mailer.sendEmail({
      fromName: input.fromName,
      fromEmail: input.fromEmail,
      to: contact.email,
      subject: rendered.subject,
      html: rendered.html,
      text: rendered.text,
      idempotencyKey: `${campaignId}:${contact.sheetRow}`,
    });
    const ts = this.now().toISOString();

    if (result.success) {
      this.deps.journal.record({
        ts,
        campaignId,
        event: 'send_result',
        sheetRow: contact.sheetRow,
        maskedEmail: masked,
        outcome: 'accepted',
        resendId: result.id,
      });
      logger.info('campaign', 'Email sent', { row: contact.sheetRow, email: masked, resendId: result.id });
      setResult('sent', result.id);
      ctx.progress.sent++;
      ctx.writer?.enqueue({ update: sentUpdate(contact, campaignId, result.id, ts), kind: 'sent', resendId: result.id });
    } else if (result.ambiguous) {
      this.deps.journal.record({
        ts,
        campaignId,
        event: 'send_result',
        sheetRow: contact.sheetRow,
        maskedEmail: masked,
        outcome: 'unknown',
        detail: result.error,
      });
      logger.warn('campaign', 'Delivery state unknown; contact left for manual review and will not be retried automatically', {
        row: contact.sheetRow,
        email: masked,
        reason: result.error,
      });
      setResult('needs_review', '', result.error);
      ctx.progress.needsReview++;
      ctx.writer?.enqueue({ update: reviewUpdate(contact, campaignId, result.error), kind: 'review', resendId: '' });
    } else if (result.fatal) {
      this.deps.journal.record({
        ts,
        campaignId,
        event: 'send_result',
        sheetRow: contact.sheetRow,
        maskedEmail: masked,
        outcome: 'rejected',
        detail: result.error,
      });
      if (!ctx.abortReason) {
        ctx.abortReason = `Campaign stopped: ${result.error}`;
        logger.error('campaign', `Stopping campaign: ${prepared.mailer.providerLabel} rejected the request for a reason that affects every email`, {
          campaignId,
          reason: result.error,
        });
      }
      // Rejected because of configuration, not the contact: it goes back to New with the rest.
      setResult('not_started', '', result.error);
    } else {
      this.deps.journal.record({
        ts,
        campaignId,
        event: 'send_result',
        sheetRow: contact.sheetRow,
        maskedEmail: masked,
        outcome: 'rejected',
        detail: result.error,
      });
      logger.error('campaign', 'Email failed', { row: contact.sheetRow, email: masked, reason: result.error });
      setResult('failed', '', result.error);
      ctx.progress.failed++;
      ctx.writer?.enqueue({ update: failedUpdate(contact, campaignId, result.error), kind: 'failed', resendId: '' });
    }

    ctx.progress.processed++;
    events.progress({ ...ctx.progress });
  }

  private handleWriteFailure(ctx: RunContext, item: QueuedWrite, reason: string): void {
    const { logger } = this.deps;
    const { campaignId } = ctx.prepared;
    const row = item.update.sheetRow;
    const timestamp = this.now().toISOString();
    this.deps.journal.record({
      ts: timestamp,
      campaignId,
      event: 'sheet_update_failed',
      sheetRow: row,
      maskedEmail: maskEmail(item.update.email),
      detail: reason,
    });

    if (item.kind === 'sent') {
      logger.warn('campaign', `Email provider accepted email but Google Sheet status update failed. Manual review required. ${EMAIL_SENT_SHEET_UPDATE_FAILED}`, {
        campaignId,
        row,
        email: maskEmail(item.update.email),
        resendId: item.resendId,
        timestamp,
        reason,
      });
      const review: ManualReviewItem = {
        id: `${campaignId}:${row}`,
        kind: EMAIL_SENT_SHEET_UPDATE_FAILED,
        campaignId,
        sheetRow: row,
        email: item.update.email,
        resendId: item.resendId,
        timestamp,
        error: reason,
      };
      const existing = this.deps.repo.get('manualReview').filter((r) => r.id !== review.id);
      this.deps.repo.set('manualReview', [review, ...existing].slice(0, 500));
      const result = ctx.results.get(row);
      if (result) result.error = `Email sent, but the sheet could not be updated: ${reason}`;
    } else {
      logger.warn('campaign', 'Google Sheet status update failed; row remains in Processing and needs review', {
        campaignId,
        row,
        intended: item.kind,
        reason,
      });
      const result = ctx.results.get(row);
      if (result) result.error = `${result.error} (sheet not updated: ${reason})`.trim();
    }
  }

  private buildSummary(ctx: RunContext): CampaignSummary {
    const { prepared, results } = ctx;
    const ordered = [...results.values()].sort((a, b) => a.sheetRow - b.sheetRow);
    const count = (status: ContactResult['status']) => ordered.filter((r) => r.status === status).length;
    return {
      campaignId: prepared.campaignId,
      dryRun: prepared.input.dryRun,
      startedAt: prepared.startedAt,
      completedAt: this.now().toISOString(),
      selected: prepared.contacts.length,
      sent: count('sent'),
      failed: count('failed'),
      skipped: count('skipped'),
      needsReview: count('needs_review'),
      notStarted: count('not_started'),
      cancelled: ctx.cancelRequested,
      abortReason: ctx.abortReason,
      subject: prepared.input.subject,
      results: ordered,
    };
  }

  private saveHistory(summary: CampaignSummary): void {
    const entry: CampaignHistoryEntry = {
      id: summary.campaignId,
      startedAt: summary.startedAt,
      completedAt: summary.completedAt,
      total: summary.selected,
      sent: summary.sent,
      failed: summary.failed,
      skipped: summary.skipped,
      needsReview: summary.needsReview,
      cancelled: summary.cancelled,
      subject: summary.subject,
      results: summary.results,
    };
    const history = [entry, ...this.deps.repo.get('campaignHistory').filter((h) => h.id !== entry.id)];
    this.deps.repo.set('campaignHistory', history.slice(0, CAMPAIGN_HISTORY_LIMIT));
  }
}
