import { IPC } from '../../shared/constants';
import { finderSaveInputSchema, finderSearchInputSchema } from '../../shared/schemas';
import type { FinderSaveResult, FinderSearchResult, FoundContact } from '../../shared/types';
import type { AppContext } from '../app-context';
import { findUntilTarget } from '../services/contact-finder.service';
import { finderTabRows, planAppend } from '../services/finder-sheet';
import { broadcast, handle, type IpcDeps } from './handle';

/** Layout for a blank existing tab: header in row 1, contacts below. */
function blankTabPlan(contacts: readonly FoundContact[]) {
  const [header = [], ...rows] = finderTabRows(contacts);
  return {
    addedColumns: header.map((label, index) => ({ index, label })),
    rows,
    firstRow: 2,
    width: header.length,
  };
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

  handle(deps, IPC.finderTabs, null, () => ctx.createSheets().listWorksheets());

  handle(deps, IPC.finderSave, finderSaveInputSchema, async ({ mode, tabName, contacts }): Promise<FinderSaveResult> => {
    const sheets = ctx.createSheets();
    if (mode === 'existing' && tabName === ctx.config.getSettings().worksheetName && ctx.campaign.isCampaignRunning()) {
      throw new Error(`A campaign is running on "${tabName}". Wait for it to finish before adding rows to that tab.`);
    }
    // Checked again at save time: the sheet may have changed since the search (for example an earlier save).
    const { unique, skippedExisting, skippedDuplicate } = removeKnownEmails(contacts, await sheets.readAllEmails());
    if (unique.length === 0) {
      throw new Error(
        `Nothing was saved: all ${contacts.length} selected contact(s) are already in the spreadsheet${skippedDuplicate ? ' or repeated' : ''}.`,
      );
    }
    let saved: { tabName: string; rows: number; addedColumns: string[] };
    if (mode === 'new') {
      saved = { ...(await sheets.createWorksheet(tabName, finderTabRows(unique))), addedColumns: [] };
    } else {
      const values = await sheets.readWorksheet(tabName);
      saved =
        values.length === 0
          ? // A blank tab gets the same layout as a new one.
            { ...(await sheets.appendToWorksheet(tabName, blankTabPlan(unique))) }
          : await sheets.appendToWorksheet(tabName, planAppend(values, unique));
    }
    ctx.logger.info('finder', `Saved ${saved.rows} contact(s) (${mode} tab)`, { skippedExisting, skippedDuplicate });
    return { mode, ...saved, skippedExisting, skippedDuplicate };
  });
}
