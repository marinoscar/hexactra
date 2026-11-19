// The capability matrix (E39.4, #602): for each method of the capability interfaces, whether each kind of account can do it.
// ONE table in code that three things read:
//   * the Microsoft adapter, which answers NOT_SUPPORTED for a method the matrix marks `unsupported` for the account's kind;
//   * `GET /api/connections/providers`, so the Connect dialog and the task UI never offer an unsupported choice;
//   * the docs: the table in docs/connections.md is generated from this and a test fails when they differ
//     (`UPDATE_CAPABILITY_MATRIX_DOC=1 npx jest capability-matrix` rewrites it; review the diff).
// The Google column follows the decision record (docs/decisions/connections-auth.md): with the narrow `drive.file` permission
// the app reaches only the files it created or the owner picked. PROVISIONAL like the record: nothing here was tried on a real account.
import { CAPABILITY_METHODS, type CapabilityService, type Effect } from './capabilities';
import type { Capability } from './connections.constants';

export const MATRIX_COLUMNS = ['google', 'microsoft_work', 'microsoft_personal'] as const;
export type MatrixColumn = (typeof MATRIX_COLUMNS)[number];

export const MATRIX_COLUMN_LABEL: Record<MatrixColumn, string> = {
  google: 'Google',
  microsoft_work: 'Microsoft work or school',
  microsoft_personal: 'Microsoft personal',
};

export type Support = 'supported' | 'limited' | 'unsupported';
export interface MatrixCell {
  support: Support;
  /** Plain words: how it is limited, or why it is not supported. */
  note?: string;
}

type MethodKeyOf<S extends CapabilityService> = `${S}.${Extract<keyof (typeof CAPABILITY_METHODS)[S], string>}`;
export type MatrixMethod = MethodKeyOf<'mail'> | MethodKeyOf<'calendar'> | MethodKeyOf<'documents'>;

const ok: MatrixCell = { support: 'supported' };
const limited = (note: string): MatrixCell => ({ support: 'limited', note });
const no = (note: string): MatrixCell => ({ support: 'unsupported', note });
const row = (google: MatrixCell, work: MatrixCell, personal: MatrixCell = work): Record<MatrixColumn, MatrixCell> => ({ google, microsoft_work: work, microsoft_personal: personal });

const PICKED = 'Only files the app created or you picked (the narrow Drive permission).';
const NOTIFY = 'Changing an event that has attendees emails them at Microsoft, which cannot be turned off: it is refused unless notifying is allowed.';
const WORKBOOK_PERSONAL = 'Excel workbook calls are not confirmed to work on personal OneDrive; refused until an experiment shows they do.';

export const CAPABILITY_MATRIX: Record<MatrixMethod, Record<MatrixColumn, MatrixCell>> = {
  'mail.search': row(ok, limited('Free text goes through Microsoft search; the other filters are applied to each page, so a page can be short: follow the next page.')),
  'mail.get': row(ok, ok),
  'mail.getAttachment': row(ok, limited('File attachments only; an attached message or a link is not downloadable.')),
  'mail.createDraft': row(ok, ok),
  'mail.send': row(ok, limited('With send-only permission there is no message id in the answer and attachments must be under 3 MB; with the modify switch on, larger ones are sent through a draft.')),
  'mail.modify': row(ok, limited('Microsoft has folders and categories, not labels: archive moves to Archive, labels map to categories (`category:<name>`) and a folder (`folder:<id>`) moves the message.')),
  'mail.listLabels': row(ok, limited('Returns folders and categories, with the kind.')),
  'calendar.listCalendars': row(ok, ok),
  'calendar.listEvents': row(ok, limited('Text matches the event title.')),
  'calendar.freeBusy': row(ok, ok, limited('Personal accounts have no free/busy service: computed from the events of the calendar.')),
  'calendar.createEvent': row(ok, limited(`${NOTIFY} A video conference is a Teams meeting.`), limited(`${NOTIFY} No video conference.`)),
  'calendar.updateEvent': row(ok, limited(NOTIFY)),
  'calendar.deleteEvent': row(ok, limited(NOTIFY)),
  'documents.searchFiles': row(limited(PICKED), ok),
  'documents.getFile': row(limited(PICKED), ok),
  'documents.registerPickedFile': row(ok, ok),
  'documents.readDocument': row(limited(PICKED), limited('Word (.docx) and plain-text files; a PDF or an older .doc is not read.')),
  'documents.createDocument': row(ok, limited('Creates a plain Word (.docx) file of paragraphs.')),
  'documents.appendToDocument': row(limited(PICKED), limited('Rewrites the whole .docx file as a new version; a concurrent edit is detected and refused (conflict).')),
  'documents.readSheet': row(limited(PICKED), ok, no(WORKBOOK_PERSONAL)),
  'documents.appendRows': row(limited(PICKED), limited('Rows go into the first table of the sheet, or below the used range when there is none. A failure that leaves it unknown is reported, not retried.'), no(WORKBOOK_PERSONAL)),
  'documents.createSpreadsheet': row(ok, limited('Creates an Excel (.xlsx) file with the header row as text.')),
  'documents.uploadFile': row(ok, ok),
  'documents.createFolder': row(ok, ok),
};

export interface MatrixRow {
  method: MatrixMethod;
  service: CapabilityService;
  effect: Effect;
  capability: Capability;
  support: Partial<Record<MatrixColumn, MatrixCell>>;
}

/** The columns that exist for a provider's accounts. */
export const COLUMNS_OF_PROVIDER: Record<'google' | 'microsoft', readonly MatrixColumn[]> = {
  google: ['google'],
  microsoft: ['microsoft_work', 'microsoft_personal'],
};

/** Every method with its tag and the support of the given columns. Order: the order of the interfaces. */
export function matrixRows(columns: readonly MatrixColumn[] = MATRIX_COLUMNS): MatrixRow[] {
  const rows: MatrixRow[] = [];
  for (const [service, methods] of Object.entries(CAPABILITY_METHODS) as [CapabilityService, Record<string, { effect: Effect; capability: Capability }>][]) {
    for (const [name, spec] of Object.entries(methods)) {
      const method = `${service}.${name}` as MatrixMethod;
      const cells = CAPABILITY_MATRIX[method];
      rows.push({ method, service, effect: spec.effect, capability: spec.capability, support: Object.fromEntries(columns.map((c) => [c, cells[c]])) as MatrixRow['support'] });
    }
  }
  return rows;
}

export const matrixCell = (method: MatrixMethod, column: MatrixColumn): MatrixCell => CAPABILITY_MATRIX[method][column];

const SYMBOL: Record<Support, string> = { supported: 'Yes', limited: 'Limited', unsupported: 'No' };

/** The Markdown table of docs/connections.md. Generated, never hand-edited. */
export function matrixMarkdown(): string {
  const head = `| Method | Needs | ${MATRIX_COLUMNS.map((c) => MATRIX_COLUMN_LABEL[c]).join(' | ')} |`;
  const sep = `|---|---|${MATRIX_COLUMNS.map(() => '---').join('|')}|`;
  const body = matrixRows().map((r) => `| \`${r.method}\` | \`${r.capability}\` | ${MATRIX_COLUMNS.map((c) => { const cell = r.support[c]!; return cell.note ? `${SYMBOL[cell.support]}: ${cell.note}` : SYMBOL[cell.support]; }).join(' | ')} |`);
  return [head, sep, ...body].join('\n');
}
