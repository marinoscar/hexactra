import { createCli } from '@marinoscar/platform-cli';
import { resetCliForTests } from '@marinoscar/platform-cli/testing';
import {
  BUILTIN_TUI_SCREENS,
  buildTuiMenuTree,
  getTuiRootMenuSlots,
  listRegisteredTuiScreens,
  listTuiMenuNodes,
  resolveTuiMenuSlot,
  tuiMenuItemLabel,
  tuiRouteRequiresLogin,
  visibleTuiMenuChildren,
  type TuiMenuTree,
} from '@marinoscar/platform-cli/tui';
import { describe, expect, it } from 'vitest';

import { APP_CLI_OPTIONS } from './app.js';
import { HEXACTRA_TUI_MENU, LOGGED_OUT_FOOTNOTE } from './menu.js';

resetCliForTests();
createCli(APP_CLI_OPTIONS);

// The grouped root menu, different logged in and logged out (#357).

/** Every screen the router can open: the platform's built-ins, then the app's. */
function allScreens(): { route: string; label: string; order: number }[] {
  return [
    ...BUILTIN_TUI_SCREENS.map(({ route, order }) => ({ route, order, label: route })),
    ...listRegisteredTuiScreens().map(({ route, order }) => ({ route, order, label: route })),
  ];
}

const tree: TuiMenuTree = buildTuiMenuTree(listTuiMenuNodes(), allScreens());

/** The lines of a section, as drawn, for a login state. */
function rows(sectionId: string, loggedIn: boolean): string[] {
  return visibleTuiMenuChildren(sectionId, { loggedIn }, tree).map((node) => tuiMenuItemLabel(node, undefined, { loggedIn }));
}

/** Every route reachable from the root for a login state. */
function reachable(loggedIn: boolean, sectionId = 'root'): string[] {
  return visibleTuiMenuChildren(sectionId, { loggedIn }, tree).flatMap((node) =>
    node.kind === 'entry' ? [node.route] : reachable(loggedIn, node.id),
  );
}

describe('the TUI menu', () => {
  it('is registered through createCli', () => {
    expect(listTuiMenuNodes().map((node) => node.id)).toEqual(HEXACTRA_TUI_MENU.map((node) => node.id));
  });

  it('logged in, the root is the five groups', () => {
    expect(rows('root', true)).toEqual(['Agent ▸', 'Worker ▸', 'Server ▸', 'Developer ▸', 'Account ▸']);
  });

  it('logged out, the root is Log in and the groups usable without a server', () => {
    expect(rows('root', false)).toEqual(['Log in…', 'Agent ▸', 'Worker ▸', 'Server ▸', 'Developer ▸']);
  });

  it('lays out every group logged in', () => {
    expect(rows('agent-group', true)).toEqual([
      'Inbox: agents waiting for you',
      'Runs: watch browser agents',
      'Fleet: nodes and profiles',
      'This machine as a browser node: dashboard, install, logs, doctor',
    ]);
    expect(rows('worker-group', true)).toEqual(['Jobs queue', 'Worker node on this machine: dashboard, doctor, logs, enroll']);
    expect(rows('server-group', true)).toEqual([
      'Deploy: install, update, doctor, status',
      'Server status: URL, signed-in user, token expiry',
    ]);
    expect(rows('developer-group', true)).toEqual(['Android app: doctor, bump, build, publish, releases', 'Call an API endpoint…']);
    expect(rows('account-group', true)).toEqual(['Switch account or server…', 'Log out']);
  });

  it('lays out every group logged out, without the entries that need a login', () => {
    expect(rows('agent-group', false)).toEqual(['This machine as a browser node: dashboard, install, logs, doctor']);
    expect(rows('worker-group', false)).toEqual(['Worker node on this machine: dashboard, doctor, logs, enroll']);
    expect(rows('server-group', false)).toEqual(['Deploy the console on this server', 'Server status: URL, signed-in user, token expiry']);
    expect(rows('developer-group', false)).toEqual(['Android app: doctor, bump, build, publish, releases']);
    expect(rows('account-group', false)).toEqual([]);
  });

  it('reaches every screen once logged in, and synthesises none at the root', () => {
    const routes = allScreens().map((screen) => screen.route);
    expect(routes).toHaveLength(12);
    expect(new Set(reachable(true))).toEqual(new Set(routes));
    expect(tree.entries.filter((entry) => entry.synthesised)).toEqual([]);
  });

  it('logged out, reaches only what works without a server', () => {
    expect(reachable(false).sort()).toEqual(['agent', 'android', 'deploy', 'login', 'node', 'status']);
  });

  it('does not login-gate the entries shown logged out', () => {
    for (const route of ['login', 'agent', 'node', 'deploy', 'status', 'android']) {
      expect(tuiRouteRequiresLogin(route, tree), route).toBe(false);
    }
    for (const route of ['inbox', 'runs', 'fleet', 'jobs', 'invoke', 'logout']) {
      expect(tuiRouteRequiresLogin(route, tree), route).toBe(true);
    }
  });

  it('gives every group a subtitle', () => {
    for (const node of HEXACTRA_TUI_MENU) {
      if (node.kind === 'section') expect(node.subtitle, node.id).toBeTruthy();
    }
  });

  it('says under the root what logging in shows, and nothing once logged in', () => {
    const footnote = getTuiRootMenuSlots().footnote;
    const context = { columns: 80, sectionId: 'root', state: {} };
    expect(resolveTuiMenuSlot(footnote, { ...context, loggedIn: false })).toEqual([...LOGGED_OUT_FOOTNOTE]);
    expect(resolveTuiMenuSlot(footnote, { ...context, loggedIn: true })).toEqual([]);
    // The menu truncates each line, never wraps: every line fits a 40-column terminal's frame.
    for (const line of LOGGED_OUT_FOOTNOTE) expect(line.length).toBeLessThanOrEqual(36);
  });
});
