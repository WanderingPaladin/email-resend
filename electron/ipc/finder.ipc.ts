import { FINDER_TAB_HEADERS, IPC, TRACKING_COLUMNS } from '../../shared/constants';
import { finderSaveInputSchema, finderSearchInputSchema } from '../../shared/schemas';
import type { FinderSaveResult, FinderSearchResult, FoundContact } from '../../shared/types';
import type { AppContext } from '../app-context';
import { findUntilTarget } from '../services/contact-finder.service';
import { broadcast, handle, type IpcDeps } from './handle';

const ON_PAGE_LABEL: Record<FoundContact['emailOnPage'], string> = { yes: 'Yes', no: 'No', unknown: 'Could not check' };

/** Header row plus one row per contact. Batch Flag stays empty until the operator reviews each contact. */
export function finderTabRows(contacts: readonly FoundContact[]): string[][] {
  const header = [...FINDER_TAB_HEADERS, ...TRACKING_COLUMNS];
  const blanks = TRACKING_COLUMNS.map(() => '');
  return [
    header,
    ...contacts.map((c) => [c.name, c.email, c.organization, c.role, c.sourceUrl, ON_PAGE_LABEL[c.emailOnPage], '', ...blanks]),
  ];
}

/** Drops contacts whose email is already in the spreadsheet, and repeats within the list (case-insensitive). */
export function removeKnownEmails(
  contacts: readonly FoundContact[],
  existing: ReadonlySet<string>,
): { unique: FoundContact[]; skippedExisting: number; skippedDuplicate: number } {
  const seen = new Set<string>();
  const unique: FoundContact[] = [];
  let skippedExisting = 0;
  let skippedDuplicate = 0;
  for (const contact of contacts) {
    const key = contact.email.trim().toLowerCase();
    if (existing.has(key)) skippedExisting++;
    else if (seen.has(key)) skippedDuplicate++;
    else {
      seen.add(key);
      unique.push(contact);
    }
  }
  return { unique, skippedExisting, skippedDuplicate };
}

export function registerFinderIpc(ctx: AppContext, deps: IpcDeps): void {
  handle(deps, IPC.openaiValidate, null, () => ctx.createFinder().validate());

  handle(deps, IPC.finderSearch, finderSearchInputSchema, async ({ query, maxResults }): Promise<FinderSearchResult> => {
    const finder = ctx.createFinder();

    // Leave out people who are already in any tab of the spreadsheet.
    let existing = new Set<string>();
    let checkedAgainstSheet = false;
    if (ctx.config.isGoogleConfigured()) {
      try {
        existing = await ctx.createSheets().readAllEmails();
        checkedAgainstSheet = true;
      } catch (error) {
        ctx.logger.warn('finder', 'Could not read the spreadsheet to skip existing contacts', {
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }

    const result = await findUntilTarget(finder, query, maxResults, existing, {
      logger: ctx.logger,
      onProgress: (progress) => broadcast(IPC.finderProgress, progress),
    });
    ctx.logger.info('finder', `Contact search finished: ${result.found} of ${maxResults} in ${result.rounds} round(s)`, result.dropped);
    return { ...result, checkedAgainstSheet };
  });

  handle(deps, IPC.finderSave, finderSaveInputSchema, async ({ tabName, contacts }): Promise<FinderSaveResult> => {
    const sheets = ctx.createSheets();
    // Checked again at save time: the sheet may have changed since the search (for example an earlier save).
    const { unique, skippedExisting, skippedDuplicate } = removeKnownEmails(contacts, await sheets.readAllEmails());
    if (unique.length === 0) {
      throw new Error(
        `Nothing was saved: all ${contacts.length} selected contact(s) are already in the spreadsheet${skippedDuplicate ? ' or repeated' : ''}.`,
      );
    }
    const saved = await sheets.createWorksheet(tabName, finderTabRows(unique));
    ctx.logger.info('finder', `Saved ${saved.rows} contact(s) to a new tab`, { skippedExisting, skippedDuplicate });
    return { ...saved, skippedExisting, skippedDuplicate };
  });
}
