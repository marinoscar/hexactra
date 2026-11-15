import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { CredentialsService } from '@marinoscar/platform-api/credentials';
import type { DoctorCheckRegistry, EgressRegistry } from '@marinoscar/platform-api/doctor';

import { FabricClient, FabricError } from '../src/fabric/fabric.client';
import {
  FabricEventsCheck,
  FabricHostsCheck,
  FabricReachableCheck,
  FabricTokenCheck,
} from '../src/fabric/fabric.doctor-checks';
import { FabricEgressContributor } from '../src/fabric/fabric.egress';
import { putFabricConnectionSchema } from '../src/fabric/fabric.schemas';

const TOKEN = 'hxs_test-token-not-real';

/** A stand-in fabric: health, hosts (bearer-checked) and the event stream. */
function fakeFabric(hosts: unknown[] = []): Promise<{ url: string; server: Server; seen: IncomingMessage[] }> {
  const seen: IncomingMessage[] = [];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    seen.push(req);
    if (req.url === '/v1/health') {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ status: 'ok', version: '9.9.9' }));
      return;
    }
    if (req.headers.authorization !== `Bearer ${TOKEN}`) {
      res.writeHead(401, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'unauthorized', message: 'missing or invalid bearer token' }));
      return;
    }
    if (req.url === '/v1/hosts') {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ hosts }));
      return;
    }
    if (req.url === '/v1/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(': keep-alive\n\n');
      return;
    }
    res.writeHead(404).end();
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, server, seen })),
  );
}

function credentials(values: Record<string, string | null>): CredentialsService {
  return { getSecret: jest.fn(async (_p: string, name: string) => values[name] ?? null) } as unknown as CredentialsService;
}

const registry = { register: jest.fn() } as unknown as DoctorCheckRegistry;

function checks(client: FabricClient) {
  return {
    reachable: new FabricReachableCheck(registry, client),
    token: new FabricTokenCheck(registry, client),
    hosts: new FabricHostsCheck(registry, client),
    events: new FabricEventsCheck(registry, client),
  };
}

describe('the fabric connection', () => {
  let servers: Server[] = [];
  afterEach(() => {
    for (const s of servers) {
      s.closeAllConnections();
      s.close();
    }
    servers = [];
  });

  it('fails every Doctor check with the fix while unconfigured', async () => {
    const c = checks(new FabricClient(credentials({})));
    for (const check of Object.values(c)) {
      const out = await check.run();
      expect(out.status).toBe('fail');
      expect(out.remedy).toMatch(/Administration → Fabric connection/);
      expect(check.settingsPath).toBe('/admin/settings/fabric');
    }
  });

  it('passes against a healthy fabric and sends the token and trace context', async () => {
    const f = await fakeFabric([{ id: 'h1', name: 'vps', online: true, profiles: ['default'], running_profiles: [] }]);
    servers.push(f.server);
    const client = new FabricClient(credentials({ url: `${f.url}/`, token: TOKEN }));
    const c = checks(client);
    expect((await c.reachable.run()).status).toBe('pass');
    expect((await c.token.run()).status).toBe('pass');
    const hosts = await c.hosts.run();
    expect(hosts).toMatchObject({ status: 'pass', data: { hosts: 1, online: 1 } });
    expect((await c.events.run()).status).toBe('pass');
    const authed = f.seen.find((r) => r.url === '/v1/hosts');
    expect(authed?.headers.authorization).toBe(`Bearer ${TOKEN}`);
  });

  it('reports a wrong token, no online hosts and an unreachable fabric with remedies', async () => {
    const f = await fakeFabric([{ id: 'h1', name: 'vps', online: false, profiles: [], running_profiles: [] }]);
    servers.push(f.server);
    const wrong = checks(new FabricClient(credentials({ url: f.url, token: 'hxs_wrong' })));
    const token = await wrong.token.run();
    expect(token.status).toBe('fail');
    expect(token.remedy).toMatch(/service token/);
    expect(JSON.stringify(token)).not.toContain('hxs_wrong');

    const ok = checks(new FabricClient(credentials({ url: f.url, token: TOKEN })));
    const hosts = await ok.hosts.run();
    expect(hosts.status).toBe('warn');
    expect(hosts.remedy).toMatch(/hexactra-agent/);

    const down = checks(new FabricClient(credentials({ url: 'http://127.0.0.1:1', token: TOKEN })));
    const reach = await down.reachable.run();
    expect(reach.status).toBe('fail');
    expect(reach.remedy).toMatch(/reachable from the console/);
    expect((await down.token.run()).status).toBe('skip');
  });

  it('raises typed errors and never puts the token in a message', async () => {
    const f = await fakeFabric();
    servers.push(f.server);
    const client = new FabricClient(credentials({ url: f.url, token: 'hxs_nope' }));
    const err = await client.hosts().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FabricError);
    expect((err as FabricError).kind).toBe('unauthorized');
    expect((err as FabricError).message).not.toContain('hxs_nope');
    const none = await new FabricClient(credentials({})).hosts().catch((e: unknown) => e);
    expect((none as FabricError).kind).toBe('not_configured');
  });

  it('declares the fabric host as an egress dependency, without the path or token', async () => {
    const egress = { register: jest.fn() } as unknown as EgressRegistry;
    const c = new FabricEgressContributor(egress, new FabricClient(credentials({ url: 'http://fabric-control:8787/base', token: TOKEN })));
    const [dep] = await c.describe();
    expect(dep).toMatchObject({ id: 'fabric.control', enabled: true, hosts: ['fabric-control'], scope: 'private', required: true });
    expect(JSON.stringify(dep)).not.toContain(TOKEN);
  });

  it('accepts only plain http(s) URLs', () => {
    expect(putFabricConnectionSchema.safeParse({ url: 'http://fabric-control:8787' }).success).toBe(true);
    for (const url of ['ftp://x', 'https://user:pw@x.test', 'https://x.test/?a=1', 'not a url']) {
      expect(putFabricConnectionSchema.safeParse({ url }).success).toBe(false);
    }
  });
});
