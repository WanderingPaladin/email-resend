import type { LogCategory, LogLevel } from '../shared/types';
import { createMemorySettingsRepository } from '../electron/repositories/settings.repository';
import { GoogleSheetsService, type CellWrite, type SheetsGateway } from '../electron/services/google-sheets.service';
import { formatLogMessage } from '../electron/services/log-format';
import type { ResendClientLike, ResendErrorLike } from '../electron/services/resend.service';
import { ResendService } from '../electron/services/resend.service';
import type { AppLogger } from '../electron/types/logger';

/** Logger that keeps formatted lines in memory, using the same redaction as the real logger. */
export class MemoryLogger implements AppLogger {
  lines: { level: LogLevel; category: LogCategory; message: string }[] = [];
  private write(level: LogLevel, category: LogCategory, message: string, fields?: Record<string, unknown>) {
    this.lines.push({ level, category, message: formatLogMessage(message, fields) });
  }
  debug = (c: LogCategory, m: string, f?: Record<string, unknown>) => this.write('debug', c, m, f);
  info = (c: LogCategory, m: string, f?: Record<string, unknown>) => this.write('info', c, m, f);
  warn = (c: LogCategory, m: string, f?: Record<string, unknown>) => this.write('warn', c, m, f);
  error = (c: LogCategory, m: string, f?: Record<string, unknown>) => this.write('error', c, m, f);
  text(): string {
    return this.lines.map((l) => `${l.level} ${l.category} ${l.message}`).join('\n');
  }
}

function letterToIndex(letters: string): number {
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/**
 * In-memory Google Sheet that understands the A1 ranges the service uses:
 * `'Emails'`, `'Emails'!1:1`, `'Emails'!C12`.
 */
export class FakeSheetsGateway implements SheetsGateway {
  reads = 0;
  writeBatches: CellWrite[][] = [];
  /** Throw from the next N batchWrite calls. */
  failWrites = 0;
  failWriteError: unknown = Object.assign(new Error('Service unavailable'), { response: { status: 403 } });
  /** Grid width, like Google's columnCount. Writes beyond it fail as Google's do. */
  columnCount = 26;
  gridResizes = 0;
  /** Called before each read so tests can mutate the sheet mid-campaign. */
  beforeRead?: () => void;

  constructor(
    public rows: string[][],
    public title = 'Prospects',
    public worksheetName = 'Emails',
  ) {}

  private parse(range: string): { sheet: string; cell?: { col: number; row: number }; headerOnly?: boolean } {
    const match = /^'((?:[^']|'')*)'(?:!(.*))?$/.exec(range);
    if (!match) throw new Error(`Bad range ${range}`);
    const sheet = (match[1] ?? '').replace(/''/g, "'");
    const ref = match[2];
    if (!ref) return { sheet };
    if (ref === '1:1') return { sheet, headerOnly: true };
    const cell = /^([A-Z]+)(\d+)$/.exec(ref);
    if (!cell) throw new Error(`Bad cell ${ref}`);
    return { sheet, cell: { col: letterToIndex(cell[1] ?? 'A'), row: Number(cell[2]) } };
  }

  private checkSheet(sheet: string) {
    if (sheet !== this.worksheetName) {
      throw Object.assign(new Error(`Unable to parse range: ${sheet}`), { response: { status: 400 } });
    }
  }

  async getSpreadsheet() {
    return { title: this.title, sheets: [{ title: this.worksheetName, rowCount: 1000 }] };
  }

  async ensureColumnCount(_id: string, worksheetName: string, minColumns: number): Promise<void> {
    this.checkSheet(worksheetName);
    if (this.columnCount < minColumns) {
      this.columnCount = minColumns;
      this.gridResizes++;
    }
  }

  async getValues(_id: string, range: string): Promise<string[][]> {
    this.beforeRead?.();
    this.reads++;
    const { sheet, headerOnly } = this.parse(range);
    this.checkSheet(sheet);
    const copy = this.rows.map((r) => [...r]);
    return headerOnly ? copy.slice(0, 1) : copy;
  }

  async batchWrite(_id: string, writes: CellWrite[]): Promise<void> {
    if (this.failWrites > 0) {
      this.failWrites--;
      throw this.failWriteError;
    }
    this.writeBatches.push(writes);
    for (const w of writes) {
      const { sheet, cell } = this.parse(w.range);
      this.checkSheet(sheet);
      if (!cell) throw new Error('Only single-cell writes are expected');
      if (cell.col >= this.columnCount) {
        throw Object.assign(new Error(`Range exceeds grid limits. Max columns: ${this.columnCount}`), {
          response: { status: 400 },
        });
      }
      const rowIndex = cell.row - 1;
      while (this.rows.length <= rowIndex) this.rows.push([]);
      const row = this.rows[rowIndex] ?? [];
      while (row.length <= cell.col) row.push('');
      row[cell.col] = w.value;
      this.rows[rowIndex] = row;
    }
  }

  /** Returns a row as a header → value object. */
  rowObject(sheetRow: number): Record<string, string> {
    const headers = (this.rows[0] ?? []).map((h) => h.trim().toLowerCase());
    const row = this.rows[sheetRow - 1] ?? [];
    return Object.fromEntries(headers.map((h, i) => [h, row[i] ?? '']));
  }
}

/** Contact columns, a column the app must never touch (notes), and the tracking columns. */
export const FULL_HEADERS = [
  'first_name',
  'last_name',
  'email',
  'tag',
  'notes',
  'send_status',
  'campaign_id',
  'sent_at',
  'message_id',
  'last_error',
];

/** Builds sheet rows from partial objects using FULL_HEADERS. */
export function sheetRows(contacts: Record<string, string>[], headers = FULL_HEADERS): string[][] {
  return [headers, ...contacts.map((c) => headers.map((h) => c[h] ?? ''))];
}

export type ScriptedResponse =
  | { id: string }
  | { error: ResendErrorLike }
  | { throw: Error };

/** Resend client double. Responses can be scripted per recipient; default is success. */
export class FakeResendClient implements ResendClientLike {
  calls: { to: string; subject: string; html: string; text: string; from: string; idempotencyKey?: string }[] = [];
  scripts = new Map<string, ScriptedResponse[]>();
  private counter = 0;
  domainsResponse: Awaited<ReturnType<ResendClientLike['domains']['list']>> = {
    data: { data: [{ name: 'example.com', status: 'verified' }] },
    error: null,
  };

  script(email: string, ...responses: ScriptedResponse[]) {
    this.scripts.set(email.toLowerCase(), responses);
  }

  emails = {
    send: async (
      payload: { from: string; to: string; subject: string; html: string; text: string },
      options?: { idempotencyKey?: string },
    ) => {
      this.calls.push({ ...payload, idempotencyKey: options?.idempotencyKey });
      const queue = this.scripts.get(payload.to.toLowerCase());
      const next = queue && queue.length > 0 ? queue.shift() : undefined;
      if (next && 'throw' in next) throw next.throw;
      if (next && 'error' in next) return { data: null, error: next.error };
      const id = next && 'id' in next ? next.id : `re-${++this.counter}`;
      return { data: { id }, error: null };
    },
  };

  domains = {
    list: async () => this.domainsResponse,
  };
}

export const noSleep = async () => undefined;

export function createHarness(rows: string[][]) {
  const logger = new MemoryLogger();
  const gateway = new FakeSheetsGateway(rows);
  const client = new FakeResendClient();
  const repo = createMemorySettingsRepository();
  const target = { spreadsheetId: 'sheet-id', worksheetName: 'Emails', serviceAccountEmail: 'svc@proj.iam.gserviceaccount.com' };
  const sheets = new GoogleSheetsService(gateway, target, logger, { sleepFn: noSleep });
  const mailer = new ResendService(client, logger, { sendsPerSecond: 10, sleepFn: noSleep, now: () => 0 });
  return { logger, gateway, client, repo, sheets, mailer };
}

/** Records requests and answers them from a queue of scripted responses (default: 200 {}). */
export class FakeFetch {
  calls: { url: string; method: string; headers: Record<string, string>; body: unknown }[] = [];
  responses: (Response | Error)[] = [];

  reply(status: number, body: unknown) {
    this.responses.push(new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }));
    return this;
  }

  fail(error: Error) {
    this.responses.push(error);
    return this;
  }

  fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    this.calls.push({
      url: String(input),
      method: init?.method ?? 'GET',
      headers,
      body: typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined,
    });
    const next = this.responses.shift() ?? new Response('{}', { status: 200 });
    if (next instanceof Error) throw next;
    return next;
  }) as typeof fetch;
}
