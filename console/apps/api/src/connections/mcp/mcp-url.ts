// What an MCP server's address may be (E39.9, #606). Three layers, none of which the owner can switch off:
//   1. the SHAPE (here): an absolute URL with no user name or password, no query and no fragment (a token in a URL would sit in a
//      column and in logs: use the bearer token or a header), and a host name the administrator's lists allow;
//   2. the TARGET (`OutboundHttp`, src/oauth-client/outbound-http.ts): `https` only (`http` and loopback only outside production), every
//      address the name resolves to checked against private, loopback, link-local and carrier-grade-NAT ranges, the connection pinned to
//      the address that was checked, and a redirect NEVER followed;
//   3. both again at CALL time: the client runs them before every request, so a name that resolved public when the server was added and
//      private now (DNS rebinding) is refused before anything is sent.
import type { OutboundErrorCode } from '../../oauth-client';
import type { ResolvedMcpSettings } from '../connections.settings';

/** Why an address was refused: a closed set, never the address, a path or a message from a server. */
export type McpUrlRefusal = OutboundErrorCode | 'query_not_allowed' | 'host_not_allowed' | 'host_blocked';

export class McpUrlError extends Error {
  constructor(
    readonly code: McpUrlRefusal,
    message: string,
  ) {
    super(message);
    this.name = 'McpUrlError';
  }
}

const REFUSAL_TEXT: Record<McpUrlRefusal, string> = {
  invalid_url: 'The address is not a valid URL.',
  scheme_not_allowed: 'Only https addresses are allowed.',
  userinfo_not_allowed: 'The address must not contain a user name or password.',
  query_not_allowed: 'The address must not contain a query or a fragment: put a token in the bearer token or a header instead.',
  port_not_allowed: 'That port is not allowed.',
  private_target: 'The address points at a private or internal network, which is not allowed.',
  unresolvable: 'The address could not be resolved.',
  host_not_allowed: 'The administrator has not allowed this host.',
  host_blocked: 'The administrator has blocked this host.',
  timeout: 'The server did not answer in time.',
  too_large: 'The server answered with more than the limit.',
  network: 'The server could not be reached.',
  aborted: 'The request was cancelled.',
};

export const refusalText = (code: McpUrlRefusal): string => REFUSAL_TEXT[code];
export const urlError = (code: McpUrlRefusal): McpUrlError => new McpUrlError(code, REFUSAL_TEXT[code]);

/** The address as it is kept: parsed, trimmed, with the default port and a trailing slash on the bare origin normalised. */
export function normalizeMcpUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw urlError('invalid_url');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw urlError('scheme_not_allowed');
  if (url.username || url.password) throw urlError('userinfo_not_allowed');
  if (url.search || url.hash) throw urlError('query_not_allowed');
  if (!url.hostname) throw urlError('invalid_url');
  return url.toString();
}

const bare = (host: string): string => (host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host).toLowerCase();

/** `mcp.example.test` matches itself; `*.example.test` matches any subdomain of it (not the bare domain). */
export function hostMatches(host: string, pattern: string): boolean {
  const h = bare(host);
  const p = pattern.trim().toLowerCase();
  if (p.startsWith('*.')) return h.endsWith(p.slice(1)) && h.length > p.length - 1;
  return h === p;
}

/** The administrator's lists: the block-list wins; a non-empty allow-list admits only its hosts; an empty one admits any host. */
export function checkHostLists(host: string, lists: Pick<ResolvedMcpSettings, 'allowedHosts' | 'blockedHosts'>): void {
  if (lists.blockedHosts.some((p) => hostMatches(host, p))) throw urlError('host_blocked');
  if (lists.allowedHosts.length > 0 && !lists.allowedHosts.some((p) => hostMatches(host, p))) throw urlError('host_not_allowed');
}
