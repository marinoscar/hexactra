// `hexactra tasks deliveries …` and `hexactra runs deliveries` (E39.6, #603): what a task sends when a run ends and what was sent for
// a run, as lines. The API answers no secret, no subject, no cell and no file name; nothing here adds one. An address the owner typed is
// shown (it is the owner's own data, on their own terminal); a log entry never has one.
export interface CliDelivery {
  id: string;
  kind: 'email' | 'webhook' | 'sheet_row' | 'folder';
  enabled: boolean;
  when: string;
  config: Record<string, unknown>;
  recipients: { address: string; state: 'own' | 'confirmed' | 'unconfirmed' | 'unsubscribed' }[];
  connection: { id: string; label: string | null } | null;
  disabledReason: string | null;
}

export interface CliRunDelivery {
  id: string;
  deliveryId: string | null;
  kind: CliDelivery['kind'];
  status: string;
  attempts: number;
  errorCode: string | null;
  errorText: string | null;
  detail: Record<string, unknown>;
  sentAt: string | null;
  nextAttemptAt: string | null;
}

const KIND: Record<CliDelivery['kind'], string> = { email: 'email', webhook: 'webhook', sheet_row: 'spreadsheet row', folder: 'folder' };
const WHEN: Record<string, string> = { always: 'always', succeeded: 'when it succeeds', failed: 'when it fails', needs_attention: 'when it needs attention' };
const STATE: Record<string, string> = { own: 'yours', confirmed: 'confirmed', unconfirmed: 'NOT CONFIRMED', unsubscribed: 'stopped the emails' };

/** Where a delivery sends, in words (an address, a host, a connection's label). */
export function destinationText(d: CliDelivery): string {
  if (d.kind === 'email') return d.recipients.length ? d.recipients.map((r) => `${r.address} (${STATE[r.state]})`).join(', ') : '(no address)';
  if (d.kind === 'webhook') {
    try {
      return new URL(String(d.config.url)).host;
    } catch {
      return '(address)';
    }
  }
  if (d.kind === 'folder' && d.config.target === 'storage') return 'the console\'s storage';
  return d.connection ? `connection ${d.connection.label ?? '(removed)'}` : '(no connection)';
}

export function deliveryLines(deliveries: readonly CliDelivery[]): string[] {
  if (!deliveries.length) return ['This task sends nothing when a run ends.'];
  return deliveries.map((d) => {
    const flags = [d.enabled ? 'on' : d.disabledReason === 'connection_removed' ? 'off: connection removed' : 'off', WHEN[d.when] ?? d.when].join(', ');
    return `${d.id}  ${KIND[d.kind]}  ${destinationText(d)}  [${flags}]`;
  });
}

/** `runs deliveries`: one line per delivery of the run. */
export function runDeliveryLines(rows: readonly CliRunDelivery[]): string[] {
  if (!rows.length) return ['Nothing was sent for this run.'];
  return rows.map((r) => {
    const why = r.errorText ? `: ${r.errorText}` : '';
    const next = r.status === 'pending' && r.nextAttemptAt ? ` (next try ${r.nextAttemptAt})` : '';
    return `${r.id}  ${KIND[r.kind]}  ${r.status}${why}  attempts ${r.attempts}${next}`;
  });
}

/** The delivery a ref names (an id or its first characters), among a task's. */
export function findDelivery(list: readonly CliDelivery[], ref: string): CliDelivery {
  const m = list.filter((d) => d.id === ref || d.id.startsWith(ref));
  if (m.length !== 1) throw new Error(m.length ? `"${ref}" matches several deliveries; use the id` : `No delivery matches "${ref}"`);
  return m[0]!;
}
