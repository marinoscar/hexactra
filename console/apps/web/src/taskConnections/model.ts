// What the agent can use (E50.17, #987): every connection the owner switched on, in every task and chat. The per-task and per-chat lists of
// E39.10 are gone; the deprecated wire types stay here while the API still answers them (always empty). Pure.
import type { Connection } from '../connections/api';

export type ConnectionAccess = 'read' | 'read_write';

/** Deprecated (E50.17): the shape of the old per-task and per-chat lists the API still accepts and ignores. */
export interface ConnectionSelection {
  connectionId: string;
  access: ConnectionAccess;
}

/** Deprecated (E50.17): what `GET /tasks/{id}` and `GET /chats/{id}` answer in `connections`: always empty now. */
export interface ConnectionSelectionView extends ConnectionSelection {
  label: string;
  provider: string;
  accountEmail: string;
  status: string;
}

export type NeedsBrowser = 'auto' | 'always' | 'never';

/** Deprecated (E50.17): `Task.connectionsMode` is always `all`. */
export type ConnectionsMode = 'all' | 'listed';

export const ACCESS_WORDS: Record<'none' | ConnectionAccess, string> = { none: 'Not used', read: 'Read only', read_write: 'Read and change' };

/** The owner's connections that are switched on (active), by label: what every task and chat can use. */
export const switchedOnNames = (connections: readonly Connection[]): string[] => connections.filter((c) => c.status === 'active').map((c) => c.label);

/** One line for the folded section of the task form. */
export function switchedOnSummary(connections: readonly Connection[] | null): string {
  if (connections === null) return 'Everything you switched on';
  const names = switchedOnNames(connections);
  return names.length === 0 ? 'Nothing switched on yet: the agent uses the browser.' : `Everything you switched on: ${names.join(', ')}`;
}
