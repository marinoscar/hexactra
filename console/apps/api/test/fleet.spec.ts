import { BadGatewayException, ConflictException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';

import { FabricError, type FabricClient } from '../src/fabric/fabric.client';
import { FleetService, agentUrlFor } from '../src/fleet/fleet.service';

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
      profiles: [
        { name: 'default', running: false },
        { name: 'travel', running: true },
      ],
    });
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
