// The Knowledge Graph's reads (E46.19, #793): procedures, versions, a readable diff, the Map's view model and how a run's steps ran. Every row
// is the caller's own (`forUser`, or `user_id` in the SQL of the two raw reads); another user's id is a 404 like a missing one. Every label
// passes the run trace's masking; a saved login is its label only; a sensitive parameter its name only; a literal is masked. Reads answer
// with the stored data and `enabled: false` while a switch is off: turning the feature off deletes and hides nothing.
//
// The map's read (storage load test, E46.4): one row per procedure with only what the map draws, its shown version's steps without their
// checks, guards and element references, and none of its screens or elements; above the node limit the view folds and pages.
import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { buildGraphView, diffVersions, emptyEvidence, healthOf, readableDiff, stepList, type DrawnVersion, type Evidence, type ExtraNode, type ProcedureVersion, type VersionState, type ViewNodeType } from '@marinoscar/hexactra-kgraph';

import { labelSlug, modelToolName } from '../connections/mcp/mcp-text';
import { PrismaService } from '../prisma/prisma.service';
import { readUsedSavedLogins } from '../runner/saved-logins';
import { maskSensitive } from '../tasks/mask';
import { KgraphEnabledService } from './kgraph-enabled.service';
import { PrismaProcedureStore } from './prisma-procedure-store';

const mask = (text: string): string => maskSensitive(text).text;
const LIST_LIMIT = 200;
/** Recent runs read for the saved logins the owner signs in with (the console does not list a provider's items). */
const LOGIN_RUNS = 200;
const notFound = () => new NotFoundException({ code: 'KGRAPH_PROCEDURE_NOT_FOUND', message: 'Procedure not found' });
const versionNotFound = () => new NotFoundException({ code: 'KGRAPH_VERSION_NOT_FOUND', message: 'Version not found' });

type ShownRow = { id: string; task_id: string; name: string; updated_at: Date; version_id: string | null; seq: number | null; state: string | null; steps: number | null };
type DrawnRow = { id: string; name: string; version_id: string | null; state: string | null; entry: string | null; steps: unknown; edges: unknown; sites: unknown; accounts: unknown; secret_refs: unknown; parameters: unknown; outputs: unknown };
type EvidenceRow = { versionId: string; stepId: string; successes: number; failures: number; repairs: number; lastSuccessAt: Date | null; lastFailureAt: Date | null };

const toEvidence = (e: EvidenceRow | undefined): Evidence | undefined =>
  e ? { successes: e.successes, failures: e.failures, repairs: e.repairs, lastSuccessAt: e.lastSuccessAt?.toISOString() ?? null, lastFailureAt: e.lastFailureAt?.toISOString() ?? null } : undefined;
const countsOf = (e: Evidence | undefined) => ({ successes: e?.successes ?? 0, failures: e?.failures ?? 0, repairs: e?.repairs ?? 0 });
const arr = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);

@Injectable()
export class KgraphReadService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly switches: KgraphEnabledService,
    private readonly store: PrismaProcedureStore,
  ) {}

  private db(userId: string) {
    return this.prisma.forUser({ userId });
  }

  private async enabled(userId: string): Promise<boolean> {
    return (await this.switches.status(userId)).available;
  }

  private async evidence(userId: string, versionIds: string[], stepsToo = false): Promise<EvidenceRow[]> {
    if (versionIds.length === 0) return [];
    return this.db(userId).kgEvidence.findMany({ where: { userId, versionId: { in: versionIds }, ...(stepsToo ? {} : { stepId: '' }) }, select: { versionId: true, stepId: true, successes: true, failures: true, repairs: true, lastSuccessAt: true, lastFailureAt: true } });
  }

  private async ledgerOf(userId: string, taskIds: string[]): Promise<Map<string, { runs: number; procedureRuns: number; cleanReplayRate: number | null }>> {
    const out = new Map<string, { runs: number; procedureRuns: number; cleanReplayRate: number | null }>();
    if (taskIds.length === 0) return out;
    const groups = await this.db(userId).kgLedger.groupBy({ by: ['taskId', 'outcome'], where: { userId, taskId: { in: taskIds } }, _count: { _all: true } });
    for (const id of taskIds) {
      const mine = groups.filter((g) => g.taskId === id);
      const runs = mine.reduce((n, g) => n + g._count._all, 0);
      const procedureRuns = mine.filter((g) => g.outcome !== 'ai_only').reduce((n, g) => n + g._count._all, 0);
      const clean = mine.find((g) => g.outcome === 'replayed_clean')?._count._all ?? 0;
      out.set(id, { runs, procedureRuns, cleanReplayRate: procedureRuns ? clean / procedureRuns : null });
    }
    return out;
  }

  /** Per procedure: its `everyday` ledger rows (chats and one-off runs in which one of its versions ran, E46.28). */
  private async everydayOf(userId: string, procedureIds: string[]): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    if (procedureIds.length === 0) return out;
    const db = this.db(userId);
    const versions = await db.kgProcedureVersion.findMany({ where: { userId, procedureId: { in: procedureIds } }, select: { id: true, procedureId: true } });
    if (versions.length === 0) return out;
    const owner = new Map(versions.map((v) => [v.id, v.procedureId]));
    const groups = await db.kgLedger.groupBy({ by: ['procedureVersionId'], where: { userId, mode: 'everyday', procedureVersionId: { in: [...owner.keys()] } }, _count: { _all: true } });
    for (const g of groups) {
      const pid = g.procedureVersionId ? owner.get(g.procedureVersionId) : undefined;
      if (pid) out.set(pid, (out.get(pid) ?? 0) + g._count._all);
    }
    return out;
  }

  private async taskNames(userId: string, ids: string[]): Promise<Map<string, string>> {
    return new Map((await this.db(userId).task.findMany({ where: { userId, id: { in: ids } }, select: { id: true, name: true } })).map((t) => [t.id, t.name]));
  }

  /** Each procedure with its shown version (the active one, else the newest) and that version's step count: no graph is read. */
  private async shown(userId: string, where: { taskId?: string; procedureId?: string }): Promise<ShownRow[]> {
    const filters = [Prisma.sql`p.user_id = ${userId}::uuid`];
    if (where.taskId) filters.push(Prisma.sql`p.task_id = ${where.taskId}::uuid`);
    if (where.procedureId) filters.push(Prisma.sql`p.id = ${where.procedureId}`);
    return this.prisma.$queryRaw<ShownRow[]>`
      SELECT p.id, p.task_id, p.name, p.updated_at, v.id AS version_id, v.seq, v.state, v.steps
      FROM kg_procedures p
      LEFT JOIN LATERAL (
        SELECT pv.id, pv.seq, pv.state, jsonb_array_length(COALESCE(pv.graph->'steps', '[]'::jsonb))::int AS steps
        FROM kg_procedure_versions pv WHERE pv.procedure_id = p.id AND pv.user_id = p.user_id
        ORDER BY (pv.id = p.active_version_id) DESC, pv.seq DESC LIMIT 1
      ) v ON true
      WHERE ${Prisma.join(filters, ' AND ')}
      ORDER BY p.updated_at DESC
      LIMIT ${LIST_LIMIT}`;
  }

  private async items(userId: string, rows: ShownRow[]) {
    const [names, ledger, ev, everyday] = await Promise.all([
      this.taskNames(userId, [...new Set(rows.map((r) => r.task_id))]),
      this.ledgerOf(userId, [...new Set(rows.map((r) => r.task_id))]),
      this.evidence(userId, rows.flatMap((r) => (r.version_id ? [r.version_id] : []))),
      this.everydayOf(userId, rows.map((r) => r.id)),
    ]);
    return rows
      .filter((r) => names.has(r.task_id))
      .map((r) => ({
        id: r.id,
        taskId: r.task_id,
        taskName: mask(names.get(r.task_id)!),
        name: mask(r.name),
        versionId: r.version_id,
        versionNumber: r.seq,
        state: (r.state as VersionState | null) ?? null,
        health: r.version_id ? healthOf(toEvidence(ev.find((e) => e.versionId === r.version_id)), r.state as VersionState) : ('unknown' as const),
        steps: r.steps ?? 0,
        updatedAt: r.updated_at.toISOString(),
        ledger: { ...(ledger.get(r.task_id) ?? { runs: 0, procedureRuns: 0, cleanReplayRate: null }), everydayRuns: everyday.get(r.id) ?? 0 },
      }));
  }

  /** `GET /api/kgraph/procedures`. */
  async procedures(userId: string, q: { taskId?: string; state?: string; q?: string }) {
    const [enabled, rows] = await Promise.all([this.enabled(userId), this.shown(userId, { taskId: q.taskId })]);
    let list = await this.items(userId, rows);
    if (q.state) list = list.filter((p) => p.state === q.state);
    if (q.q) {
      const words = q.q.toLowerCase().split(/\s+/);
      list = list.filter((p) => words.every((w) => `${p.name} ${p.taskName}`.toLowerCase().includes(w)));
    }
    return { enabled, procedures: list };
  }

  private versionDetail(v: ProcedureVersion) {
    return {
      id: v.id,
      number: v.number,
      state: v.state,
      changeClass: v.changeClass,
      parentId: v.parent,
      sourceRunId: v.sourceRun,
      createdAt: v.createdAt,
      health: healthOf(v.evidence, v.state),
      counts: countsOf(v.evidence),
      steps: stepList(v, mask),
      parameters: v.parameters.map((p) => ({ name: mask(p.name), type: p.type, sensitive: p.sensitive, required: p.required })),
      outputs: v.outputs.map((o) => ({ name: mask(o.name), sensitive: o.sensitive })),
      sites: v.sites.map((s) => s.domain),
      accounts: v.accounts.map((a) => ({ connectionId: a.connectionId, provider: a.provider })),
      savedLogins: v.secretRefs.map((r) => ({ kind: r.kind, label: mask(r.label) })),
    };
  }

  /** `GET /api/kgraph/procedures/{id}`: the shown version as an ordered step list. */
  async procedure(userId: string, id: string) {
    const [row] = await this.shown(userId, { procedureId: id });
    if (!row) throw notFound();
    const [item] = await this.items(userId, [row]);
    if (!item) throw notFound();
    const [enabled, version, versions] = await Promise.all([
      this.enabled(userId),
      row.version_id ? this.store.getVersion(userId, row.version_id) : Promise.resolve(null),
      this.db(userId).kgProcedureVersion.count({ where: { userId, procedureId: id } }),
    ]);
    return { ...item, enabled, activeVersion: version ? this.versionDetail(version) : null, versions };
  }

  private async ownProcedure(userId: string, id: string): Promise<void> {
    if (!(await this.db(userId).kgProcedure.findFirst({ where: { id, userId }, select: { id: true } }))) throw notFound();
  }

  /** `GET /api/kgraph/procedures/{id}/versions`: the history, without reading any graph beyond its step count. */
  async versions(userId: string, procedureId: string) {
    await this.ownProcedure(userId, procedureId);
    const rows = await this.prisma.$queryRaw<{ id: string; seq: number; state: string; change_class: string; parent_version_id: string | null; source_run_id: string | null; created_at: Date; steps: number }[]>`
      SELECT id, seq, state, change_class, parent_version_id, source_run_id, created_at, jsonb_array_length(COALESCE(graph->'steps', '[]'::jsonb))::int AS steps
      FROM kg_procedure_versions WHERE procedure_id = ${procedureId} AND user_id = ${userId}::uuid ORDER BY seq DESC LIMIT ${LIST_LIMIT}`;
    const [enabled, ev] = await Promise.all([this.enabled(userId), this.evidence(userId, rows.map((r) => r.id))]);
    return {
      enabled,
      procedureId,
      versions: rows.map((r) => {
        const e = toEvidence(ev.find((x) => x.versionId === r.id));
        return { id: r.id, number: r.seq, state: r.state as VersionState, changeClass: r.change_class as 'initial', parentId: r.parent_version_id, sourceRunId: r.source_run_id, createdAt: r.created_at.toISOString(), health: healthOf(e, r.state as VersionState), counts: countsOf(e), steps: r.steps };
      }),
    };
  }

  private async versionByNumber(userId: string, procedureId: string, n: number): Promise<ProcedureVersion> {
    const row = await this.db(userId).kgProcedureVersion.findFirst({ where: { userId, procedureId, seq: n }, select: { id: true } });
    const v = row ? await this.store.getVersion(userId, row.id) : null;
    if (!v) throw versionNotFound();
    return v;
  }

  /** `GET /api/kgraph/procedures/{id}/versions/{n}`. */
  async version(userId: string, procedureId: string, n: number) {
    await this.ownProcedure(userId, procedureId);
    const [enabled, v] = await Promise.all([this.enabled(userId), this.versionByNumber(userId, procedureId, n)]);
    return { enabled, procedureId, ...this.versionDetail(v) };
  }

  /** `GET /api/kgraph/procedures/{id}/versions/{n}/diff?against=`: against the given number, else the parent, else the version before. */
  async diff(userId: string, procedureId: string, n: number, against?: number) {
    await this.ownProcedure(userId, procedureId);
    const to = await this.versionByNumber(userId, procedureId, n);
    let from: ProcedureVersion | null = null;
    if (against !== undefined) from = await this.versionByNumber(userId, procedureId, against);
    else {
      from = to.parent ? await this.store.getVersion(userId, to.parent) : null;
      if (!from) {
        const before = await this.db(userId).kgProcedureVersion.findFirst({ where: { userId, procedureId, seq: { lt: n } }, orderBy: { seq: 'desc' }, select: { seq: true } });
        if (before) from = await this.versionByNumber(userId, procedureId, before.seq);
      }
    }
    const base = from ?? ({ ...to, steps: [], elements: [], secretRefs: [] } as unknown as ProcedureVersion);
    return { enabled: await this.enabled(userId), procedureId, from: from?.number ?? null, to: to.number, changes: readableDiff(diffVersions(base, to), mask) };
  }

  /** The owner's capabilities the map shows whether used or not: connected accounts, added MCP tools, and saved logins their runs signed in with. */
  private async extras(userId: string): Promise<ExtraNode[]> {
    const db = this.db(userId);
    const [connections, runs] = await Promise.all([
      db.connection.findMany({ where: { userId, status: { not: 'revoked' } }, select: { id: true, provider: true, label: true, mcpTools: { where: { mode: { not: 'off' } }, select: { name: true, title: true }, orderBy: { name: 'asc' } } }, orderBy: { connectedAt: 'asc' } }),
      db.run.findMany({ where: { userId, usedSavedLogins: { not: Prisma.DbNull } }, select: { usedSavedLogins: true }, orderBy: { createdAt: 'desc' }, take: LOGIN_RUNS }),
    ]);
    const out: ExtraNode[] = [];
    const taken = new Set<string>();
    for (const c of connections) {
      out.push({ type: 'Account', key: c.id, label: `${c.label} (${c.provider})` });
      // The name a run offers the model for the tool (the key a procedure's call step refers to it by).
      for (const t of c.mcpTools) out.push({ type: 'Tool', key: modelToolName(labelSlug(c.label), t.name, taken), label: t.title || t.name, account: c.id });
    }
    const logins = new Set<string>();
    for (const r of runs) for (const u of readUsedSavedLogins(r.usedSavedLogins)) logins.add(u.itemName);
    for (const label of logins) out.push({ type: 'SecretRef', key: `login:${label}`, label });
    return out;
  }

  /** `GET /api/kgraph/graph`: the Map's view model. */
  async graph(userId: string, q: { taskId?: string; site?: string; types?: ViewNodeType[]; cursor?: number }) {
    const filters = [Prisma.sql`p.user_id = ${userId}::uuid`];
    if (q.taskId) filters.push(Prisma.sql`p.task_id = ${q.taskId}::uuid`);
    const rows = await this.prisma.$queryRaw<DrawnRow[]>`
      SELECT p.id, p.name, v.id AS version_id, v.state, v.graph->>'entry' AS entry,
        (SELECT COALESCE(jsonb_agg(s - 'checks' - 'until' - 'guard' - 'output' - 'screen' - 'element'), '[]'::jsonb) FROM jsonb_array_elements(COALESCE(v.graph->'steps', '[]'::jsonb)) s) AS steps,
        (SELECT COALESCE(jsonb_agg(e), '[]'::jsonb) FROM jsonb_array_elements(COALESCE(v.graph->'edges', '[]'::jsonb)) e WHERE e->>'type' = 'then') AS edges,
        v.graph->'sites' AS sites, v.graph->'accounts' AS accounts, v.graph->'secretRefs' AS secret_refs, v.graph->'parameters' AS parameters, v.graph->'outputs' AS outputs
      FROM kg_procedures p
      LEFT JOIN LATERAL (
        SELECT pv.id, pv.state, pv.graph FROM kg_procedure_versions pv WHERE pv.procedure_id = p.id AND pv.user_id = p.user_id
        ORDER BY (pv.id = p.active_version_id) DESC, pv.seq DESC LIMIT 1
      ) v ON true
      WHERE ${Prisma.join(filters, ' AND ')}
      ORDER BY p.created_at ASC`;
    const ev = await this.evidence(userId, rows.flatMap((r) => (r.version_id ? [r.version_id] : [])), true);
    const procedures = rows.map((r) => {
      if (!r.version_id) return { id: r.id, name: r.name, version: null };
      const mine = ev.filter((e) => e.versionId === r.version_id);
      const stepEvidence: Record<string, Evidence> = {};
      for (const e of mine) if (e.stepId !== '') stepEvidence[e.stepId] = toEvidence(e)!;
      const version: DrawnVersion = {
        id: r.version_id,
        state: r.state as VersionState,
        ...(r.entry ? { entry: r.entry } : {}),
        steps: arr(r.steps),
        edges: arr(r.edges),
        sites: arr(r.sites),
        accounts: arr(r.accounts),
        secretRefs: arr(r.secret_refs),
        parameters: arr(r.parameters),
        outputs: arr(r.outputs),
        evidence: toEvidence(mine.find((e) => e.stepId === '')) ?? emptyEvidence(),
        stepEvidence,
      };
      return { id: r.id, name: r.name, version };
    });
    const [enabled, extras] = await Promise.all([this.enabled(userId), this.extras(userId)]);
    const view = buildGraphView({ procedures, extras, ...(q.types ? { types: q.types } : {}), ...(q.site ? { site: q.site } : {}), includeUnused: !q.taskId, ...(q.cursor !== undefined ? { cursor: q.cursor } : {}), mask });
    return { enabled, ...view };
  }

  /** `GET /api/kgraph/runs/{runId}`: which steps of the run were replayed, recovered, judged or done by the agent. */
  async run(userId: string, runId: string) {
    const [row] = await this.prisma.$queryRaw<{ id: string; task_id: string | null; replay: { version?: string; done?: unknown; handedOver?: boolean } | null }[]>`
      SELECT id, task_id, transcript->'kgraphReplay' AS replay FROM runs WHERE id = ${runId}::uuid AND user_id = ${userId}::uuid`;
    if (!row) throw new NotFoundException({ code: 'KGRAPH_RUN_NOT_FOUND', message: 'Run not found' });
    const db = this.db(userId);
    const [enabled, kg, ledger] = await Promise.all([this.enabled(userId), db.kgRun.findFirst({ where: { runId, userId } }), db.kgLedger.findFirst({ where: { runId, userId }, select: { stepsReplayed: true, stepsRecovered: true, stepsJudge: true, stepsAgent: true } })]);
    const version = kg?.procedureVersionId ? await this.store.getVersion(userId, kg.procedureVersionId) : null;
    // The site facts the run used (E46.32): ids on its kg_runs row; the owner's own facts only.
    const kgFactIds = kg?.factIds ?? [];
    const usedFacts = kgFactIds.length ? await db.kgSiteFact.findMany({ where: { userId, id: { in: kgFactIds } }, select: { id: true, site: true, kind: true, text: true } }) : [];
    const procedure = version ? await db.kgProcedure.findFirst({ where: { userId, id: version.procedure }, select: { name: true } }) : null;
    const replay = row.replay && row.replay.version === version?.id ? row.replay : null;
    const done = new Set(arr<string>(replay?.done));
    const recovered = version
      ? new Set((await db.kgNode.findMany({ where: { userId, type: 'FingerprintProposal', AND: [{ key: { startsWith: `${version.id}:` } }, { key: { endsWith: `:${runId}` } }] }, select: { key: true } })).map((n) => n.key.slice(version.id.length + 1, -(runId.length + 1))))
      : new Set<string>();
    const tookOver = replay?.handedOver === true || kg?.outcome === 'fell_back' || kg?.outcome === 'outcome_failed';
    const usedVersion = version && !kg?.aiOnly ? version : null;
    const steps = (usedVersion?.steps ?? []).map((s) => {
      const how = done.has(s.id) ? (s.kind === 'judge' ? 'judged' : s.kind === 'agent' ? 'agent' : recovered.has(s.id) ? 'recovered' : 'replayed') : tookOver ? 'agent' : 'not_reached';
      return { id: s.id, kind: s.kind, label: mask(s.label), tool: s.kind === 'call' ? s.tool : null, how: how as 'replayed' };
    });
    return {
      enabled,
      runId,
      taskId: row.task_id,
      mode: (kg?.mode ?? 'off') as 'off',
      aiOnly: kg?.aiOnly ?? false,
      outcome: kg?.outcome ?? null,
      procedureId: version?.procedure ?? null,
      procedureName: procedure ? mask(procedure.name) : null,
      versionId: version?.id ?? kg?.procedureVersionId ?? null,
      versionNumber: version?.number ?? null,
      steps,
      ledger: ledger ? { replayed: ledger.stepsReplayed, recovered: ledger.stepsRecovered, judge: ledger.stepsJudge, agent: ledger.stepsAgent } : null,
      kgFactIds,
      siteFacts: kgFactIds
        .map((id) => usedFacts.find((f) => f.id === id))
        .filter((f): f is (typeof usedFacts)[number] => Boolean(f)),
    };
  }
}
