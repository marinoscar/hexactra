// Plain words for the Connections pages (E39.2, #599): what each capability lets the agent do, how a group reads ("read" or "read
// and write"), what a status and a reason code mean to the owner, and what the page says when the consent comes back.
import type { Capability, CapabilityGroup, Connection, ConnectionStatus, Provider } from './api';

export const PROVIDER_NAME: Record<Provider, string> = { google: 'Google', microsoft: 'Microsoft' };

export interface GroupDef {
  group: CapabilityGroup;
  name: string;
  read: Capability;
  write: Capability;
  readWords: string;
  writeWords: string;
  /** A third switch some groups have: Mail's "organize" (archive, labels, mark read, drafts). It needs read, and is not write. */
  modify?: Capability;
  modifyWords?: string;
}

export const GROUPS: GroupDef[] = [
  {
    group: 'mail',
    name: 'Mail',
    read: 'mail_read',
    write: 'mail_send',
    readWords: 'Read and search your email.',
    writeWords: 'Send email as you.',
    modify: 'mail_modify',
    modifyWords: 'Archive, label and mark messages as read, and save drafts. The provider treats this as a more sensitive permission than sending.',
  },
  { group: 'calendar', name: 'Calendar', read: 'calendar_read', write: 'calendar_write', readWords: 'See your events and free time.', writeWords: 'Create and change events.' },
  { group: 'docs', name: 'Documents', read: 'docs_read', write: 'docs_write', readWords: 'Read your documents, spreadsheets and files.', writeWords: 'Create and change documents, add spreadsheet rows, save files.' },
];

export const CAPABILITY_WORDS: Record<Capability, string> = {
  mail_read: 'Read mail',
  mail_send: 'Send mail',
  mail_modify: 'Organize mail',
  calendar_read: 'Read calendar',
  calendar_write: 'Change calendar',
  docs_read: 'Read documents',
  docs_write: 'Change documents',
};

/** `read`, `read and write` (mail: also `read and organize`, `read, send and organize`) or null: how a group's chip reads for the switches that are on. */
export function levelOf(caps: readonly Capability[], g: GroupDef): string | null {
  if (g.modify && caps.includes(g.modify)) return caps.includes(g.write) ? 'read, send and organize' : 'read and organize';
  if (caps.includes(g.write)) return 'read and write';
  if (caps.includes(g.read)) return 'read';
  return null;
}

export const GROUP_NAME: Record<CapabilityGroup, string> = { mail: 'Mail', calendar: 'Calendar', docs: 'Documents' };

export const STATUS_WORDS: Record<ConnectionStatus, string> = { active: 'Active', paused: 'Paused', needs_reconnect: 'Needs reconnect', revoked: 'Revoked' };

/** Why a connection is in its state, in a sentence. */
export function reasonWords(c: Pick<Connection, 'status' | 'statusReason'>): string | null {
  if (c.status === 'paused') return 'Paused: no task, chat or delivery uses it until you resume it.';
  if (c.status === 'needs_reconnect') {
    const why: Record<string, string> = {
      GRANT_REVOKED: 'The provider no longer accepts it (you removed the app there, changed the password, or the sign-in expired).',
      NO_REFRESH_TOKEN: 'The saved sign-in is missing.',
      TOKEN_STORE_FAILED: 'The new sign-in could not be saved.',
    };
    return `${why[c.statusReason ?? ''] ?? 'The provider no longer accepts it.'} Connect it again to use it.`;
  }
  if (c.status === 'active' && c.statusReason) return 'The provider could not be reached the last time; it will try again.';
  return null;
}

/** The test's reason codes in words. */
export function testCodeWords(code: string | null): string {
  switch (code) {
    case null:
      return 'Works';
    case 'FORBIDDEN':
      return 'The provider refused: the permission is missing';
    case 'UNAUTHORIZED':
      return 'The sign-in was refused';
    case 'UNAVAILABLE':
      return 'The provider could not be reached';
    case 'API_DISABLED':
      return 'The service is switched off in your administrator\'s app at the provider';
    case 'RATE_LIMITED':
      return 'The provider asked to slow down; try again in a minute';
    default:
      return 'Failed';
  }
}

export interface Outcome {
  severity: 'success' | 'warning' | 'error' | 'info';
  text: string;
}

/** The banner after the consent returns (`?connect=<outcome>&missing=a,b`): a closed set of outcomes, nothing from the provider. */
export function outcomeBanner(outcome: string, label: string | null, missing: readonly string[]): Outcome {
  switch (outcome) {
    case 'connected': {
      const who = label ? ` ${label}` : '';
      if (missing.length > 0) {
        const names = missing.map((m) => CAPABILITY_WORDS[m as Capability] ?? m).join(', ');
        return { severity: 'warning', text: `Connected${who}, but the provider did not allow: ${names}. Those are off. Use "Change what it can do" to ask again.` };
      }
      return { severity: 'success', text: `Connected${who}.` };
    }
    case 'denied':
      return { severity: 'info', text: 'You did not allow access, so nothing was connected.' };
    case 'expired':
      return { severity: 'error', text: 'That took too long (more than 10 minutes). Start again.' };
    case 'account_mismatch':
      return { severity: 'error', text: 'You signed in with a different account than this connection. Nothing changed. Sign in with the same account.' };
    case 'nothing_granted':
      return { severity: 'warning', text: 'The provider allowed none of what was asked, so nothing was connected.' };
    case 'no_refresh_token':
      return { severity: 'error', text: 'The provider did not give a lasting sign-in. Remove this app in your account at the provider and connect again.' };
    case 'limit':
      return { severity: 'error', text: 'You have the most connections allowed. Remove one first.' };
    case 'provider_unavailable':
      return { severity: 'error', text: 'This provider is not available on this deployment right now. Ask your administrator.' };
    default:
      return { severity: 'error', text: 'The connection could not be completed. Start again; if it keeps failing, ask your administrator.' };
  }
}
