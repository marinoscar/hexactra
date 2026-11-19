// The context the app's own tool families (saved logins, identity details, cards, memories) are written against: the browser context, plus the
// collaborators an app tool may use. These tools live in the host layer because they reach console services; they are still tools: they take
// everything from the context and import neither the loop nor another tool.
import type { FabricSession } from '../fabric-session';
import type { BrowserExt } from '../browser/context';
import type { RunContext } from '../harness';
import type { UsedSavedCard } from '../saved-cards';
import type { UsedSavedIdentity } from '../saved-identity';
import type { UsedSavedLogin } from '../saved-logins';
import type { HostDeps } from './deps';
import type { RunMemory } from './run-memory';

/** What the run keeps about the saved secrets it used (the columns `runs.used_saved_*`): labels and brands, never a value. */
export interface UsedSaved {
  logins: UsedSavedLogin[];
  identity: UsedSavedIdentity[];
  cards: UsedSavedCard[];
}

export interface HostExt extends BrowserExt {
  d: HostDeps;
  db: ReturnType<HostDeps['prisma']['forUser']>;
  /** The fabric session of the run: the saved-secret tools call the provider operations of the browser host through it. */
  fabric: { session: FabricSession; sessionId(): string };
  /** The run row's task and chat facts the app's tools read. */
  run: {
    task: { unattendedPayments: string | null; parameters?: unknown } | null;
    inputs: unknown;
    origin?: string | null;
    clientName?: string | null;
  };
  /** The AI app that started the run, as named to a provider. */
  clientLabel: string;
  /** Not started from a chat: a schedule, the API, MCP, a task run with nobody in a thread. */
  unattended: boolean;
  /** The AI app asks before purchases (#464). */
  appConfirmsPurchases: boolean;
  used: UsedSaved;
  /** The saved-secret tool families this run is offered. */
  flags: { savedLogins: boolean; savedIdentity: boolean; savedCards: boolean; saveLogin: boolean };
}

export type HostContext = RunContext<RunMemory, HostExt>;
