// The host conformance kit: a host runs `runStoreConformance` against its `ProcedureStorePort` binding (in its own jest suite) to prove the
// port's guarantees. It uses jest's globals (`describe`, `it`, `expect`, `beforeEach`), like the harness's `runHarnessHostConformance`.
import type { ProcedureStorePort } from '../ports';
import { aProcedure, aVersion, call, T0 } from './builders';

export interface StoreHost {
  name: string;
  /**
   * A fresh store, the owners it may use (two distinct ids that exist in the host's user table), and `task(owner, key)`: the id of a task
   * of that owner for a test key (a host with real task rows creates one; the in-memory store returns the key).
   */
  open(): Promise<{ store: ProcedureStorePort; owners: [string, string]; task(owner: string, key: string): Promise<string>; close(): Promise<void> }>;
}

declare const describe: (name: string, fn: () => void) => void;
declare const it: (name: string, fn: () => Promise<void>) => void;
declare const beforeEach: (fn: () => Promise<void>) => void;
declare const afterEach: (fn: () => Promise<void>) => void;
declare const expect: (v: unknown) => {
  toBe(x: unknown): void;
  toEqual(x: unknown): void;
  toBeNull(): void;
  toHaveLength(n: number): void;
  rejects: { toThrow(): Promise<void> };
};

export function runStoreConformance(host: StoreHost): void {
  let ctx: Awaited<ReturnType<StoreHost['open']>>;
  beforeEach(async () => {
    ctx = await host.open();
  });
  afterEach(async () => {
    await ctx.close();
  });

  describe(`procedure store conformance: ${host.name}`, () => {
    it('stores and reads a procedure and its versions, newest first', async () => {
      const [a] = ctx.owners;
      await ctx.store.putProcedure(aProcedure({ id: 'kgc-p1', owner: a, task: await ctx.task(a, 'kgc-t1') }));
      await ctx.store.putVersion(a, aVersion([call('c1', 'navigate')], { id: 'kgc-v1', procedure: 'kgc-p1', number: 1 }));
      await ctx.store.putVersion(a, aVersion([call('c1', 'navigate')], { id: 'kgc-v2', procedure: 'kgc-p1', number: 2, parent: 'kgc-v1' }));
      expect((await ctx.store.findProcedureForTask(a, await ctx.task(a, 'kgc-t1')))?.id).toBe('kgc-p1');
      expect((await ctx.store.listVersions(a, 'kgc-p1')).map((v) => v.id)).toEqual(['kgc-v2', 'kgc-v1']);
      expect((await ctx.store.getVersion(a, 'kgc-v1'))?.steps[0]?.id).toBe('c1');
    });

    it('isolates owners: another owner reads nothing and changes nothing', async () => {
      const [a, b] = ctx.owners;
      await ctx.store.putProcedure(aProcedure({ id: 'kgc-p2', owner: a, task: await ctx.task(a, 'kgc-t2') }));
      await ctx.store.putVersion(a, aVersion([call('c1', 'navigate')], { id: 'kgc-v3', procedure: 'kgc-p2' }));
      expect(await ctx.store.getProcedure(b, 'kgc-p2')).toBeNull();
      expect(await ctx.store.getVersion(b, 'kgc-v3')).toBeNull();
      expect(await ctx.store.listProcedures(b)).toHaveLength(0);
      expect(await ctx.store.setVersionState(b, 'kgc-v3', 'candidate', 'verified')).toBe(false);
      await expect(ctx.store.putVersion(b, aVersion([call('c1', 'navigate')], { id: 'kgc-v4', procedure: 'kgc-p2' }))).rejects.toThrow();
      expect(await ctx.store.deleteAll(b)).toBe(0);
      expect((await ctx.store.getVersion(a, 'kgc-v3'))?.state).toBe('candidate');
    });

    it('keeps versions immutable and moves state by compare-and-set along allowed transitions only', async () => {
      const [a] = ctx.owners;
      await ctx.store.putProcedure(aProcedure({ id: 'kgc-p3', owner: a, task: await ctx.task(a, 'kgc-t3') }));
      await ctx.store.putVersion(a, aVersion([call('c1', 'navigate')], { id: 'kgc-v5', procedure: 'kgc-p3' }));
      await expect(ctx.store.putVersion(a, aVersion([call('c1', 'click')], { id: 'kgc-v5', procedure: 'kgc-p3' }))).rejects.toThrow();
      expect(await ctx.store.setVersionState(a, 'kgc-v5', 'candidate', 'active')).toBe(false);
      expect(await ctx.store.setVersionState(a, 'kgc-v5', 'verified', 'active')).toBe(false);
      expect(await ctx.store.setVersionState(a, 'kgc-v5', 'candidate', 'verified')).toBe(true);
      expect(await ctx.store.setVersionState(a, 'kgc-v5', 'candidate', 'verified')).toBe(false);
      expect((await ctx.store.getVersion(a, 'kgc-v5'))?.state).toBe('verified');
    });

    it('records evidence per version and per step', async () => {
      const [a] = ctx.owners;
      await ctx.store.putProcedure(aProcedure({ id: 'kgc-p4', owner: a, task: await ctx.task(a, 'kgc-t4') }));
      await ctx.store.putVersion(a, aVersion([call('c1', 'navigate')], { id: 'kgc-v6', procedure: 'kgc-p4' }));
      await ctx.store.recordEvidence(a, 'kgc-v6', 'c1', 'success', T0);
      const e = await ctx.store.recordEvidence(a, 'kgc-v6', null, 'failure', T0);
      expect([e.successes, e.failures]).toEqual([1, 1]);
      expect((await ctx.store.getVersion(a, 'kgc-v6'))?.stepEvidence['c1']?.successes).toBe(1);
    });

    it('deletes everything learned for one owner only', async () => {
      const [a, b] = ctx.owners;
      await ctx.store.putProcedure(aProcedure({ id: 'kgc-p5', owner: a, task: await ctx.task(a, 'kgc-t5') }));
      await ctx.store.putProcedure(aProcedure({ id: 'kgc-p6', owner: b, task: await ctx.task(b, 'kgc-t6') }));
      await ctx.store.putVersion(a, aVersion([call('c1', 'navigate')], { id: 'kgc-v7', procedure: 'kgc-p5' }));
      expect(await ctx.store.deleteAll(a)).toBe(1);
      expect(await ctx.store.getVersion(a, 'kgc-v7')).toBeNull();
      expect((await ctx.store.getProcedure(b, 'kgc-p6'))?.id).toBe('kgc-p6');
    });
  });
}
