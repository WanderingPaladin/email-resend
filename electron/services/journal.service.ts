import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Append-only local record of what happened to each contact, written the moment Resend
 * answers and before the sheet is updated. If the app crashes or the sheet update fails,
 * the recovery screen uses this to tell "Resend accepted it" apart from "never sent".
 * Emails are stored masked; rows are matched by campaign ID + sheet row.
 */

export type JournalEvent = 'campaign_started' | 'reserved' | 'send_result' | 'sheet_update_failed' | 'campaign_completed';

export interface JournalEntry {
  ts: string;
  campaignId: string;
  event: JournalEvent;
  sheetRow?: number;
  maskedEmail?: string;
  outcome?: 'accepted' | 'rejected' | 'unknown';
  resendId?: string;
  detail?: string;
}

export interface CampaignJournal {
  record(entry: JournalEntry): void;
  read(campaignId: string): JournalEntry[];
}

const SAFE_ID = /^[0-9a-f-]{36}$/i;

export function createFileJournal(directory: string, keep = 100): CampaignJournal {
  mkdirSync(directory, { recursive: true });
  prune(directory, keep);
  return {
    record(entry) {
      if (!SAFE_ID.test(entry.campaignId)) return;
      appendFileSync(join(directory, `${entry.campaignId}.jsonl`), `${JSON.stringify(entry)}\n`, 'utf8');
    },
    read(campaignId) {
      if (!SAFE_ID.test(campaignId)) return [];
      const file = join(directory, `${campaignId}.jsonl`);
      if (!existsSync(file)) return [];
      return readFileSync(file, 'utf8')
        .split('\n')
        .filter(Boolean)
        .flatMap((line) => {
          try {
            return [JSON.parse(line) as JournalEntry];
          } catch {
            return [];
          }
        });
    },
  };
}

export function createMemoryJournal(): CampaignJournal & { entries: JournalEntry[] } {
  const entries: JournalEntry[] = [];
  return {
    entries,
    record: (entry) => entries.push(entry),
    read: (campaignId) => entries.filter((e) => e.campaignId === campaignId),
  };
}

/** Latest send outcome for a row in a campaign, if any. */
export function lastSendOutcome(entries: JournalEntry[], sheetRow: number): JournalEntry | undefined {
  return entries.filter((e) => e.event === 'send_result' && e.sheetRow === sheetRow).at(-1);
}

function prune(directory: string, keep: number): void {
  try {
    const files = readdirSync(directory)
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => ({ f, t: statSync(join(directory, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t);
    for (const { f } of files.slice(keep)) unlinkSync(join(directory, f));
  } catch {
    // Pruning is best effort.
  }
}
