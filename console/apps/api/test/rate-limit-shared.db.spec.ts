// One limit across API processes (#517), against a real database: two
// instances of the whole app (two API replicas in one jest process), both with
// `MCP_RATE_LIMIT_STORE=postgres`, enforce ONE shared limit: the limiter under
// concurrent hits from both, an authenticated MCP caller alternating between
// them, unauthenticated probes from one address, the OAuth server's limiter;
// and the cleanup job deletes only expired windows.
import { randomUUID } from 'node:crypto';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { OAuthRateLimitService, PatService } from '@marinoscar/platform-api/identity';
import { SystemSettingsService } from '@marinoscar/platform-api/settings';

import { createApp } from '../src/main';
import { McpSettingsReader } from '../src/mcp/mcp-settings.reader';
import { MCP_RATE_LIMITER, type McpRateLimiter } from '../src/mcp/mcp.rate-limit';
import { McpRateLimitPurgeHandler } from '../src/mcp/mcp.rate-limit.jobs';
import { PostgresRateLimiter } from '../src/mcp/mcp.rate-limit.pg';
import { PrismaService } from '../src/prisma/prisma.service';

let a: NestFastifyApplication;
let b: NestFastifyApplication;
let prisma: PrismaService;
let adminId: string;
const stamp = randomUUID().slice(0, 8);
const saved = { store: process.env.MCP_RATE_LIMIT_STORE, worker: process.env.JOBS_WORKER_MODE };
const DAY = 86_400_000;

async function boot(): Promise<NestFastifyApplication> {
  const app = await createApp();
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  return app;
}

async function setMcp(patch: Record<string, unknown>) {
  await a.get(SystemSettingsService).patchSettings({ mcp: patch } as never, adminId);
  a.get(McpSettingsReader).invalidate();
  b.get(McpSettingsReader).invalidate();
}

async function rpc(app: NestFastifyApplication, token: string, remoteAddress = '127.0.0.1') {
  const res = await app.inject({
    method: 'POST',
    url: '/api/mcp',
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-06-18' },
    payload: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    remoteAddress,
  });
  return { status: res.statusCode, headers: res.headers };
}

/** The MCP limits are per minute: start a sequence at least 5 s before a window turns over, so the weight of the previous window cannot free a slot mid-test. */
async function awayFromMinuteEdge(): Promise<void> {
  const left = 60_000 - (Date.now() % 60_000);
  if (left < 5_000) await new Promise((r) => setTimeout(r, left + 50));
}

async function login(email: string, role: 'contributor' | 'admin' = 'contributor') {
  const res = await a.inject({ method: 'POST', url: '/api/auth/test/login', payload: { email, role } });
  if (!res.headers.location) throw new Error(`login ${res.statusCode} ${res.body}`);
  const token = new URL(String(res.headers.location)).searchParams.get('token')!;
  const id = (await prisma.user.findUniqueOrThrow({ where: { email }, select: { id: true } })).id;
  return { token, id };
}

beforeAll(async () => {
  process.env.MCP_RATE_LIMIT_STORE = 'postgres';
  process.env.JOBS_WORKER_MODE = 'off';
  a = await boot();
  b = await boot();
  prisma = a.get(PrismaService);
  ({ id: adminId } = await login(`rl-shared-admin-${stamp}@example.test`, 'admin'));
}, 180_000);

afterAll(async () => {
  try {
    if (a) await setMcp({ rateLimitPerCredential: 120, rateLimitUnauthenticated: 30, rateLimitPerUser: 600 });
    await prisma?.rateLimitWindow.deleteMany({ where: { OR: [{ key: { contains: stamp } }, { key: { startsWith: 'unauth:' } }] } });
  } finally {
    await a?.close();
    await b?.close();
    for (const [k, v] of [['MCP_RATE_LIMIT_STORE', saved.store], ['JOBS_WORKER_MODE', saved.worker]] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

describe('two API processes share one limit (#517)', () => {
  it('each process has its own Postgres limiter instance', () => {
    const la = a.get<McpRateLimiter>(MCP_RATE_LIMITER);
    const lb = b.get<McpRateLimiter>(MCP_RATE_LIMITER);
    expect(la).toBeInstanceOf(PostgresRateLimiter);
    expect(lb).toBeInstanceOf(PostgresRateLimiter);
    expect(la).not.toBe(lb);
  });

  it('concurrent hits from both processes: exactly the limit is allowed', async () => {
    const key = `test:concurrent:${stamp}`;
    const la = a.get<McpRateLimiter>(MCP_RATE_LIMITER);
    const lb = b.get<McpRateLimiter>(MCP_RATE_LIMITER);
    const verdicts = await Promise.all(Array.from({ length: 40 }, (_, i) => (i % 2 ? la : lb).hit(key, 10, DAY)));
    expect(verdicts.filter((v) => v.allowed)).toHaveLength(10);
    for (const v of verdicts.filter((x) => !x.allowed)) expect(v.retryAfterS).toBeGreaterThan(0);
    // Refused hits are not counted: the row holds the allowed ones.
    const rows = await prisma.rateLimitWindow.findMany({ where: { key } });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.hits).toBe(10);
  });

  it('an authenticated MCP caller alternating between the processes meets one per-credential limit', async () => {
    await setMcp({ rateLimitPerCredential: 10, rateLimitPerUser: 600 });
    const u = await login(`rl-shared-pat-${stamp}@example.test`);
    await awayFromMinuteEdge();
    const pat = (await a.get(PatService).createToken(u.id, { name: `rl-${stamp}`, durationValue: 1, durationUnit: 'days' } as never)).token;
    for (let i = 0; i < 10; i++) expect((await rpc(i % 2 ? a : b, pat)).status).toBe(200);
    const over = await rpc(a, pat);
    expect(over.status).toBe(429);
    expect(Number(over.headers['retry-after'])).toBeGreaterThan(0);
    expect((await rpc(b, pat)).status).toBe(429);
  });

  it('unauthenticated probes from one address meet one limit across the processes', async () => {
    await setMcp({ rateLimitUnauthenticated: 5 });
    const addr = `203.0.113.${(parseInt(stamp.slice(0, 2), 16) % 200) + 20}`;
    await prisma.rateLimitWindow.deleteMany({ where: { key: `unauth:${addr}` } });
    await awayFromMinuteEdge();
    for (let i = 0; i < 5; i++) expect((await rpc(i % 2 ? a : b, '', addr)).status).toBe(401);
    expect((await rpc(a, '', addr)).status).toBe(429);
    expect((await rpc(b, '', addr)).status).toBe(429);
  });

  it('the OAuth server of both processes counts in the shared store', async () => {
    const key = `oauth:authorize:${stamp}`;
    const oa = a.get(OAuthRateLimitService, { strict: false });
    const ob = b.get(OAuthRateLimitService, { strict: false });
    expect((await oa.consume(key, 3, DAY)).allowed).toBe(true);
    expect((await ob.consume(key, 3, DAY)).allowed).toBe(true);
    expect((await oa.consume(key, 3, DAY)).allowed).toBe(true);
    const over = await ob.consume(key, 3, DAY);
    expect(over.allowed).toBe(false);
    expect(over.retryAfterSeconds).toBeGreaterThan(0);
    expect(await prisma.rateLimitWindow.count({ where: { key } })).toBe(1);
  });

  it('the cleanup job deletes the expired windows only', async () => {
    const now = new Date();
    await prisma.rateLimitWindow.createMany({
      data: [
        { key: `test:old:${stamp}`, windowMs: 60_000, windowStart: new Date(now.getTime() - 10 * 60_000), hits: 3, expiresAt: new Date(now.getTime() - 8 * 60_000) },
        { key: `test:live:${stamp}`, windowMs: 60_000, windowStart: new Date(now.getTime() - 60_000), hits: 3, expiresAt: new Date(now.getTime() + 60_000) },
      ],
    });
    expect(await b.get(McpRateLimitPurgeHandler).purge(now)).toBeGreaterThanOrEqual(1);
    expect(await prisma.rateLimitWindow.count({ where: { key: `test:old:${stamp}` } })).toBe(0);
    expect(await prisma.rateLimitWindow.count({ where: { key: `test:live:${stamp}` } })).toBe(1);
  });
});
