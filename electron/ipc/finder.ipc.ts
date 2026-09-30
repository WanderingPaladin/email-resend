import { FINDER_TAB_HEADERS, IPC, TRACKING_COLUMNS } from '../../shared/constants';
import { finderSaveInputSchema, finderSearchInputSchema } from '../../shared/schemas';
import type { FinderSearchResult, FoundContact } from '../../shared/types';
import type { AppContext } from '../app-context';
import { cleanFoundContacts } from '../services/contact-finder.service';
import { handle, type IpcDeps } from './handle';

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

export function registerFinderIpc(ctx: AppContext, deps: IpcDeps): void {
  handle(deps, IPC.openaiValidate, null, () => ctx.createFinder().validate());

  handle(deps, IPC.finderSearch, finderSearchInputSchema, async ({ query, maxResults }): Promise<FinderSearchResult> => {
    const finder = ctx.createFinder();
    const raw = await finder.search(query, maxResults);

    // Leave out people who are already in the Emails tab.
    let existing = new Set<string>();
    let checkedAgainstSheet = false;
    if (ctx.config.isGoogleConfigured()) {
      try {
        const contacts = await ctx.createSheets().readContacts();
        existing = new Set(contacts.map((c) => c.email.trim().toLowerCase()).filter(Boolean));
        checkedAgainstSheet = true;
      } catch (error) {
        ctx.logger.warn('finder', 'Could not read the Emails tab to skip existing contacts', {
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }

    const { contacts, dropped } = cleanFoundContacts(raw, existing, maxResults);
    const checked = await finder.checkOnPage(contacts);
    ctx.logger.info('finder', `Contact search finished with ${checked.length} contact(s)`, dropped);
    return { contacts: checked, dropped, checkedAgainstSheet };
  });

  handle(deps, IPC.finderSave, finderSaveInputSchema, ({ tabName, contacts }) =>
    ctx.createSheets().createWorksheet(tabName, finderTabRows(contacts)),
  );
}
