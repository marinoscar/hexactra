// The Agent screen's dashboard, as plain data (#374): what the panels show,
// how healthy the machine is, and which actions make sense right now. The
// screen only renders it, so this file is where the behaviour is tested.
import type { TuiTone } from '@marinoscar/platform-cli/tui/ui';

import type { AgentStatus, DoctorCheck, UnattendedStatus } from '../agent.js';

export interface PanelRow {
  label: string;
  value: string;
  tone?: TuiTone;
}

export interface Panel {
  title: string;
  rows: PanelRow[];
}

export interface Health {
  ok: number;
  warn: number;
  fail: number;
  /** The failing checks first, then warnings: what to fix. */
  problems: DoctorCheck[];
}

export type ActionId =
  | 'install'
  | 'update'
  | 'service'
  | 'restart'
  | 'node-service'
  | 'node-restart'
  | 'logs'
  | 'doctor'
  | 'chrome'
  | 'uninstall'
  | 'refresh'
  | 'back';

export interface Action {
  id: ActionId;
  /** The hotkey, also shown in the menu. */
  key: string;
  label: string;
  hint?: string;
}

const short = (id: string) => id.slice(0, 8);
const unitTone = (s: string): TuiTone => (s === 'active' ? 'success' : s === 'activating' || s === 'reloading' ? 'warning' : 'error');

/** The panels: this user's agent, the unattended node, Fleet. */
export function panels(status: AgentStatus | null, node: UnattendedStatus | null): Panel[] {
  const out: Panel[] = [];
  const st = status?.state;
  if (status?.installed && st) {
    const browser =
      st.browserKind === 'chrome-for-testing'
        ? `Chrome for Testing ${st.chromeVersion ?? ''}`.trim()
        : st.browserKind === 'google-chrome'
          ? `Google Chrome ${st.chromeVersion ?? ''}`.trim()
          : st.browser;
    const active = status.service?.active;
    out.push({
      title: st.attended ? 'Agent · attended (your Chrome and desktop)' : 'Agent · this user',
      rows: [
        { label: 'Host', value: `${st.name} (${short(st.hostId)})` },
        { label: 'Version', value: `${st.version} (${st.commit.slice(0, 7)})` },
        { label: 'Browser', value: browser + (st.sandboxHelper ? ' · setuid sandbox' : '') },
        st.service
          ? { label: 'Service', value: `${active ?? 'unknown'} (${status.service?.sub ?? 'unknown'})`, tone: unitTone(active ?? '') }
          : { label: 'Service', value: 'none: run `hexactra agent run`', tone: 'warning' },
      ],
    });
  }
  if (node?.state) {
    const s = node.state;
    out.push({
      title: 'Unattended node · its own desktop',
      rows: [
        { label: 'Host', value: `${s.name} (${short(s.hostId)})` },
        { label: 'Desktop', value: `:${s.display} ${s.resolution} · user hexactra` },
        { label: 'Graphics', value: s.gpu ? `${s.gpu.driver} (${s.gpu.renderNode})` : 'software rendering', tone: s.gpu ? 'success' : 'warning' },
        ...Object.entries(node.units).map(([unit, state]) => ({ label: unit.replace('hexactra-', '').replace('.service', ''), value: state, tone: unitTone(state) })),
      ],
    });
  }
  if (status?.installed) {
    const f = status.fleet;
    out.push({
      title: 'Fleet',
      rows: f
        ? [
            { label: 'Host', value: f.online ? 'online' : 'offline', tone: f.online ? 'success' : 'error' },
            { label: 'Browser', value: f.browserConnected ? 'extension connected' : 'extension not connected', tone: f.browserConnected ? 'success' : 'warning' },
          ]
        : [{ label: 'Host', value: status.fleetError ?? 'unknown (log in to see Fleet)', tone: 'warning' }],
    });
  }
  if (out.length === 0) {
    out.push({
      title: 'Not set up',
      rows: [
        { label: 'Agent', value: 'not installed on this machine', tone: 'dim' },
        { label: 'Next', value: 'Install… sets it up: pick a mode, review what it needs, go', tone: 'info' },
      ],
    });
  }
  return out;
}

/** Doctor counts and the problems to show first. */
export function health(checks: readonly DoctorCheck[] | null): Health | null {
  if (!checks) return null;
  const fail = checks.filter((c) => !c.ok);
  const warn = checks.filter((c) => c.ok && c.warning);
  return { ok: checks.length - fail.length - warn.length, warn: warn.length, fail: fail.length, problems: [...fail, ...warn] };
}

/** The actions that make sense in this state, in menu order. */
export function actions(status: AgentStatus | null, node: UnattendedStatus | null): Action[] {
  const agent = !!status?.installed;
  const nodeInstalled = !!node?.state;
  const anything = agent || nodeInstalled;
  const a: Action[] = [{ id: 'install', key: 'i', label: anything ? 'Install or repair…' : 'Install…', hint: 'pick a mode, review what it needs, install' }];
  if (anything) a.push({ id: 'update', key: 'u', label: 'Update', hint: 'latest agent, missing packages, restart' });
  if (agent && status?.state?.service) {
    const active = status.service?.active === 'active';
    a.push({ id: 'service', key: 's', label: active ? 'Stop the agent' : 'Start the agent' }, { id: 'restart', key: 'r', label: 'Restart the agent' });
  }
  if (nodeInstalled) {
    const allActive = Object.values(node!.units).every((u) => u === 'active');
    a.push({ id: 'node-service', key: 'n', label: allActive ? 'Stop the unattended node' : 'Start the unattended node' }, { id: 'node-restart', key: 'e', label: 'Restart the unattended node' });
  }
  if (anything) a.push({ id: 'logs', key: 'l', label: 'Logs', hint: 'live, agent or unattended node' });
  a.push(
    { id: 'doctor', key: 'd', label: 'Doctor and dependencies', hint: 'every check, every package, install what is missing' },
    { id: 'chrome', key: 'c', label: 'Google Chrome setup', hint: 'Chrome, the extension policy, the native host' },
  );
  if (anything) a.push({ id: 'uninstall', key: 'x', label: 'Uninstall…' });
  // Refresh (g) and Back (q, esc) are hotkeys in the hint line, not menu rows: the dashboard has to fit a 24-row terminal.
  return a;
}

/** A doctor check as a display line: icon, name, detail. */
export function checkLine(c: DoctorCheck, nameWidth = 16): { text: string; tone: TuiTone } {
  const icon = !c.ok ? '✗' : c.warning ? '!' : '✓';
  return { text: `${icon} ${c.name.padEnd(nameWidth)} ${c.detail}`, tone: !c.ok ? 'error' : c.warning ? 'warning' : 'success' };
}

/** The name column for a set of checks. */
export function checkNameWidth(checks: readonly DoctorCheck[] | null): number {
  return Math.max(12, ...(checks ?? []).map((c) => c.name.length));
}
