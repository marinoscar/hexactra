import type { TuiMenuNode, TuiMenuSlotContext, TuiMenuSlots } from '@marinoscar/platform-cli/tui';

/**
 * The TUI root menu: grouped, and different logged in and logged out (#357).
 *
 * Logged in, the root is five groups (Agent, Worker, Server, Developer,
 * Account). Logged out, it is Log in plus the groups that still have
 * something usable without a server; a group with no visible entry is hidden
 * by the platform. Entries that need a login are HIDDEN when logged out
 * rather than greyed: the root footnote says what logging in shows.
 *
 * `loggedOut` cascades from a section to its entries, so every group sets it
 * to `true` and each entry that needs a login opts out with `false`. Entries
 * shown logged out also set `requiresLogin: false`: their screens annotate
 * the actions that need a login themselves.
 *
 * Every screen the CLI registers is referenced here, so none falls back to
 * the root (menu.test.ts pins it). Plain data only: no ink at import.
 */
export const HEXACTRA_TUI_MENU: readonly TuiMenuNode[] = [
  // Logged out only: the first thing to do. Logged in it moves to Account.
  { kind: 'entry', id: 'login', route: 'login', label: 'Log in', ellipsis: true, order: 5, loggedOut: true, hideWhenLoggedIn: true, requiresLogin: false },

  // --- Agent: browser agents and the machine they run on ----------------------
  {
    kind: 'section',
    id: 'agent-group',
    label: 'Agent',
    order: 10,
    loggedOut: true,
    subtitle: 'Browser agents: answer them, watch them, manage their nodes.',
  },
  { kind: 'entry', id: 'inbox', parent: 'agent-group', route: 'inbox', label: 'Inbox: agents waiting for you', order: 10, loggedOut: false },
  { kind: 'entry', id: 'runs', parent: 'agent-group', route: 'runs', label: 'Runs: watch browser agents', order: 20, loggedOut: false },
  { kind: 'entry', id: 'fleet', parent: 'agent-group', route: 'fleet', label: 'Fleet: nodes and profiles', order: 30, loggedOut: false },
  {
    kind: 'entry',
    id: 'browser-node',
    parent: 'agent-group',
    route: 'agent',
    label: 'This machine as a browser node: install, Chrome, unattended desktop',
    order: 40,
    requiresLogin: false,
  },

  // --- Worker: server background jobs ---------------------------------------
  {
    kind: 'section',
    id: 'worker-group',
    label: 'Worker',
    order: 20,
    loggedOut: true,
    subtitle: "Background jobs: the server's queue and the machines that run them.",
  },
  { kind: 'entry', id: 'jobs', parent: 'worker-group', route: 'jobs', label: 'Jobs queue', order: 10, loggedOut: false },
  {
    kind: 'entry',
    id: 'worker-node',
    parent: 'worker-group',
    route: 'node',
    label: 'Worker node on this machine: dashboard, doctor, logs, enroll',
    order: 20,
    requiresLogin: false,
  },

  // --- Server: the console deployment ---------------------------------------
  {
    kind: 'section',
    id: 'server-group',
    label: 'Server',
    order: 30,
    loggedOut: true,
    subtitle: 'The console server: install it, update it, check it.',
  },
  {
    kind: 'entry',
    id: 'deploy',
    parent: 'server-group',
    route: 'deploy',
    label: ({ loggedIn }) => (loggedIn ? 'Deploy: install, update, doctor, status' : 'Deploy the console on this server'),
    order: 10,
    requiresLogin: false,
  },
  {
    kind: 'entry',
    id: 'server-status',
    parent: 'server-group',
    route: 'status',
    label: 'Server status: URL, signed-in user, token expiry',
    order: 20,
    requiresLogin: false,
  },

  // --- Developer: building and debugging ------------------------------------
  {
    kind: 'section',
    id: 'developer-group',
    label: 'Developer',
    order: 40,
    loggedOut: true,
    subtitle: 'Tools for building and debugging.',
  },
  {
    kind: 'entry',
    id: 'android',
    parent: 'developer-group',
    route: 'android',
    label: 'Android app: doctor, bump, build, publish, releases',
    order: 10,
    requiresLogin: false,
  },
  { kind: 'entry', id: 'invoke', parent: 'developer-group', route: 'invoke', label: 'Call an API endpoint', ellipsis: true, order: 20, loggedOut: false },

  // --- Account: logged in only ----------------------------------------------
  { kind: 'section', id: 'account-group', label: 'Account', order: 50, subtitle: 'Who this CLI acts as.' },
  { kind: 'entry', id: 'switch-account', parent: 'account-group', route: 'login', label: 'Switch account or server', ellipsis: true, order: 10 },
  { kind: 'entry', id: 'logout', parent: 'account-group', route: 'logout', label: 'Log out', order: 20 },
];

/**
 * Under the root menu when logged out: what logging in adds. Two short lines,
 * because the menu truncates each line: this fits a 40-column terminal.
 */
export const LOGGED_OUT_FOOTNOTE = ['Log in to see Inbox, Runs, Fleet,', 'Jobs queue and Call an endpoint.'] as const;

/** The root footnote slot: the logged-out hint, nothing once logged in. */
export const ROOT_MENU_FOOTNOTE: NonNullable<TuiMenuSlots['footnote']> = {
  content: ({ loggedIn }: TuiMenuSlotContext) => (loggedIn ? undefined : LOGGED_OUT_FOOTNOTE),
  color: 'dim',
};
