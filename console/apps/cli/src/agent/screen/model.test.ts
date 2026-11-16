// The Agent screen's dashboard model (#374).
import { describe, expect, it } from 'vitest';

import type { AgentStatus, UnattendedStatus } from '../agent.js';
import { actions, checkLine, health, panels } from './model.js';

const agent = (active = 'active', online = true): AgentStatus => ({
  installed: true,
  activeBundle: 'b',
  state: { name: 'mini-pc', agentUrl: 'https://c/fabric', browser: '/x', maxBrowsers: 1, version: '1.2.0', commit: 'abcdef1234', hostId: '0123456789abcdef', browserKind: 'chrome-for-testing', chromeVersion: '142', service: true, installedAt: '', updatedAt: '' },
  service: { active, sub: active === 'active' ? 'running' : 'dead' },
  fleet: { id: 'h', name: 'mini-pc', online, browserConnected: online },
  fleetError: null,
});
const node = (units: Record<string, string>): UnattendedStatus => ({
  installed: true,
  state: { hostId: 'fedcba9876543210', name: 'mini-pc', agentUrl: 'u', display: 90, maxBrowsers: 1, resolution: '1920x1080', gpu: null, bundle: 'b', installedAt: '', updatedAt: '' },
  units,
});
const none: AgentStatus = { installed: false, state: null, activeBundle: null, service: null, fleet: null, fleetError: null };

describe('the dashboard', () => {
  it('guides a machine with nothing installed to Install', () => {
    expect(panels(none, { installed: false, state: null, units: {} })[0]!.title).toBe('Not set up');
    expect(actions(none, null).map((a) => a.id)).toEqual(['install', 'doctor', 'chrome']);
  });

  it('shows the agent, Fleet and the unattended node with tones', () => {
    const ps = panels(agent('failed', false), node({ 'hexactra-desktop.service': 'active', 'hexactra-node-agent.service': 'failed' }));
    expect(ps.map((p) => p.title)).toEqual(['Agent · this user', 'Unattended node · its own desktop', 'Fleet']);
    expect(ps[0]!.rows.find((r) => r.label === 'Service')).toMatchObject({ value: 'failed (dead)', tone: 'error' });
    expect(ps[1]!.rows.find((r) => r.label === 'Graphics')).toMatchObject({ tone: 'warning' });
    expect(ps[1]!.rows.find((r) => r.label === 'node-agent')).toMatchObject({ value: 'failed', tone: 'error' });
    expect(ps[2]!.rows[0]).toMatchObject({ value: 'offline', tone: 'error' });
  });

  it('offers only the actions that fit the state', () => {
    const ids = actions(agent('active'), node({ a: 'active' })).map((a) => a.id);
    expect(ids).toEqual(['install', 'update', 'service', 'restart', 'node-service', 'node-restart', 'logs', 'doctor', 'chrome', 'uninstall']);
    expect(actions(agent('active'), null).find((a) => a.id === 'service')!.label).toBe('Stop the agent');
    expect(actions(agent('inactive'), null).find((a) => a.id === 'service')!.label).toBe('Start the agent');
    const keys = actions(agent('active'), node({ a: 'active' })).map((a) => a.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('summarises the doctor, problems first', () => {
    const h = health([
      { name: 'system', ok: true, detail: 'linux/x64' },
      { name: 'graphics', ok: true, warning: true, detail: 'software' },
      { name: 'desktop-input', ok: false, detail: 'missing xdotool' },
    ])!;
    expect(h).toMatchObject({ ok: 1, warn: 1, fail: 1 });
    expect(h.problems.map((c) => c.name)).toEqual(['desktop-input', 'graphics']);
    expect(checkLine(h.problems[0]!)).toMatchObject({ tone: 'error', text: expect.stringMatching(/^✗ desktop-input/) });
    expect(health(null)).toBeNull();
  });
});
