// The deploy's fabric connection (issue #309) against a real database and a
// stub fabric: missing, then connected after `connect`, then broken when the
// fabric refuses the token. The token never appears in a status.
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { CredentialsService } from '@marinoscar/platform-api/credentials';

import { FabricConnectService } from '../src/fabric/fabric-connect.service';
import { tokenFrom } from '../src/fabric/fabric-connect.cli';
import { FABRIC_CREDENTIAL_PURPOSE } from '../src/fabric/fabric.credentials';
import { createApp } from '../src/main';

const TOKEN = 'hxs_test0000000000000000000000';
let accepted = TOKEN;
let app: NestFastifyApplication;
let fabric: Server;
let fabricUrl: string;
let service: FabricConnectService;
let credentials: CredentialsService;

// Credentials are stored encrypted: a fixed test key (32 bytes, not a real secret).
const savedKey = process.env.SECRETS_ENCRYPTION_KEY;

beforeAll(async () => {
  process.env.SECRETS_ENCRYPTION_KEY ||= Buffer.alloc(32, 7).toString('base64');
  fabric = createServer((req, res) => {
    if (req.url === '/v1/health') return void res.writeHead(200, { 'content-type': 'application/json' }).end('{"status":"ok","version":"test"}');
    if (req.headers.authorization !== `Bearer ${accepted}`) return void res.writeHead(401).end('{"error":"unauthorized"}');
    if (req.url === '/v1/hosts') return void res.writeHead(200, { 'content-type': 'application/json' }).end('{"hosts":[]}');
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => fabric.listen(0, '127.0.0.1', resolve));
  fabricUrl = `http://127.0.0.1:${(fabric.address() as AddressInfo).port}`;
  app = await createApp();
  await app.init();
  service = app.get(FabricConnectService, { strict: false });
  credentials = app.get(CredentialsService, { strict: false });
  for (const name of ['url', 'token']) await credentials.deleteSecret(FABRIC_CREDENTIAL_PURPOSE.purpose, name);
});

afterAll(async () => {
  for (const name of ['url', 'token']) await credentials?.deleteSecret(FABRIC_CREDENTIAL_PURPOSE.purpose, name);
  await app?.close();
  await new Promise((r) => fabric?.close(r));
  if (savedKey === undefined) delete process.env.SECRETS_ENCRYPTION_KEY;
  else process.env.SECRETS_ENCRYPTION_KEY = savedKey;
});

describe('fabric connection for the deploy', () => {
  it('reports missing before anything is stored', async () => {
    expect(await service.status()).toMatchObject({ state: 'missing', url: null, tokenHint: null });
  });

  it('stores the URL and token and reports connected, without the token', async () => {
    const status = await service.connect(`${fabricUrl}/`, TOKEN);
    expect(status).toMatchObject({ state: 'connected', url: fabricUrl, error: null });
    expect(JSON.stringify(status)).not.toContain(TOKEN);
    expect(await credentials.getSecret(FABRIC_CREDENTIAL_PURPOSE.purpose, 'token')).toBe(TOKEN);
  });

  it('reports broken when the fabric refuses the stored token', async () => {
    accepted = 'hxs_another000000000000000000';
    const status = await service.status();
    expect(status.state).toBe('broken');
    expect(status.error).toMatch(/refused/);
    accepted = TOKEN;
  });

  it('refuses what is not a fabric URL or an hxs_ token', async () => {
    await expect(service.connect('fabric-control:8787', TOKEN)).rejects.toThrow(/Not a fabric URL/);
    await expect(service.connect(fabricUrl, 'operator-token')).rejects.toThrow(/hxs_/);
  });

  it('finds the token in the fabric CLI output piped to `set`', () => {
    expect(tokenFrom(`${TOKEN}\n(shown once; store it as the client's service token)\n`)).toBe(TOKEN);
    expect(tokenFrom('nothing here')).toBeNull();
  });
});
