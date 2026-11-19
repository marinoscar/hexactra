// Where an email address stands (E39.10, #607; the rule is E39.6, #603): the owner's own addresses and the addresses of their own
// accounts need no confirmation; any other address is confirmed once, by the owner, in a dialog that names it.
import type { PlatformApiClient } from '@marinoscar/platform-web/core';

import type { Connection } from '../connections/api';

export interface RecipientRecord {
  address: string;
  confirmedAt: string;
  unsubscribedAt: string | null;
}

export type RecipientState = 'own' | 'confirmed' | 'unconfirmed' | 'unsubscribed';

export const listRecipients = (api: PlatformApiClient) => api.get<RecipientRecord[]>('/delivery-recipients');
export const confirmRecipient = (api: PlatformApiClient, address: string) => api.post<RecipientRecord>('/delivery-recipients', { address });

/** The addresses the owner may use at once: their own sign-in address and the addresses of their connected accounts, first the sign-in one. */
export function ownAddresses(viewerEmail: string | null | undefined, connections: readonly Pick<Connection, 'accountEmail' | 'provider'>[]): string[] {
  const out: string[] = [];
  for (const a of [viewerEmail ?? '', ...connections.filter((c) => c.provider !== 'mcp').map((c) => c.accountEmail)]) {
    const lower = a.trim().toLowerCase();
    if (lower && !out.includes(lower)) out.push(lower);
  }
  return out;
}

export function recipientState(address: string, own: readonly string[], records: readonly RecipientRecord[]): RecipientState {
  const a = address.trim().toLowerCase();
  if (own.includes(a)) return 'own';
  const r = records.find((x) => x.address.toLowerCase() === a);
  if (!r) return 'unconfirmed';
  return r.unsubscribedAt ? 'unsubscribed' : 'confirmed';
}

/** The addresses of an email that must be confirmed (again) before the delivery can be switched on. */
export function needsConfirming(addresses: readonly string[], own: readonly string[], records: readonly RecipientRecord[]): { address: string; state: 'unconfirmed' | 'unsubscribed' }[] {
  return addresses.flatMap((address) => {
    const state = recipientState(address, own, records);
    return state === 'unconfirmed' || state === 'unsubscribed' ? [{ address, state }] : [];
  });
}
