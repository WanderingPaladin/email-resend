import { SEND_STATUS, TAG } from '../../shared/constants';
import type { RecoveryApplyInput } from '../../shared/schemas';
import type { ContactRow, ManualReviewItem, RecoveryApplyResult, RecoveryState, StaleContact } from '../../shared/types';
import type { SettingsRepository } from '../repositories/settings.repository';
import type { AppLogger } from '../types/logger';
import type { GoogleSheetsService, RowUpdate } from './google-sheets.service';
import { lastSendOutcome, type CampaignJournal, type JournalEntry } from './journal.service';
import { maskEmail } from './log-format';
import { findStaleProcessing } from './sheet-parser';

export interface RecoveryServiceDeps {
  logger: AppLogger;
  repo: SettingsRepository;
  journal: CampaignJournal;
  isGoogleConfigured(): boolean;
  createSheets(): GoogleSheetsService;
  isCampaignRunning(): boolean;
  now?: () => Date;
}

/**
 * Finds contacts left in Processing (crash, ambiguous send, failed sheet update) and applies
 * operator decisions. Nothing here ever sends email: resolving a row only edits the sheet.
 */
export class RecoveryService {
  constructor(private readonly deps: RecoveryServiceDeps) {}

  /**
   * Finds the campaign that reserved a Processing row: its campaign_id cell, or else (older
   * rows, or a cleared cell) the most recent local journal that reserved this row for this email.
   */
  private journalFor(row: Pick<ContactRow, 'sheetRow' | 'email' | 'campaignId'>): { campaignId: string; entry?: JournalEntry; review?: ManualReviewItem } {
    const email = row.email.trim().toLowerCase();
    const review = this.deps.repo
      .get('manualReview')
      .find((r) => r.sheetRow === row.sheetRow && r.email.trim().toLowerCase() === email);
    const marker = this.deps.repo.get('activeCampaign');
    if (row.campaignId) {
      const own = this.deps.journal.read(row.campaignId);
      const ownReview = review && review.campaignId === row.campaignId ? review : undefined;
      return { campaignId: row.campaignId, entry: lastSendOutcome(own, row.sheetRow), review: ownReview };
    }
    const candidates = [marker?.campaignId, review?.campaignId, ...this.deps.repo.get('campaignHistory').map((h) => h.id)].filter(
      (id): id is string => Boolean(id),
    );
    const masked = maskEmail(row.email);
    for (const campaignId of new Set(candidates)) {
      const entries = this.deps.journal.read(campaignId);
      const reserved = entries.some((e) => e.event === 'reserved' && e.sheetRow === row.sheetRow && e.maskedEmail === masked);
      if (reserved || campaignId === review?.campaignId) {
        return { campaignId, entry: lastSendOutcome(entries, row.sheetRow), review };
      }
    }
    return { campaignId: review?.campaignId ?? '', review };
  }

  async scan(): Promise<RecoveryState> {
    const { repo } = this.deps;
    const marker = repo.get('activeCampaign');
    const state: RecoveryState = {
      staleContacts: [],
      manualReview: repo.get('manualReview'),
      interruptedCampaignId: marker && !this.deps.isCampaignRunning() ? marker.campaignId : '',
      googleError: '',
    };
    if (this.deps.isCampaignRunning()) return state;
    if (!this.deps.isGoogleConfigured()) {
      state.googleError = 'Google Sheets is not configured.';
      return state;
    }
    try {
      const stale = await this.deps.createSheets().findStaleProcessingRows();
      state.staleContacts = stale.map((row): StaleContact => {
        const { campaignId, entry, review } = this.journalFor(row);
        return {
          sheetRow: row.sheetRow,
          email: row.email,
          firstName: row.firstName,
          tag: row.tag,
          sendStatus: row.sendStatus,
          lastError: row.lastError,
          campaignId,
          journalResendId: entry?.resendId ?? review?.resendId ?? '',
          journalOutcome: entry?.outcome ?? (review ? 'accepted' : 'none'),
        };
      });
      if (state.staleContacts.length > 0) {
        this.deps.logger.warn(
          'campaign',
          `${state.staleContacts.length} contact(s) from a previous campaign remain in Processing state. Review them before retrying.`,
        );
      } else if (marker) {
        // The interrupted campaign left nothing behind in the sheet.
        repo.set('activeCampaign', null);
        state.interruptedCampaignId = '';
      }
    } catch (error) {
      state.googleError = error instanceof Error ? error.message : String(error);
    }
    return state;
  }

  async apply(input: RecoveryApplyInput): Promise<RecoveryApplyResult> {
    if (this.deps.isCampaignRunning()) throw new Error('Wait for the running campaign to finish before resolving rows.');
    const sheets = this.deps.createSheets();
    const current = await sheets.findStaleProcessingRows();
    const skipped: RecoveryApplyResult['skipped'] = [];
    const updates: RowUpdate[] = [];

    for (const requested of input.rows) {
      const row = current.find(
        (c) => c.sheetRow === requested.sheetRow && c.email.trim().toLowerCase() === requested.email.trim().toLowerCase(),
      );
      if (!row) {
        skipped.push({ sheetRow: requested.sheetRow, reason: 'Row is no longer in Processing or its email changed' });
        continue;
      }
      const { entry, review } = this.journalFor(row);
      const now = (this.deps.now ?? (() => new Date()))().toISOString();
      const acceptedId = entry?.outcome === 'accepted' ? (entry.resendId ?? '') : (review?.resendId ?? '');

      if (input.action === 'mark_new' && acceptedId) {
        skipped.push({
          sheetRow: row.sheetRow,
          reason: `The email provider already accepted this email (ID ${acceptedId}); marking it New would send it again. Mark it Sent instead.`,
        });
        continue;
      }

      const base = { sheetRow: row.sheetRow, email: row.email, expectedState: 'stale' as const };
      if (input.action === 'mark_new') {
        updates.push({ ...base, fields: { tag: TAG.New, send_status: '', campaign_id: '', last_error: '' } });
      } else if (input.action === 'mark_failed') {
        updates.push({
          ...base,
          fields: { tag: TAG.Failed, send_status: SEND_STATUS.Failed, last_error: 'Marked Failed during manual review' },
        });
      } else {
        updates.push({
          ...base,
          fields: {
            tag: TAG.Sent,
            send_status: SEND_STATUS.Sent,
            sent_at: row.sentAt || entry?.ts || now,
            message_id: row.messageId || acceptedId,
            last_error: '',
          },
        });
      }
    }

    const failures = await sheets.applyRowUpdates(updates);
    for (const f of failures) skipped.push({ sheetRow: f.update.sheetRow, reason: f.reason });
    const failedRows = new Set(failures.map((f) => f.update.sheetRow));
    const applied = updates.filter((u) => !failedRows.has(u.sheetRow));

    for (const u of applied) {
      this.deps.logger.info('campaign', 'Manual review resolved', {
        row: u.sheetRow,
        email: maskEmail(u.email),
        action: input.action,
      });
    }
    // Rows resolved in the sheet no longer need their manual-review record.
    if (applied.length > 0) {
      const resolved = new Set(applied.map((u) => `${u.sheetRow}:${u.email.trim().toLowerCase()}`));
      const remaining = this.deps.repo
        .get('manualReview')
        .filter((r) => !resolved.has(`${r.sheetRow}:${r.email.trim().toLowerCase()}`));
      this.deps.repo.set('manualReview', remaining);
    }
    return { updated: applied.length, skipped };
  }

  dismissReview(id: string): void {
    this.deps.repo.set(
      'manualReview',
      this.deps.repo.get('manualReview').filter((r) => r.id !== id),
    );
    this.deps.logger.info('campaign', 'Manual review item dismissed', { id });
  }
}
