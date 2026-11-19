// Plain words for MCP servers (E39.9, #606): what a tool decision means, what a server's hints say (as the server's claim, never a
// promise), how a sign-in reads, and what the owner is told when adding a server fails. Nothing here is the server's text.
import type { McpAuthKind, McpTool, McpToolMode } from './api';

export const MODE_WORDS: Record<McpToolMode, string> = { off: 'Off', read: 'Read', write: 'Write' };

export const MODE_HELP: Record<McpToolMode, string> = {
  off: 'The agent cannot see or use this tool.',
  read: 'The agent calls it without asking. Choose this only for a tool that just looks things up.',
  write: 'It changes something: the agent asks you first, every time unless you tick "Don\'t ask again" on the card.',
};

export const AUTH_WORDS: Record<McpAuthKind, string> = { none: 'No sign-in', bearer: 'Bearer token', header: 'Header', oauth: 'OAuth' };

/** What the server says about a tool, as short claims. */
export function hintWords(t: Pick<McpTool, 'hints'>): string[] {
  const h = t.hints;
  return [
    h.readOnly === true ? 'Says it only reads' : h.readOnly === false ? 'Says it can change things' : null,
    h.destructive === true ? 'Says it can destroy data' : null,
    h.idempotent === true ? 'Says repeating it is safe' : null,
    h.openWorld === true ? 'Says it reaches outside systems' : null,
  ].filter((x): x is string => x !== null);
}

/** "Server says" caption under the switch: the suggestion is only that. */
export const suggestionWords = (t: Pick<McpTool, 'suggested' | 'hints'>): string =>
  t.hints.readOnly === null && t.hints.destructive === null ? 'The server gave no hints, so write is suggested.' : `Suggested from the server's hints: ${t.suggested}. You decide.`;

export const REVIEW_WORDS = { new: 'New: off until you decide', changed: 'Changed: off until you review it' } as const;

/** What an add or sign-in failure means, from the API's closed codes. */
export function mcpErrorWords(code: string | undefined, details: unknown): string | null {
  const reason = (details as { reason?: string } | undefined)?.reason;
  switch (code) {
    case 'CONNECTION_PROVIDER_UNAVAILABLE':
      return 'Your administrator has not switched MCP servers on.';
    case 'CONNECTION_MCP_URL_REFUSED': {
      const why: Record<string, string> = {
        scheme_not_allowed: 'Only https addresses are allowed.',
        private_target: 'That address points at a private or internal network, which is not allowed.',
        host_not_allowed: 'Your administrator has not allowed that host.',
        host_blocked: 'Your administrator has blocked that host.',
        userinfo_not_allowed: 'Leave the user name and password out of the address: use the bearer token or a header.',
        query_not_allowed: 'Leave the query (?...) out of the address: put a token in the bearer token or a header instead.',
        invalid_url: 'That is not a valid address.',
        unresolvable: 'That address could not be found.',
      };
      return why[reason ?? ''] ?? 'That address is not allowed.';
    }
    case 'CONNECTION_MCP_EXISTS':
      return 'You already have a connection to this server.';
    case 'CONNECTION_LABEL_TAKEN':
      return 'You already have a connection with this name.';
    case 'CONNECTION_MCP_AUTH_REQUIRED':
      return (details as { needsClient?: boolean } | undefined)?.needsClient
        ? 'The server does not register clients itself. Give the client id (and secret) of an app you registered with it.'
        : (details as { oauth?: boolean } | undefined)?.oauth
          ? 'The server wants you to sign in. Choose OAuth, or give it a bearer token or header.'
          : 'The server did not accept the sign-in you gave.';
    case 'CONNECTION_MCP_PROTOCOL':
      return 'That server does not speak MCP over Streamable HTTP (revisions 2025-03-26 and later).';
    case 'CONNECTION_UNAVAILABLE':
      return reason === 'redirect' ? 'The server redirected, and Hexactra does not follow redirects. Use the final address.' : 'The server could not be reached or did not answer in time.';
    case 'CONNECTION_LIMIT':
      return 'You have the most connections allowed. Remove one first.';
    default:
      return null;
  }
}
