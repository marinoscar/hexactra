// E46.3 (#777): the Knowledge Graph's gate and its migration, without a database.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { KgraphEnabledService } from '../src/kgraph/kgraph-enabled.service';
import { KGRAPH_SYSTEM_DEFAULTS, KGRAPH_USER_DEFAULTS, readKgraphSystemSettings, readKgraphUserSettings } from '../src/kgraph/kgraph.settings';

function gate(o: { deployment?: boolean; user?: boolean; mode?: string | null; throwOn?: 'system' | 'user' | 'task' }) {
  const prisma = {
    userSettings: { findUnique: async () => { if (o.throwOn === 'user') throw new Error('db down'); return { value: { kgraph: { enabled: o.user ?? true } } }; } },
    forUser: () => ({ kgTaskSettings: { findFirst: async () => { if (o.throwOn === 'task') throw new Error('db down'); return o.mode === null ? null : { mode: o.mode ?? 'reuse' }; } } }),
  };
  const systemSettings = { getNamespace: async () => { if (o.throwOn === 'system') throw new Error('db down'); return { ...KGRAPH_SYSTEM_DEFAULTS, enabled: o.deployment ?? true }; } };
  return new KgraphEnabledService(prisma as never, systemSettings as never);
}
const taskRun = { userId: 'u1', taskId: 't1', run: { isTaskRun: true } };

describe('KgraphEnabledService.modeFor', () => {
  it('is the task mode when every level allows it', async () => {
    expect(await gate({}).modeFor(taskRun)).toBe('reuse');
    expect(await gate({ mode: 'learn' }).modeFor(taskRun)).toBe('learn');
  });
  it.each([
    ['the deployment is off', { deployment: false }, taskRun],
    ['the user is off', { user: false }, taskRun],
    ['the task is off', { mode: 'off' }, taskRun],
    ['the task has no row', { mode: null }, taskRun],
    ['the stored mode is unknown', { mode: 'turbo' }, taskRun],
    ['a chat run', {}, { ...taskRun, run: { isTaskRun: false } }],
    ['a run with no task', {}, { ...taskRun, taskId: null }],
    ['a run flagged AI only', {}, { ...taskRun, run: { isTaskRun: true, aiOnly: true } }],
    ['the system settings read throws', { throwOn: 'system' as const }, taskRun],
    ['the user settings read throws', { throwOn: 'user' as const }, taskRun],
    ['the task mode read throws', { throwOn: 'task' as const }, taskRun],
  ])('is off when %s', async (_why, o, input) => {
    expect(await gate(o as never).modeFor(input as never)).toBe('off');
  });
});

describe('the kgraph settings', () => {
  it('are off by default at the deployment and the user level', () => {
    expect(KGRAPH_SYSTEM_DEFAULTS).toEqual({ enabled: false, auditEvery: 10, suspendAfterFailures: 3, retentionDays: null, pacing: 'human' });
    expect(KGRAPH_USER_DEFAULTS).toEqual({ enabled: false });
    expect(readKgraphSystemSettings(undefined).enabled).toBe(false);
    expect(readKgraphSystemSettings({ enabled: 'yes', auditEvery: -1 })).toEqual(KGRAPH_SYSTEM_DEFAULTS);
    expect(readKgraphUserSettings(null)).toEqual({ enabled: false });
    expect(readKgraphUserSettings({ kgraph: { enabled: true } })).toEqual({ enabled: true });
  });
});

describe('the kgraph migrations', () => {
  const dir = join(__dirname, '..', 'prisma', 'migrations');
  const kg = readdirSync(dir).filter((d) => /_kgraph/.test(d)).sort();
  it('exist and sort after every earlier migration', () => {
    expect(kg.length).toBeGreaterThanOrEqual(1);
    const all = readdirSync(dir).filter((d) => /^\d{14}_/.test(d)).sort();
    expect(all.slice(-kg.length)).toEqual(kg);
  });
  it.each(kg)('%s creates or indexes kg_ tables only', (folder) => {
    const sql = readFileSync(join(dir, folder, 'migration.sql'), 'utf8');
    const statements = sql.split(';').map((s) => s.replace(/--.*$/gm, '').trim()).filter(Boolean);
    expect(statements.length).toBeGreaterThan(0);
    for (const s of statements) {
      const target = /^(?:CREATE TABLE|CREATE (?:UNIQUE )?INDEX "[^"]+" ON|ALTER TABLE)\s+"([^"]+)"/.exec(s)?.[1];
      expect({ statement: s.slice(0, 80), target: target?.startsWith('kg_') ? 'kg_' : target }).toEqual({ statement: s.slice(0, 80), target: 'kg_' });
      expect(s).not.toMatch(/\b(DROP|RENAME|ALTER COLUMN)\b/);
    }
    // An ALTER TABLE only adds a constraint to a new table (its foreign keys).
    for (const s of statements.filter((x) => x.startsWith('ALTER TABLE'))) expect(s).toMatch(/^ALTER TABLE "kg_[a-z_]+" ADD CONSTRAINT/);
  });
});
