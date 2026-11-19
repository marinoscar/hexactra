// Which accounts a task or a chat may use, and how (E39.10, #607; the API is E39.7, #604): the selection the form edits, its words, and the
// hint about runs that need no browser. Pure. Nothing is available by default: an account is used only when it is in the list.
import type { Capability, Connection } from '../connections/api';
import { GROUPS, levelOf } from '../connections/words';

export type ConnectionAccess = 'read' | 'read_write';
export type AccessChoice = 'none' | ConnectionAccess;

export interface ConnectionSelection {
  connectionId: string;
  access: ConnectionAccess;
}

/** What `GET /tasks/{id}` and `GET /chats/{id}` answer for each selected account. */
export interface ConnectionSelectionView extends ConnectionSelection {
  label: string;
  provider: string;
  accountEmail: string;
  status: string;
}

export type NeedsBrowser = 'auto' | 'always' | 'never';

export const ACCESS_WORDS: Record<AccessChoice, string> = { none: 'Not used', read: 'Read only', read_write: 'Read and change' };

export const ACCOUNTS_HELP = 'The agent can only use accounts you switch on here. It asks before it sends or changes anything, unless you told it not to ask again.';

export function accessOf(selections: readonly ConnectionSelection[], connectionId: string): AccessChoice {
  return selections.find((s) => s.connectionId === connectionId)?.access ?? 'none';
}

/** The selections with `connectionId` set to `choice` (`none` removes it), keeping the order they were switched on. */
export function withAccess(selections: readonly ConnectionSelection[], connectionId: string, choice: AccessChoice): ConnectionSelection[] {
  const rest = selections.filter((s) => s.connectionId !== connectionId);
  if (choice === 'none') return rest;
  const at = selections.findIndex((s) => s.connectionId === connectionId);
  if (at < 0) return [...rest, { connectionId, access: choice }];
  const next = [...rest];
  next.splice(at, 0, { connectionId, access: choice });
  return next;
}

/** An account that can change something: one of its change switches is on. */
export const canChange = (c: Pick<Connection, 'capabilities'>): boolean => c.capabilities.some((k) => k === 'mail_send' || k === 'mail_modify' || k === 'calendar_write' || k === 'docs_write');

/** An account the agent can use now. */
export const isUsable = (c: Pick<Connection, 'status'>): boolean => c.status === 'active';

/** Why a choice is not offered for an account, in words, or null. */
export function choiceBlocked(c: Connection, choice: AccessChoice, current: AccessChoice): string | null {
  if (choice === 'none') return null;
  if (!isUsable(c)) return current === choice ? null : c.status === 'paused' ? 'Paused: resume it first.' : 'It needs to be connected again first.';
  // An MCP server has tools, not capabilities: the owner's per-tool decision (read or write) is what `read_write` unlocks.
  if (choice === 'read_write' && c.provider !== 'mcp' && !canChange(c)) return 'No "change" permission is switched on for this account.';
  return null;
}

/** One line for the collapsed section: "2 accounts: Work (read only), Personal (read and change)". */
export function summaryLine(selections: readonly ConnectionSelection[], connections: readonly Connection[] | null): string {
  if (selections.length === 0) return 'No accounts: the agent cannot use any of your mail, calendar or documents.';
  const named = selections.map((s) => {
    const label = connections?.find((c) => c.id === s.connectionId)?.label;
    return `${label ?? 'An account'} (${s.access === 'read_write' ? 'read and change' : 'read only'})`;
  });
  return `${selections.length === 1 ? '1 account' : `${selections.length} accounts`}: ${named.join(', ')}`;
}

/** What an account can do, as chips: "Mail: read and write". */
export function capabilityChips(c: Pick<Connection, 'capabilities'>): string[] {
  const out: string[] = [];
  for (const g of GROUPS) {
    const level = levelOf(c.capabilities as readonly Capability[], g);
    if (level) out.push(`${g.name}: ${level}`);
  }
  return out;
}

/** The request body's field: only what is switched on. */
export const cleanSelections = (selections: readonly ConnectionSelection[]): ConnectionSelection[] => selections.map(({ connectionId, access }) => ({ connectionId, access }));

export const selectionsOf = (views: readonly ConnectionSelectionView[] | undefined | null): ConnectionSelection[] => (views ?? []).map(({ connectionId, access }) => ({ connectionId, access }));

const BROWSER_WORDS = /\b(https?:\/\/|www\.|website|web site|webpage|web page|log ?in|sign ?in|click|browse|portal|checkout|book|buy|order|pay|download|upload|fill)\b/i;
const NO_BROWSER_WORDS = /\b(emails?|e-mails?|mail|inbox|calendar|meeting|events?|spreadsheet|sheet|documents?|docs?|summari[sz]e|summary|schedule)\b/i;

/**
 * "Runs without a browser": informational only. True when the task has accounts switched on, `needsBrowser` is `auto` and the goal
 * names mail, a calendar or documents and nothing that sounds like a website.
 */
export function looksBrowserless(goal: string, selections: readonly ConnectionSelection[], needsBrowser: NeedsBrowser): boolean {
  return needsBrowser === 'auto' && selections.length > 0 && goal.trim().length > 0 && NO_BROWSER_WORDS.test(goal) && !BROWSER_WORDS.test(goal);
}
