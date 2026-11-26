import { BadGatewayException, ConflictException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';

import { FabricError, type FabricClient } from '../src/fabric/fabric.client';
import { FleetService, agentUrlFor, toHost } from '../src/fleet/fleet.service';
import { withoutSignin } from '../src/mcp/mcp.tools';

function fakeFabric(overrides: Partial<Record<'hosts' | 'request' | 'config', jest.Mock>> = {}) {
  const hosts = jest.fn().mockResolvedValue([
    {
      id: '11111111-1111-4111-8111-111111111111',
      name: 'vps',
      version: '0.1.0',
      online: true,
      browser_connected: false,
      on_demand: true,
      viewer_url: 'https://viewer.example.test/vnc.html',
      profiles: ['default', 'travel'],
      running_profiles: ['travel'],
      draining: true,
      last_seen: '2026-11-15T00:00:00Z',
    },
  ]);
  const request = jest.fn();
  const config = jest.fn().mockResolvedValue({ url: 'http://fabric-control:8787', token: 'hxs_x' });
  const fabric = { hosts, request, config, ...overrides } as unknown as FabricClient;
  return { fabric, hosts, request, config };
}

describe('FleetService', () => {
  it('maps hosts with running profiles and drain state', async () => {
    const { fabric } = fakeFabric();
    const [h] = await new FleetService(fabric).hosts();
    expect(h).toMatchObject({
      name: 'vps',
      onDemand: true,
      draining: true,
      viewerUrl: 'https://viewer.example.test/vnc.html',
      // An agent older than #336 reports neither.
      mode: null,
      desktop: false,
      profiles: [
        { name: 'default', running: false },
        { name: 'travel', running: true },
      ],
    });
  });

  it('maps each profile\'s sign-in status and full email (E48.1)', () => {
    const h = toHost({
      id: 'h3', name: 'node', version: '1', online: true, browser_connected: true, on_demand: true,
      profiles: ['default', 'travel', 'work', 'old'], running_profiles: ['work'], last_seen: '2026-11-15T00:00:00Z',
      profile_status: [
        { name: 'default', running: false, signin: 'signed_in', accounts: [{ provider: 'google', email: 'owner.full.name@example.com', state: 'signed_in' }], checked_at: '2026-11-25T10:00:00Z' },
        { name: 'travel', running: false, signin: 'expired', accounts: [{ provider: 'google', email: 'owner@example.com', state: 'expired' }], checked_at: '2026-11-25T10:00:00Z' },
        // A state this console does not know is unknown, never signed out.
        { name: 'work', running: true, signin: 'locked' as never, checked_at: null },
      ],
    });
    expect(h.profiles).toEqual([
      { name: 'default', running: false, signin: 'signed_in', accounts: [{ provider: 'google', email: 'owner.full.name@example.com', state: 'signed_in' }], checkedAt: '2026-11-25T10:00:00Z' },
      { name: 'travel', running: false, signin: 'expired', accounts: [{ provider: 'google', email: 'owner@example.com', state: 'expired' }], checkedAt: '2026-11-25T10:00:00Z' },
      { name: 'work', running: true, signin: 'unknown', accounts: [], checkedAt: null },
      // Not reported (an older agent or fabric): unknown.
      { name: 'old', running: false, signin: 'unknown', accounts: [], checkedAt: null },
    ]);
  });

  it('keeps sign-in status and emails out of the MCP hosts_list result', () => {
    const h = toHost({
      id: 'h4', name: 'node', version: '1', online: true, browser_connected: true, on_demand: true,
      profiles: ['default'], running_profiles: [], last_seen: '2026-11-15T00:00:00Z',
      profile_status: [{ name: 'default', running: false, signin: 'signed_in', accounts: [{ provider: 'google', email: 'owner@example.com', state: 'signed_in' }] }],
    });
    const out = withoutSignin(h) as { profiles: unknown[] };
    expect(out.profiles).toEqual([{ name: 'default', running: false }]);
    expect(JSON.stringify(out)).not.toContain('owner@example.com');
    // The host-level sign-in field stays on REST too (#998).
    expect(out).not.toHaveProperty('signinReporting');
  });

  it('says why a host may show no sign-in status (#998)', () => {
    const base = { id: 'h5', name: 'node', version: '1', online: true, browser_connected: true, on_demand: true, profiles: ['default', 'work'], running_profiles: [], last_seen: '2026-11-15T00:00:00Z' };
    // A fabric older than E48 sends no profile_status at all.
    expect(toHost(base).signinReporting).toBe('fabric_outdated');
    // A newer fabric whose node never reported: every profile unchecked.
    expect(toHost({ ...base, profile_status: [{ name: 'default', running: false, signin: 'unknown', checked_at: null }] }).signinReporting).toBe('not_reported');
    // One profile checked is enough.
    expect(toHost({ ...base, profile_status: [{ name: 'default', running: false, signin: 'signed_in', accounts: [{ provider: 'google', email: 'a@example.com', state: 'signed_in' }], checked_at: '2026-11-26T18:00:00Z' }] }).signinReporting).toBe('ok');
    // A host with no profiles has nothing to report.
    expect(toHost({ ...base, profiles: [], profile_status: [] }).signinReporting).toBe('ok');
  });

  it('maps the host mode and desktop capability', async () => {
    const { fabric, hosts } = fakeFabric();
    hosts.mockResolvedValue([
      { id: 'h2', name: 'mini-pc', version: '0.3.0', online: true, browser_connected: false, on_demand: true, mode: 'unattended', desktop: true, profiles: [], running_profiles: [], last_seen: '2026-11-15T00:00:00Z' },
    ]);
    const [h] = await new FleetService(fabric).hosts();
    expect(h).toMatchObject({ name: 'mini-pc', mode: 'unattended', desktop: true });
  });

  it('enrolls with a single-use token and a ready-to-run agent command', async () => {
    const { fabric, request } = fakeFabric();
    request.mockResolvedValue({ enrollment: { expires_at: '2026-11-15T01:00:00Z' }, enrollment_token: 'hxe_abc' });
    const saved = process.env.APP_URL;
    process.env.APP_URL = 'https://console.example.test/';
    try {
      const e = await new FleetService(fabric).enroll({ name: 'home pc', ttlMinutes: 30 });
      expect(request).toHaveBeenCalledWith('POST', '/v1/admin/hosts/enrollments', { body: { name: 'home pc', ttl_s: 1800 } });
      // The bundled fabric is private: a new host reaches it over the console's TLS vhost.
      expect(e.command).toBe("hexactra-agent daemon --url https://console.example.test/fabric --enrollment-token hxe_abc --name 'home pc'");
      expect(e.agentUrl).toBe('https://console.example.test/fabric');
    } finally {
      if (saved === undefined) delete process.env.APP_URL;
      else process.env.APP_URL = saved;
    }
    const viaTailnet = await new FleetService(fabric).enroll({ agentUrl: 'https://fabric.example.test' });
    expect(viaTailnet.command).toContain('--url https://fabric.example.test');
  });

  it('gives new hosts the public /fabric URL only for the bundled fabric', () => {
    expect(agentUrlFor('http://fabric-control:8787', 'https://console.example.test')).toBe('https://console.example.test/fabric');
    expect(agentUrlFor('http://fabric-control:8787/', 'https://console.example.test/')).toBe('https://console.example.test/fabric');
    // An operator's own fabric is used as it is, and without APP_URL nothing is guessed.
    expect(agentUrlFor('https://fabric.example.test', 'https://console.example.test')).toBe('https://fabric.example.test');
    expect(agentUrlFor('http://fabric-control:8787', undefined)).toBe('http://fabric-control:8787');
  });

  it('runs host commands and turns a failed command into a 409 with the reason', async () => {
    const { fabric, request } = fakeFabric();
    const svc = new FleetService(fabric);
    request.mockResolvedValueOnce({ id: 'c1', host_id: 'h', command: { type: 'create_profile', profile: 'work' }, state: 'succeeded', created_at: 't' });
    await expect(svc.command('h', { type: 'create_profile', profile: 'work' })).resolves.toMatchObject({ kind: 'create_profile', profile: 'work', state: 'succeeded' });
    expect(request.mock.calls[0][2].body).toEqual({ command: { type: 'create_profile', profile: 'work' }, timeout_ms: 90000 });

    request.mockResolvedValueOnce({ id: 'c2', host_id: 'h', command: { type: 'close_browser', profile: 'default' }, state: 'failed', error: 'close_browser: this host attaches to a Chrome you run yourself', created_at: 't' });
    await expect(svc.command('h', { type: 'close_browser', profile: 'default' })).rejects.toBeInstanceOf(ConflictException);
  });

  it('maps fabric failures to clear HTTP errors', async () => {
    const svc = (err: FabricError) => new FleetService(fakeFabric({ hosts: jest.fn().mockRejectedValue(err) }).fabric);
    await expect(svc(new FabricError('not_configured', 'x')).hosts()).rejects.toBeInstanceOf(ServiceUnavailableException);
    await expect(svc(new FabricError('unreachable', 'x')).hosts()).rejects.toBeInstanceOf(BadGatewayException);
    await expect(svc(new FabricError('unauthorized', 'x', 401)).hosts()).rejects.toBeInstanceOf(BadGatewayException);
    await expect(svc(new FabricError('api', 'host not found', 404)).hosts()).rejects.toBeInstanceOf(NotFoundException);
    await expect(new FleetService(fakeFabric().fabric).host('nope')).rejects.toBeInstanceOf(NotFoundException);
  });
});
