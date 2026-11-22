// The host conformance kit: a host runs `runStoreConformance` against its `ProcedureStorePort` binding (in its own jest suite) to prove the
// port's guarantees. It uses jest's globals (`describe`, `it`, `expect`, `beforeEach`), like the harness's `runHarnessHostConformance`.
import type { ProcedureStorePort, SiteFactStorePort } from '../ports';
import type { NewSiteFact } from '../schema';
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

    it('activates one version atomically: the earlier active one retires, and a second activation of the same version changes nothing', async () => {
      const [a] = ctx.owners;
      await ctx.store.putProcedure(aProcedure({ id: 'kgc-p7', owner: a, task: await ctx.task(a, 'kgc-t7') }));
      await ctx.store.putVersion(a, aVersion([call('c1', 'navigate')], { id: 'kgc-v8', procedure: 'kgc-p7', number: 1 }));
      await ctx.store.putVersion(a, aVersion([call('c1', 'navigate')], { id: 'kgc-v9', procedure: 'kgc-p7', number: 2 }));
      expect(await ctx.store.activate(a, 'kgc-v8', 'candidate')).toBe(true);
      const race = await Promise.all([ctx.store.activate(a, 'kgc-v9', 'candidate'), ctx.store.activate(a, 'kgc-v9', 'candidate')]);
      expect(race.filter(Boolean)).toHaveLength(1);
      expect((await ctx.store.getVersion(a, 'kgc-v8'))?.state).toBe('retired');
      expect((await ctx.store.getVersion(a, 'kgc-v9'))?.state).toBe('active');
      expect((await ctx.store.getProcedure(a, 'kgc-p7'))?.activeVersion).toBe('kgc-v9');
      expect(await ctx.store.activate(a, 'kgc-v8', 'candidate')).toBe(false);
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

    it('lists active procedures by exact site: no subdomain, suffix or lookalike, no other state, no other owner', async () => {
      const [a, b] = ctx.owners;
      const site = (domain: string) => ({ sites: [{ id: `site:${domain}`, domain }] });
      const put = async (owner: string, p: string, v: string, domain: string, activate: boolean) => {
        await ctx.store.putProcedure(aProcedure({ id: p, owner, task: await ctx.task(owner, `${p}-t`) }));
        await ctx.store.putVersion(owner, aVersion([call('c1', 'navigate')], { id: v, procedure: p, ...site(domain) }));
        if (activate) expect(await ctx.store.activate(owner, v, 'candidate')).toBe(true);
      };
      await put(a, 'kgc-s2', 'kgc-sv2', 'bank.com', true);
      await put(a, 'kgc-s1', 'kgc-sv1', 'shop.co.uk', true);
      await put(a, 'kgc-s3', 'kgc-sv3', 'bank.com', false); // candidate only
      await put(a, 'kgc-s4', 'kgc-sv4', 'bank.com.evil.io', true); // a lookalike
      await put(a, 'kgc-s5', 'kgc-sv5', 'bank.com', true);
      expect(await ctx.store.setVersionState(a, 'kgc-sv5', 'active', 'suspended')).toBe(true);
      await put(b, 'kgc-s6', 'kgc-sv6', 'bank.com', true); // another owner's
      const found = await ctx.store.listActiveProceduresForSites(a, ['bank.com', 'shop.co.uk', 'example.org']);
      expect(found.map((x) => [x.procedure.id, x.version.id, x.version.state])).toEqual([
        ['kgc-s1', 'kgc-sv1', 'active'],
        ['kgc-s2', 'kgc-sv2', 'active'],
      ]);
      expect((await ctx.store.listActiveProceduresForSites(a, ['com'])).length).toBe(0);
      expect((await ctx.store.listActiveProceduresForSites(a, ['evil.io'])).length).toBe(0);
      expect((await ctx.store.listActiveProceduresForSites(a, ['co.uk'])).length).toBe(0);
      expect((await ctx.store.listActiveProceduresForSites(a, [])).length).toBe(0);
      expect((await ctx.store.listActiveProceduresForSites(b, ['shop.co.uk'])).length).toBe(0);
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

export interface SiteFactStoreHost {
  name: string;
  /** A fresh store and two distinct owners that exist in the host's user table. */
  open(): Promise<{ store: SiteFactStorePort; owners: [string, string]; close(): Promise<void> }>;
}

const T1 = '2026-01-02T00:00:00.000Z';
const aFact = (id: string, over: Partial<NewSiteFact> = {}): NewSiteFact => ({ id, site: 'example.com', kind: 'navigation', text: 'Invoices: Billing → History', source: 'derived', evidence: { runId: 'run-1', stepIds: ['s3', 's4'] }, createdAt: T0, ...over });

/** The guarantees of `SiteFactStorePort` (E46.30). A host runs it against its binding, in its own jest suite. */
export function runSiteFactStoreConformance(host: SiteFactStoreHost): void {
  let ctx: Awaited<ReturnType<SiteFactStoreHost['open']>>;
  beforeEach(async () => {
    ctx = await host.open();
  });
  afterEach(async () => {
    await ctx.close();
  });

  describe(`site fact store conformance: ${host.name}`, () => {
    it('stores a proposal as proposed, whatever its source, and reads it back with its evidence', async () => {
      const [a] = ctx.owners;
      const r = await ctx.store.proposeSiteFact(a, aFact('kgf-1', { source: 'owner' }));
      expect(r.created).toBe(true);
      expect(r.fact.status).toBe('proposed');
      const [f] = await ctx.store.listSiteFacts(a, ['example.com'], 'proposed');
      expect(f?.id).toBe('kgf-1');
      expect(f?.evidence).toEqual({ runId: 'run-1', stepIds: ['s3', 's4'] });
      expect(f?.lastUsedAt).toBeNull();
    });

    it('keeps one fact per identity: the same site, kind and normalised text is never proposed twice', async () => {
      const [a] = ctx.owners;
      await ctx.store.proposeSiteFact(a, aFact('kgf-2'));
      const again = await ctx.store.proposeSiteFact(a, aFact('kgf-3', { text: '  invoices: billing → history. ' }));
      expect(again.created).toBe(false);
      expect(again.fact.id).toBe('kgf-2');
      const other = await ctx.store.proposeSiteFact(a, aFact('kgf-4', { kind: 'other' }));
      expect(other.created).toBe(true);
      expect((await ctx.store.listSiteFacts(a, ['example.com'], ['proposed', 'active', 'archived'])).map((f) => f.id)).toEqual(['kgf-2', 'kgf-4']);
    });

    it('does not propose an archived fact again', async () => {
      const [a] = ctx.owners;
      await ctx.store.proposeSiteFact(a, aFact('kgf-5'));
      expect(await ctx.store.setSiteFactStatus(a, 'kgf-5', 'proposed', 'archived')).toBe(true);
      const again = await ctx.store.proposeSiteFact(a, aFact('kgf-6'));
      expect(again.created).toBe(false);
      expect(again.fact.status).toBe('archived');
      expect(await ctx.store.listSiteFacts(a, ['example.com'], 'proposed')).toHaveLength(0);
    });

    it('moves status by compare-and-set along allowed moves only', async () => {
      const [a] = ctx.owners;
      await ctx.store.proposeSiteFact(a, aFact('kgf-7'));
      expect(await ctx.store.setSiteFactStatus(a, 'kgf-7', 'active', 'archived')).toBe(false);
      expect(await ctx.store.setSiteFactStatus(a, 'kgf-7', 'proposed', 'active')).toBe(true);
      expect(await ctx.store.setSiteFactStatus(a, 'kgf-7', 'proposed', 'active')).toBe(false);
      expect(await ctx.store.setSiteFactStatus(a, 'kgf-7', 'active', 'proposed')).toBe(false);
      expect(await ctx.store.setSiteFactStatus(a, 'kgf-7', 'active', 'archived')).toBe(true);
      expect(await ctx.store.setSiteFactStatus(a, 'kgf-7', 'archived', 'active')).toBe(true);
      expect((await ctx.store.listSiteFacts(a, ['example.com'], 'active')).map((f) => f.id)).toEqual(['kgf-7']);
    });

    it('lists only the named sites and statuses, by site then creation time', async () => {
      const [a] = ctx.owners;
      await ctx.store.proposeSiteFact(a, aFact('kgf-8', { site: 'bank.co.uk', kind: 'sign_in', text: 'Sign-in asks for a one-time code', createdAt: T1 }));
      await ctx.store.proposeSiteFact(a, aFact('kgf-9', { site: 'bank.co.uk', kind: 'quirk', text: 'A cookie banner appears on first visit' }));
      await ctx.store.proposeSiteFact(a, aFact('kgf-10'));
      await ctx.store.proposeSiteFact(a, aFact('kgf-11', { site: 'other.org' }));
      expect((await ctx.store.listSiteFacts(a, ['example.com', 'bank.co.uk'], 'proposed')).map((f) => f.id)).toEqual(['kgf-9', 'kgf-8', 'kgf-10']);
      expect(await ctx.store.listSiteFacts(a, ['sub.example.com'], 'proposed')).toHaveLength(0);
      expect(await ctx.store.listSiteFacts(a, [], 'proposed')).toHaveLength(0);
      expect(await ctx.store.listSiteFacts(a, ['example.com'], 'active')).toHaveLength(0);
    });

    it("touches lastUsedAt of the owner's facts only", async () => {
      const [a, b] = ctx.owners;
      await ctx.store.proposeSiteFact(a, aFact('kgf-12'));
      expect(await ctx.store.touchSiteFacts(b, ['kgf-12'], T1)).toBe(0);
      expect(await ctx.store.touchSiteFacts(a, ['kgf-12', 'kgf-missing'], T1)).toBe(1);
      expect((await ctx.store.listSiteFacts(a, ['example.com'], 'proposed'))[0]?.lastUsedAt).toBe(T1);
    });

    it('isolates owners: another owner reads nothing, changes nothing and keeps its own facts', async () => {
      const [a, b] = ctx.owners;
      await ctx.store.proposeSiteFact(a, aFact('kgf-13'));
      expect(await ctx.store.listSiteFacts(b, ['example.com'], ['proposed', 'active', 'archived'])).toHaveLength(0);
      expect(await ctx.store.setSiteFactStatus(b, 'kgf-13', 'proposed', 'active')).toBe(false);
      const own = await ctx.store.proposeSiteFact(b, aFact('kgf-14'));
      expect(own.created).toBe(true);
      expect((await ctx.store.listSiteFacts(a, ['example.com'], 'proposed')).map((f) => f.id)).toEqual(['kgf-13']);
    });
  });
}
