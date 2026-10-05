import { randomUUID } from 'node:crypto';
import type { SavedFinderSearch, SavedFinderSearchSummary } from '../../shared/types';
import type { FinderUsageRecord } from '../../shared/usage';
import type { SettingsRepository } from '../repositories/settings.repository';

/** Runs kept on this computer; the oldest are dropped beyond this. */
export const MAX_USAGE_RECORDS = 5000;

/** Saves the estimated OpenAI cost of each Find Contacts run on this computer. */
export class FinderUsageLog {
  constructor(
    private readonly repo: SettingsRepository,
    private readonly newId: () => string = randomUUID,
  ) {}

  add(record: Omit<FinderUsageRecord, 'id'>, id: string = this.newId()): FinderUsageRecord {
    const saved = { ...record, id };
    const all = [...(this.repo.get('finderUsage') ?? []), saved];
    this.repo.set('finderUsage', all.slice(-MAX_USAGE_RECORDS));
    return saved;
  }

  /** Every saved run, newest first. */
  list(): FinderUsageRecord[] {
    return [...(this.repo.get('finderUsage') ?? [])].reverse();
  }

  clear(): void {
    this.repo.set('finderUsage', []);
  }
}

/** Finished searches kept for reopening; the oldest are dropped beyond this. */
export const MAX_SAVED_SEARCHES = 30;

/** Keeps the results of recent searches on this computer so they can be saved to the sheet later. */
export class FinderResultStore {
  constructor(private readonly repo: SettingsRepository) {}

  add(search: SavedFinderSearch): void {
    const others = (this.repo.get('finderResults') ?? []).filter((s) => s.id !== search.id);
    this.repo.set('finderResults', [...others, search].slice(-MAX_SAVED_SEARCHES));
  }

  /** Recent searches that found someone, newest first. */
  list(): SavedFinderSearchSummary[] {
    return [...(this.repo.get('finderResults') ?? [])].reverse().map(({ id, at, query, result }) => ({
      id,
      at,
      query,
      target: result.target,
      found: result.contacts.length,
      stopped: result.stopped,
      estimatedCost: result.cost.estimatedCost,
    }));
  }

  get(id: string): SavedFinderSearch | null {
    return (this.repo.get('finderResults') ?? []).find((s) => s.id === id) ?? null;
  }
}
