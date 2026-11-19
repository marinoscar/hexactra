// What the run page says about a run's deliveries (E39.6, #603): the log `GET /api/runs/{id}/deliveries` answers, as words. Pure.
export type DeliveryKind = 'email' | 'webhook' | 'sheet_row' | 'folder';
export type RunDeliveryStatus = 'pending' | 'sending' | 'sent' | 'failed' | 'skipped';

/** One entry of a run's delivery log. Never an address, a subject, a cell or a file name: the API does not send them. */
export interface RunDelivery {
  id: string;
  runId: string;
  deliveryId: string | null;
  kind: DeliveryKind;
  status: RunDeliveryStatus;
  attempts: number;
  errorCode: string | null;
  errorText: string | null;
  detail: Record<string, unknown>;
  sentAt: string | null;
  nextAttemptAt: string | null;
  createdAt: string;
}

const KIND: Record<DeliveryKind, string> = { email: 'Email', webhook: 'Webhook', sheet_row: 'Spreadsheet row', folder: 'Files in a folder' };
export const kindLabel = (k: DeliveryKind): string => KIND[k] ?? k;

const STATUS: Record<RunDeliveryStatus, string> = { pending: 'Waiting', sending: 'Sending', sent: 'Sent', failed: 'Failed', skipped: 'Skipped' };
export const statusLabel = (s: RunDeliveryStatus): string => STATUS[s] ?? s;

export const statusColor = (s: RunDeliveryStatus): 'default' | 'success' | 'error' | 'warning' | 'info' => (s === 'sent' ? 'success' : s === 'failed' ? 'error' : s === 'sending' ? 'info' : s === 'pending' ? 'warning' : 'default');

/** Still moving: the page looks again. */
export const isMoving = (rows: readonly RunDelivery[]): boolean => rows.some((r) => r.status === 'pending' || r.status === 'sending');

/** The one line a row reads as: why it failed or was skipped, when it retries, or what it did. Words from fixed sentences only. */
export function detailLine(r: RunDelivery): string {
  if (r.status === 'failed' || r.status === 'skipped') return r.errorText ? capitalise(r.errorText) : '';
  if (r.status === 'pending' && r.errorText) return `${capitalise(r.errorText)}; trying again`;
  const d = r.detail;
  if (r.status === 'sent') {
    if (r.kind === 'email' && typeof d.messages === 'number') return d.reportLink === true ? `${d.messages} sent, with a link to the report (it was too large to attach)` : `${d.messages} sent`;
    if (r.kind === 'folder' && typeof d.files === 'number') return d.files === 1 ? '1 file saved' : `${d.files} files saved`;
    if (r.kind === 'sheet_row') return d.deduplicated === true ? 'The row was already there' : 'Row added';
    if (r.kind === 'webhook' && typeof d.httpStatus === 'number') return `Answered ${d.httpStatus}`;
  }
  return '';
}

function capitalise(s: string): string {
  return s ? `${s[0]!.toUpperCase()}${s.slice(1)}` : s;
}

/** A failed delivery can be retried by its owner. */
export const canRetry = (r: RunDelivery): boolean => r.status === 'failed';

/** The configuration of a delivery the run page joins to a log row (`GET /tasks/{id}/deliveries`): enough to name where it went. */
export interface DeliveryDestination {
  id: string;
  kind: DeliveryKind;
  config: Record<string, unknown>;
  connection: { id: string; label: string | null } | null;
}

/**
 * Where a log row went, in words: "Email to 2 people", "Spreadsheet row in Work", "Folder in Work", "Hexactra storage", "hooks.example.test".
 * Built from the delivery's setup, never from the log (which holds no address, file name or path). A deleted delivery is its kind.
 */
export function destinationLabel(row: Pick<RunDelivery, 'kind' | 'detail'>, d: DeliveryDestination | undefined): string {
  if (!d) return kindLabel(row.kind);
  const c = d.config;
  const account = d.connection?.label ?? 'a removed account';
  if (d.kind === 'email') {
    const n = new Set([...(Array.isArray(c.to) ? c.to : []), ...(Array.isArray(c.cc) ? c.cc : [])].map((a) => String(a).toLowerCase())).size;
    return `Email to ${n === 1 ? '1 person' : `${n} people`}`;
  }
  if (d.kind === 'sheet_row') return `Spreadsheet row in ${account}`;
  if (d.kind === 'folder') return c.target === 'storage' ? 'Files in Hexactra storage' : `Files in a folder in ${account}`;
  try {
    return `Webhook to ${new URL(String(c.url)).host}`;
  } catch {
    return kindLabel(d.kind);
  }
}

/** The file or folder a log row can open at the provider, when the delivery names one in an account: `{ connectionId, fileId }`. */
export function linkTarget(row: Pick<RunDelivery, 'status'>, d: DeliveryDestination | undefined): { connectionId: string; fileId: string; what: 'spreadsheet' | 'folder' } | null {
  if (!d || row.status !== 'sent') return null;
  const c = d.config;
  if (d.kind === 'sheet_row' && typeof c.fileId === 'string' && typeof c.connectionId === 'string') return { connectionId: c.connectionId, fileId: c.fileId, what: 'spreadsheet' };
  if (d.kind === 'folder' && c.target && typeof c.target === 'object') {
    const t = c.target as { connectionId?: unknown; folderId?: unknown };
    if (typeof t.connectionId === 'string' && typeof t.folderId === 'string') return { connectionId: t.connectionId, fileId: t.folderId, what: 'folder' };
  }
  return null;
}
