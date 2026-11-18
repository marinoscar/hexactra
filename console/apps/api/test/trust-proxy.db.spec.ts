// TRUST_PROXY (#530), against a real database and the whole app built by
// createApp: behind the stack's nginx (a private peer) the API keys its
// per-address limits on the forwarded caller address by default, so two
// callers get two unauthenticated MCP buckets; with TRUST_PROXY=false every
// caller shares nginx's bucket. A public peer is never trusted, so it cannot
// pick its bucket with X-Forwarded-For.
import { randomUUID } from 'node:crypto';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { SystemSettingsService } from '@marinoscar/platform-api/settings';

import { createApp } from '../src/main';
import { McpSettingsReader } from '../src/mcp/mcp-settings.reader';
import { PrismaService } from '../src/prisma/prisma.service';

const LIMIT = 5;
const stamp = randomUUID().slice(0, 8);
const workerMode = process.env.JOBS_WORKER_MODE;
const trustProxyEnv = process.env.TRUST_PROXY;
let app: NestFastifyApplication | undefined;
let adminId: string;

/** A fresh documentation address (RFC 5737) per call, so runs never share a bucket. */
let octet = Math.floor(Math.random() * 100);
const freshPublic = () => `203.0.113.${(octet++ % 250) + 1}`;
const freshPrivatePeer = () => `172.18.${Math.floor(Math.random() * 250) + 1}.${Math.floor(Math.random() * 250) + 1}`;

async function boot(trustProxy: string | undefined): Promise<NestFastifyApplication> {
  if (trustProxy === undefined) delete process.env.TRUST_PROXY;
  else process.env.TRUST_PROXY = trustProxy;
  process.env.JOBS_WORKER_MODE = 'off';
  const a = await createApp();
  await a.init();
  await a.getHttpAdapter().getInstance().ready();
  return a;
}

async function setUnauthLimit(a: NestFastifyApplication, limit: number) {
  await a.get(SystemSettingsService).patchSettings({ mcp: { rateLimitUnauthenticated: limit } } as never, adminId);
  a.get(McpSettingsReader).invalidate();
}

/** An unauthenticated MCP call from `peer` (the TCP address), forwarded for `forwardedFor` when given. */
async function probe(a: NestFastifyApplication, peer: string, forwardedFor?: string): Promise<number> {
  const res = await a.inject({
    method: 'POST',
    url: '/api/mcp',
    remoteAddress: peer,
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': '2025-06-18',
      ...(forwardedFor ? { 'x-forwarded-for': forwardedFor } : {}),
    },
    payload: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  });
  return res.statusCode;
}

async function exhaust(a: NestFastifyApplication, peer: string, forwardedFor?: string) {
  for (let i = 0; i < LIMIT; i++) expect(await probe(a, peer, forwardedFor)).toBe(401);
  expect(await probe(a, peer, forwardedFor)).toBe(429);
}

async function shutdown() {
  if (!app) return;
  try {
    await setUnauthLimit(app, 30);
  } finally {
    await app.close();
    app = undefined;
  }
}

beforeAll(async () => {
  app = await boot(undefined);
  const email = `trust-proxy-admin-${stamp}@example.test`;
  await app.inject({ method: 'POST', url: '/api/auth/test/login', payload: { email, role: 'admin' } });
  adminId = (await app.get(PrismaService).user.findUniqueOrThrow({ where: { email }, select: { id: true } })).id;
}, 120_000);

afterAll(async () => {
  await shutdown();
  if (workerMode === undefined) delete process.env.JOBS_WORKER_MODE;
  else process.env.JOBS_WORKER_MODE = workerMode;
  if (trustProxyEnv === undefined) delete process.env.TRUST_PROXY;
  else process.env.TRUST_PROXY = trustProxyEnv;
});

describe('TRUST_PROXY unset (the default: loopback and private ranges)', () => {
  it('two callers forwarded by a private peer (the stack\'s nginx) get separate unauthenticated MCP buckets', async () => {
    await setUnauthLimit(app!, LIMIT);
    const nginx = freshPrivatePeer();
    const a = freshPublic();
    const b = freshPublic();
    await exhaust(app!, nginx, a);
    // Another caller through the same nginx still has its own budget.
    expect(await probe(app!, nginx, b)).toBe(401);
    // A chain is walked from the right: a spoofed first entry does not move the caller out of its bucket.
    expect(await probe(app!, nginx, `${freshPublic()}, ${a}`)).toBe(429);
  });

  it('a public peer is not trusted: its X-Forwarded-For does not choose its bucket', async () => {
    await setUnauthLimit(app!, LIMIT);
    const peer = freshPublic();
    for (let i = 0; i < LIMIT; i++) expect(await probe(app!, peer, freshPublic())).toBe(401);
    expect(await probe(app!, peer, freshPublic())).toBe(429);
  });
});

describe('TRUST_PROXY=false', () => {
  beforeAll(async () => {
    await shutdown();
    app = await boot('false');
  }, 120_000);

  it('every caller behind the same peer shares one bucket', async () => {
    await setUnauthLimit(app!, LIMIT);
    const nginx = freshPrivatePeer();
    await exhaust(app!, nginx, freshPublic());
    expect(await probe(app!, nginx, freshPublic())).toBe(429);
  });
});
