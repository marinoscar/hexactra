// The connection tools of a run, in the order the model is offered them (E39.7): the list, then mail, calendar and documents. A composer: the
// one file that imports the tool files of this family. A tool is offered only when the run has a connection with the capability switched on
// and, for a tool that changes something, read and write access (`available`).
import type { RunnerTool } from '@marinoscar/hexactra-agent';
import type { HostContext } from '../../context';
import { calendarTools } from './calendar';
import { docsTools } from './docs';
import { connectionsList } from './list';
import { mailTools } from './mail';

export const connectionTools: RunnerTool<HostContext>[] = [connectionsList, ...mailTools, ...calendarTools, ...docsTools];

export { CONNECTION_USAGE } from './list';
