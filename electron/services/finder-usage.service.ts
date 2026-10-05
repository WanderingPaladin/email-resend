import { randomUUID } from 'node:crypto';
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

  add(record: Omit<FinderUsageRecord, 'id'>): FinderUsageRecord {
    const saved = { ...record, id: this.newId() };
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
