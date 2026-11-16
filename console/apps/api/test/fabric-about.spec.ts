import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { CredentialsService } from '@marinoscar/platform-api/credentials';
import { aboutContributorRegistry } from '@marinoscar/platform-api/host';

import { describeFabric, fabricAboutContributor, FabricAboutBinding } from '../src/fabric/fabric.about';
import { FabricClient } from '../src/fabric/fabric.client';

// The "Hexactra Fabric" section of Administration → About (#362): what the
// console reports about the control plane it drives, and what it never does.

const TOKEN = 'hxs_about-token-not-real';

const HOSTS = [
  { id: 'h1', name: 'home', version: '1.0.0', online: true, browser_connected: true, on_demand: false, profiles: [], running_profiles: [], last_seen: '' },
  { id: 'h2', name: 'lab', version: '1.0.0', online: true, browser_connected: false, on_demand: true, profiles: [], running_profiles: [], last_seen: '' },
  { id: 'h3', name: 'old', version: '0.9.0', online: false, browser_connected: false, on_demand: false, profiles: [], running_profiles: [], last_seen: '' },
];

function fakeFabric(): Promise<{ url: string; server: Server }> {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    if (req.url === '/v1/health') {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ status: 'ok', version: '9.9.9' }));
      return;
    }
    if (req.headers.authorization !== `Bearer ${TOKEN}`) {
      res.writeHead(401, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'unauthorized', message: 'missing or invalid bearer token' }));
      return;
    }
    if (req.url === '/v1/hosts') {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ hosts: HOSTS }));
      return;
    }
    res.writeHead(404).end();
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, server })),
  );
}

function credentials(values: Record<string, string | null>): CredentialsService {
  return { getSecret: jest.fn(async (_p: string, name: string) => values[name] ?? null) } as unknown as CredentialsService;
}

describe('the About page fabric section', () => {
  let server: Server | undefined;
  afterEach(() => new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve())));

  it('is registered with the platform at import time', () => {
    expect(aboutContributorRegistry.get('fabric')).toBe(fabricAboutContributor);
    expect(fabricAboutContributor.label).toBe('Hexactra Fabric');
  });

  it('says "not configured" before the app binds a client, and when no URL or token is set', async () => {
    expect(await describeFabric(null)).toEqual({ configured: false });
    expect(await describeFabric(new FabricClient(credentials({})))).toMatchObject({ configured: false });
  });

  it('reports the URL, the fabric version and the browser hosts, never the token', async () => {
    const f = await fakeFabric();
    server = f.server;
    const facts = await describeFabric(new FabricClient(credentials({ url: f.url, token: TOKEN })));
    expect(facts).toEqual({
      configured: true,
      url: f.url,
      reachable: true,
      version: '9.9.9',
      browserHosts: 3,
      browserHostsOnline: 2,
      browsersConnected: 1,
    });
    expect(JSON.stringify(facts)).not.toContain(TOKEN);
  });

  it('reports a refused token as a fact, not an error', async () => {
    const f = await fakeFabric();
    server = f.server;
    const facts = await describeFabric(new FabricClient(credentials({ url: f.url, token: 'hxs_wrong' })));
    expect(facts).toMatchObject({ configured: true, reachable: true, version: '9.9.9' });
    expect(facts.hostsError).toEqual(expect.any(String));
    expect(facts.browserHosts).toBeUndefined();
    expect(JSON.stringify(facts)).not.toContain('hxs_wrong');
  });

  it('reports an unreachable fabric without throwing', async () => {
    const facts = await describeFabric(new FabricClient(credentials({ url: 'http://127.0.0.1:1', token: TOKEN })));
    expect(facts).toMatchObject({ configured: true, reachable: false });
    expect(facts.error).toEqual(expect.any(String));
  });

  it('reaches the application client once bound, and lets go on shutdown', async () => {
    const client = new FabricClient(credentials({}));
    const binding = new FabricAboutBinding(client);
    binding.onModuleInit();
    await expect(fabricAboutContributor.describe()).resolves.toMatchObject({ configured: false, fix: expect.any(String) });
    binding.onModuleDestroy();
    await expect(fabricAboutContributor.describe()).resolves.toEqual({ configured: false });
  });
});
