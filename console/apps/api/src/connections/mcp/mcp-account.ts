// How an MCP connection is identified (E39.9, #606): by its address. The same address cannot be added twice by one owner (one place for its
// tools and its sign-in); a second connection to the same server is the same connection, reconnected.
import { createHash } from 'node:crypto';

import { MAX_LABEL_LENGTH } from '../connections.constants';

/** The stable account id of a server: the hash of its normalised address (never the address itself, which may be long). */
export const accountIdOf = (url: string): string => createHash('sha256').update(new URL(url).toString().toLowerCase()).digest('hex');

/** The server's canonical URI for the `resource` parameter (RFC 8707): the address without a trailing slash on a bare origin. */
export function canonicalResource(url: string): string {
  const u = new URL(url);
  u.hash = '';
  u.search = '';
  return u.pathname === '/' ? u.origin : `${u.origin}${u.pathname.replace(/\/+$/, '')}`;
}

/** A label for a server the owner did not name: its host, shortened to fit. */
export function hostLabel(url: string): string {
  const host = new URL(url).hostname;
  return host.length <= MAX_LABEL_LENGTH ? host : `${host.slice(0, MAX_LABEL_LENGTH - 1)}…`;
}
