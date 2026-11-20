// The connection tools of a run, in the order the model is offered them (E39.7): the list, then mail, calendar and documents. A composer: the
// one file that imports the tool files of this family. A tool is offered only when the run has a connection with the capability switched on
// and, for a tool that changes something, read and write access (`available`).
import type { RunnerTool, ToolFamily } from '@marinoscar/hexactra-agent';
import type { HostContext } from '../../context';
import { calendarTools } from './calendar';
import { docsTools } from './docs';
import { abilities, connectionsList } from './list';
import { refOf } from './support';
import { mailTools } from './mail';

export const connectionTools: RunnerTool<HostContext>[] = [connectionsList, ...mailTools, ...calendarTools, ...docsTools];

export { CONNECTION_USAGE } from './list';

const PROVIDER_NAMES: Record<string, string> = { google: 'Google', microsoft: 'Microsoft' };

/**
 * The owner's accounts as a tool family (E41.2): Google and Microsoft mail, calendar and documents. The toolbox names each account the run
 * lists with what it may do, from the run's own snapshot (identical in every round): `c1 "Work" (Google, read and change: read mail, ...)`.
 * Nothing beyond what `connections_list` shows: no address, no token.
 */
export const accountsFamily: ToolFamily<HostContext> = {
  id: 'accounts',
  title: "The owner's accounts",
  whenToUse: 'Their Google and Microsoft mail, calendar and files, through tools that read and act directly. Faster and more reliable than a web page: use them for anything about mail, calendar, documents, spreadsheets and files.',
  rank: 10,
  toolbox: (ctx) => {
    const accounts = ctx.ext.connections.list.filter((c) => c.provider !== 'mcp');
    if (accounts.length === 0) return null;
    return accounts
      .map((c) => {
        const write = c.access === 'read_write';
        const can = abilities(c.capabilities, write);
        return `${refOf(ctx, c)} "${c.label}" (${PROVIDER_NAMES[c.provider] ?? c.provider}, ${write ? 'read and change' : 'read only'}${can.length ? `: ${can.join(', ')}` : ''})`;
      })
      .join('; ');
  },
};
