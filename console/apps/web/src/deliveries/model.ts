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
