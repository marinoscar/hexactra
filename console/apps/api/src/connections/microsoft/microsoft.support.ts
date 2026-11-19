// Small shared helpers of the Microsoft capability objects (E39.4, #602): the matrix check, time conversion, file names and A1 ranges.
import { CapabilityError, type CapabilityContext } from '../capabilities';
import { matrixCell, type MatrixMethod } from '../capability-matrix';
import { microsoftAccountKind } from './microsoft.constants';
import { columnName, columnNumber } from './ooxml';

/** NOT_SUPPORTED for a method the matrix marks unsupported for this kind of account: the matrix is the one source of truth. */
export function assertSupported(ctx: CapabilityContext, method: MatrixMethod): void {
  const column = microsoftAccountKind(ctx.connection.accountId) === 'personal' ? 'microsoft_personal' : 'microsoft_work';
  if (matrixCell(method, column).support === 'unsupported') throw new CapabilityError('NOT_SUPPORTED', { reason: 'ACCOUNT_TYPE' });
}

export const isPersonal = (ctx: CapabilityContext): boolean => microsoftAccountKind(ctx.connection.accountId) === 'personal';

/** A path segment: Graph ids and names are percent-encoded (and `'` too, which `encodeURIComponent` leaves alone). */
export const seg = (v: string): string => encodeURIComponent(v).replace(/'/g, '%27');

/** OData string literal contents: a quote is doubled. */
export const odataString = (v: string): string => v.replace(/'/g, "''");

/** The instant as Graph wants it in a filter: UTC, no milliseconds. */
export const isoZ = (instant: string): string => new Date(instant).toISOString().replace(/\.\d{3}Z$/, 'Z');

/** `2026-03-02T14:30:00.0000000` style wall time of an instant in an IANA zone (UTC when none), the form of Graph's `dateTime`. */
export function wallTime(instant: string, timeZone: string | undefined): string {
  const d = new Date(instant);
  if (!timeZone || timeZone === 'UTC') return d.toISOString().slice(0, 19) + '.0000000';
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat('en-CA', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(d);
  } catch {
    throw new CapabilityError('INVALID_INPUT', { issues: ['timeZone'] });
  }
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '00';
  return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}:${get('second')}.0000000`;
}

/** Graph answers `dateTime` without an offset in the zone that was asked for (UTC here): back to an instant with `Z`. */
export function instantOf(dateTime: unknown): string | null {
  if (typeof dateTime !== 'string') return null;
  const t = Date.parse(/[zZ]|[+-]\d{2}:?\d{2}$/.test(dateTime) ? dateTime : `${dateTime}Z`);
  return Number.isFinite(t) ? new Date(t).toISOString().replace(/\.\d{3}Z$/, 'Z') : null;
}

const FORBIDDEN_NAME = /["*:<>?/\\|\u0000-\u001f]/g;
/** A file or folder name OneDrive accepts: the characters it forbids become `-`, and it never ends in a dot or a space. */
export function driveName(name: string, extension?: string): string {
  let n = name.replace(FORBIDDEN_NAME, '-').trim().replace(/[. ]+$/, '');
  if (!n) n = 'untitled';
  if (n.length > 200) n = n.slice(0, 200);
  if (extension && !n.toLowerCase().endsWith(extension.toLowerCase())) n += extension;
  return n;
}

export interface A1 {
  sheet: string | null;
  startCol: number;
  startRow: number;
  endCol: number;
  endRow: number;
}

/** `Sheet1!A2:C9` (or `'My Sheet'!B3`) to numbers. Null for anything else (a whole column such as `A:C` has no rows). */
export function parseA1(address: string): A1 | null {
  const m = /^(?:'((?:[^']|'')+)'|([^!']+))?!?([A-Za-z]{1,3})(\d{1,7})(?::([A-Za-z]{1,3})(\d{1,7}))?$/.exec(address.includes('!') ? address : `!${address}`);
  if (!m) return null;
  const sheet = m[1] !== undefined ? m[1].replace(/''/g, "'") : (m[2] ?? null);
  const startCol = columnNumber(m[3]!);
  const startRow = Number(m[4]);
  return { sheet, startCol, startRow, endCol: m[5] ? columnNumber(m[5]) : startCol, endRow: m[6] ? Number(m[6]) : startRow };
}

export const a1 = (startCol: number, startRow: number, endCol: number, endRow: number): string => `${columnName(startCol)}${startRow}:${columnName(endCol)}${endRow}`;

/** A sheet name in an address: quoted when it has anything but letters, digits and underscores. */
export const sheetRef = (name: string): string => (/^[A-Za-z0-9_]+$/.test(name) ? name : `'${name.replace(/'/g, "''")}'`);
