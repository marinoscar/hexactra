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

describe('KgraphEnabledService.everydayFor (E46.28)', () => {
  function everydayGate(o: { deployment?: boolean; user?: boolean; everyday?: boolean; throwOn?: 'system' | 'user' }, add = jest.fn()) {
    const prisma = { userSettings: { findUnique: async () => { if (o.throwOn === 'user') throw new Error('db down'); return { value: { kgraph: { enabled: o.user ?? true, ...(o.everyday === undefined ? {} : { everyday: o.everyday }) } } }; } } };
    const systemSettings = { getNamespace: async () => { if (o.throwOn === 'system') throw new Error('db down'); return { ...KGRAPH_SYSTEM_DEFAULTS, enabled: o.deployment ?? true }; } };
    return new KgraphEnabledService(prisma as never, systemSettings as never, { add } as never);
  }
  it('is on only with the deployment, user and everyday switches on, for a run that is not a saved task\'s', async () => {
    expect(await everydayGate({ everyday: true }).everydayFor('u1', { isTaskRun: false })).toBe(true);
    expect((await everydayGate({ everyday: true }).status('u1')).everyday).toBe(true);
  });
  it.each([
    ['everyday was never set', {}, false],
    ['everyday is off', { everyday: false }, false],
    ['the user switch is off', { everyday: true, user: false }, false],
    ['the deployment is off', { everyday: true, deployment: false }, false],
    ["it is a saved task's run", { everyday: true }, true],
    ['the system settings read throws', { everyday: true, throwOn: 'system' as const }, false],
    ['the user settings read throws', { everyday: true, throwOn: 'user' as const }, false],
  ])('is off when %s', async (_why, o, isTaskRun) => {
    expect(await everydayGate(o as never).everydayFor('u1', { isTaskRun })).toBe(false);
  });
  it('counts an error as app.kgraph.errors{stage} with a bounded label, and never throws', () => {
    const add = jest.fn();
    const g = everydayGate({}, add);
    g.countError('match');
    g.countError('anything' as never);
    expect(add.mock.calls).toEqual([['kgraphErrors', 1, { stage: 'match' }]]);
    expect(() => everydayGate({}, jest.fn(() => { throw new Error('metrics down'); })).countError('match')).not.toThrow();
  });
});

describe('the kgraph settings', () => {
  it('are off by default at the deployment and the user level', () => {
    expect(KGRAPH_SYSTEM_DEFAULTS).toEqual({ enabled: false, auditEvery: 10, suspendAfterFailures: 3, retentionDays: null, pacing: 'human' });
    expect(KGRAPH_USER_DEFAULTS).toEqual({ enabled: false });
    expect(readKgraphSystemSettings(undefined).enabled).toBe(false);
    expect(readKgraphSystemSettings({ enabled: 'yes', auditEvery: -1 })).toEqual(KGRAPH_SYSTEM_DEFAULTS);
    expect(readKgraphUserSettings(null)).toEqual({ enabled: false, everyday: false });
    expect(readKgraphUserSettings({ kgraph: { enabled: true } })).toEqual({ enabled: true, everyday: false });
    expect(readKgraphUserSettings({ kgraph: { enabled: true, everyday: true } })).toEqual({ enabled: true, everyday: true });
    expect(readKgraphUserSettings({ kgraph: { enabled: true, everyday: 'yes' } })).toEqual({ enabled: false, everyday: false });
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
  it.each(kg)('%s creates, indexes or extends kg_ tables only', (folder) => {
    const sql = readFileSync(join(dir, folder, 'migration.sql'), 'utf8');
    const statements = sql.split(';').map((s) => s.replace(/--.*$/gm, '').trim()).filter(Boolean);
    expect(statements.length).toBeGreaterThan(0);
    for (const s of statements) {
      const target = /^(?:CREATE TABLE|CREATE (?:UNIQUE )?INDEX "[^"]+" ON|ALTER TABLE)\s+"([^"]+)"/.exec(s)?.[1];
      expect({ statement: s.slice(0, 80), target: target?.startsWith('kg_') ? 'kg_' : target }).toEqual({ statement: s.slice(0, 80), target: 'kg_' });
      // Nothing is dropped or renamed. The one change to a column is relaxing NOT NULL on a kg_ column (E46.28: an everyday ledger row has no task).
      expect(s.replace(/ALTER COLUMN "[a-z_]+" DROP NOT NULL/, '')).not.toMatch(/\b(DROP|RENAME|ALTER COLUMN)\b/);
    }
    // An ALTER TABLE adds a constraint to a kg_ table (its foreign keys), adds a column with a default or nullable, or relaxes NOT NULL.
    // One statement may carry several clauses (`ADD COLUMN …,\nADD COLUMN …`, E46.32's two array columns): each is checked on its own.
    for (const s of statements.filter((x) => x.startsWith('ALTER TABLE'))) {
      const [, table, rest] = /^ALTER TABLE "([^"]+)" ([\s\S]+)$/.exec(s) ?? [];
      expect(table).toMatch(/^kg_[a-z_]+$/);
      for (const clause of (rest ?? '').split(/,\s*\n\s*/)) {
        expect(clause).toMatch(/^(ADD CONSTRAINT|ADD COLUMN "[a-z_]+" [A-Z0-9(), ]+(\[\])?( NOT NULL)?( DEFAULT .+)?$|ALTER COLUMN "[a-z_]+" DROP NOT NULL$)/);
        if (/ADD COLUMN/.test(clause) && /NOT NULL/.test(clause)) expect(clause).toMatch(/DEFAULT/);
      }
    }
  });
});
