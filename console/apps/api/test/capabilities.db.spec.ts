// Capability parity, REST and MCP side (packages/shared/capabilities.json):
// every capability's REST operations are in the served OpenAPI document,
// every app operation and every MCP tool belongs to a capability, and every
// surface either names where the capability lives or says why it does not.
import { CAPABILITIES, REST_EXEMPT, type CapabilitySurface } from '@app/shared';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';

import { createApp } from '../src/main';
import { MCP_TOOLS } from '../src/mcp/mcp.tools';

/** The path prefixes of this app's own controllers (the platform's are its own business). */
const APP_PREFIXES = ['/api/agent-policies', '/api/tasks', '/api/runs', '/api/chats', '/api/inbox', '/api/questions', '/api/schedules', '/api/browser', '/api/fleet', '/api/fabric', '/api/home', '/api/mcp', '/api/notification-actions', '/api/connected-apps', '/api/approval-rules', '/api/secrets', '/api/connections', '/api/delivery-recipients', '/api/deliveries', '/api/reports', '/api/mail-triggers', '/api/task-builder', '/api/benchmark-site', '/api/benchmarks', '/api/service-credentials', '/api/web-search'];
const values = (s: CapabilitySurface): readonly string[] => (typeof s === 'string' ? [s] : 'none' in s ? [] : s);

let app: NestFastifyApplication;
let operations: Set<string>;

// No job worker (as #889 did for android-push): this spec only reads the OpenAPI document. With the worker on, the app picked up jobs
// other specs left queued in the shared test database, and one still running when the app closed opened a database connection after
// Jest had torn this file down ("You are trying to `require` a file after the Jest environment has been torn down"), failing the run
// after every test had passed.
const workerMode = process.env.JOBS_WORKER_MODE;
beforeAll(async () => {
  process.env.JOBS_WORKER_MODE = 'off';
  app = await createApp();
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  const res = await app.inject({ method: 'GET', url: '/api/openapi.json' });
  expect(res.statusCode).toBe(200);
  const doc = JSON.parse(res.body) as { paths: Record<string, Record<string, unknown>> };
  operations = new Set();
  for (const [path, item] of Object.entries(doc.paths)) {
    for (const method of Object.keys(item)) {
      if (['get', 'post', 'put', 'patch', 'delete'].includes(method)) operations.add(`${method.toUpperCase()} ${path.startsWith('/api') ? path : `/api${path}`}`);
    }
  }
});
afterAll(async () => {
  await app?.close();
  if (workerMode === undefined) delete process.env.JOBS_WORKER_MODE;
  else process.env.JOBS_WORKER_MODE = workerMode;
});

describe('capability parity (REST, MCP)', () => {
  it('has unique ids, and every surface is a value or a reason', () => {
    const ids = CAPABILITIES.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const c of CAPABILITIES) {
      expect(c.rest.length).toBeGreaterThan(0);
      for (const s of [c.cli, c.mcp, c.tui, c.web]) {
        if (typeof s === 'object' && 'none' in s) expect(s.none.trim().length).toBeGreaterThan(10);
        else expect(values(s).length).toBeGreaterThan(0);
      }
    }
  });

  it('every capability is a documented REST operation', () => {
    const missing = CAPABILITIES.flatMap((c) => c.rest.filter((op) => !operations.has(op)).map((op) => `${c.id}: ${op}`));
    expect(missing).toEqual([]);
  });

  it('every app REST operation belongs to a capability (or is exempt with a reason)', () => {
    const covered = new Set([...CAPABILITIES.flatMap((c) => c.rest), ...Object.keys(REST_EXEMPT)]);
    const app = [...operations].filter((op) => APP_PREFIXES.some((p) => op.split(' ')[1]!.startsWith(p)));
    expect(app.length).toBeGreaterThan(20);
    expect(app.filter((op) => !covered.has(op))).toEqual([]);
  });

  it('every MCP tool belongs to a capability, and every named tool exists', () => {
    const tools = new Set(MCP_TOOLS.map((t) => t.name));
    const named = CAPABILITIES.flatMap((c) => values(c.mcp));
    expect(named.filter((n) => !tools.has(n))).toEqual([]);
    expect([...tools].filter((t) => !named.includes(t))).toEqual([]);
  });
});
