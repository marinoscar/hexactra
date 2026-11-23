// Site facts (phase 5, E46.31; docs/decisions/knowledge-graph.md, "Site facts"). A fact is DATA about one site, never an instruction or a
// permission. Only the owner's own act makes one `active`: typing it (POST, active at once), approving a proposal in Reviews, signed in, in
// the console, or their opt-in `kgraph.autoApproveFacts` (E46.36), which covers ONLY a newly derived fact (from server records) of kind
// navigation, timing or quirk that passes the validator. Derived proposals (after a learn, reuse or everyday run, from server-recorded facts)
// and the agent's proposals (`propose_site_fact`) are stored `proposed`; sign-in facts, agent proposals and imported facts always wait. A declined proposal is archived and its identity is not proposed again for 30 days; one the owner archived is never
// proposed again. No fact holds Secret Material: `validateSiteFact` with the console's secret check refuses it (`422`).
import { randomUUID } from 'node:crypto';

import { ConflictException, ForbiddenException, Injectable, Logger, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import {
  deriveSiteFacts,
  registrableDomain,
  siteFactKey,
  siteFactsNamed,
  type InputSiteFact,
  SITE_FACT_KINDS,
  SITE_FACT_SOURCES,
  validateSiteFact,
  type Element,
  type InterruptFiring,
  type SiteFactKind,
  type SiteFactProposal,
  type SiteFactSource,
  type SiteTraceEvent,
  type TraceBinding,
  hostAndPath,
} from '@marinoscar/hexactra-kgraph';
import type { SiteFactProposalOutcome } from '@marinoscar/hexactra-kgraph/harness';

import { PrismaService } from '../prisma/prisma.service';
import { maskSensitive } from '../tasks/mask';
import { RUN_SURFACE_NODE, type RunSurfaceProps } from '../runner/host/kgraph/observer-port';
import { KgraphEnabledService } from './kgraph-enabled.service';
import { consoleSecretCheck, PrismaSiteFactStore, type SiteFactRow } from './prisma-site-fact-store';
import { DECLINE_SUPPRESS_MS } from './reviews.service';

/** The kg_nodes type of an interrupt handler that fired during a replay (E46.15), kept for the derive step. Ids and kinds only. */
export const INTERRUPT_FIRING_NODE = 'InterruptFiring';

/** At most this many facts in an export or an import file. */
export const SITE_FACT_TRANSFER_LIMIT = 500;

/** The kinds the owner's opt-in auto-approve covers (E46.36). `sign_in` and `other` always wait for the owner. */
export const AUTO_APPROVE_KINDS: ReadonlySet<SiteFactKind> = new Set<SiteFactKind>(['navigation', 'timing', 'quirk']);

/**
 * Whether a proposal may be made active by the owner's opt-in auto-approve (E46.36): its source is `derived` (read from server records,
 * never the agent's, an MCP client's or an import file's text), its kind is navigation, timing or quirk, and it passes the validator (the
 * secret and instruction rules). Only the derive step calls it; an import or an agent proposal never reaches it.
 */
export function autoApprovable(p: SiteFactProposal): boolean {
  return p.source === 'derived' && AUTO_APPROVE_KINDS.has(p.kind) && validateSiteFact(p, { secretCheck: consoleSecretCheck }).length === 0;
}

/** How an active or archived fact was approved; null while it is a proposal or after the owner declined it. */
export function approvedByOf(r: Pick<SiteFactRow, 'status' | 'declinedAt' | 'approvedBy'>): 'owner' | 'auto' | null {
  if (r.status === 'proposed' || r.declinedAt) return null;
  return r.approvedBy === 'auto' ? 'auto' : 'owner';
}

/** A fact as the routes show it. */
export function siteFactView(r: SiteFactRow) {
  const ev = (r.evidence ?? {}) as { runId?: string; stepIds?: string[]; screenIds?: string[] };
  return {
    id: r.id,
    site: r.site,
    kind: r.kind,
    text: r.text,
    source: r.source,
    status: r.status,
    approvedBy: approvedByOf(r),
    evidence: { runId: ev.runId ?? null, steps: ev.stepIds?.length ?? 0, screens: ev.screenIds?.length ?? 0 },
    declinedAt: r.declinedAt?.toISOString() ?? null,
    lastUsedAt: r.lastUsedAt?.toISOString() ?? null,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

/** One fact of an export file: no id, no evidence, no status. */
export interface ExportedSiteFact {
  site: string;
  kind: SiteFactKind;
  text: string;
  source: SiteFactSource;
}

export type ProposeResult = SiteFactProposalOutcome | 'refused';

const NOT_FOUND = () => new NotFoundException({ code: 'KGRAPH_SITE_FACT_NOT_FOUND', message: 'Site fact not found' });

@Injectable()
export class KgraphSiteFactsService {
  private readonly log = new Logger(KgraphSiteFactsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly store: PrismaSiteFactStore,
    private readonly enabled: KgraphEnabledService,
  ) {}

  private db(userId: string) {
    return this.prisma.forUser({ userId });
  }

  /** `422 KGRAPH_SITE_FACT_REFUSED` with the rules a fact broke (never its text). */
  private validate(p: SiteFactProposal): void {
    const violations = validateSiteFact(p, { secretCheck: consoleSecretCheck });
    if (violations.length === 0) return;
    const rules = [...new Set(violations.map((v) => v.rule))];
    throw new UnprocessableEntityException({ code: 'KGRAPH_SITE_FACT_REFUSED', message: violations.map((v) => v.message).join('; '), details: { rules } });
  }

  private async requireOn(userId: string): Promise<void> {
    const status = await this.enabled.status(userId);
    if (!status.available) throw new ConflictException({ code: 'KGRAPH_OFF', message: status.deployment ? 'Turn on the Knowledge Graph in your settings first' : 'The Knowledge Graph is turned off by your administrator' });
  }

  private async own(userId: string, id: string): Promise<SiteFactRow> {
    const r = await this.db(userId).kgSiteFact.findFirst({ where: { id, userId } });
    if (!r) throw NOT_FOUND();
    return r;
  }

  private async audit(userId: string, action: string, id: string, meta: Record<string, unknown>): Promise<void> {
    await this.prisma.auditEvent.create({ data: { actorUserId: userId, action, targetType: 'kgraph_site_fact', targetId: id, meta: meta as Prisma.InputJsonValue } }).catch(() => undefined);
  }

  /**
   * Store a derived, agent or imported proposal as `proposed`. Never active. `refused` when it breaks a rule; `suppressed` when the owner
   * declined the same identity in the last 30 days; `known` when the owner already has it (whatever its status: one the owner archived is
   * never proposed again). A decline older than 30 days lapses: the archived row goes and the identity may be proposed again.
   */
  async propose(userId: string, p: SiteFactProposal, now = new Date()): Promise<ProposeResult> {
    return (await this.proposeRow(userId, p, now)).result;
  }

  /** `propose`, with the stored fact's id when a new proposal was created. */
  private async proposeRow(userId: string, p: SiteFactProposal, now: Date): Promise<{ result: ProposeResult; id?: string }> {
    if (validateSiteFact(p, { secretCheck: consoleSecretCheck }).length > 0) return { result: 'refused' };
    const identity = siteFactKey(p);
    const existing = await this.db(userId).kgSiteFact.findFirst({ where: { userId, identity } });
    if (existing) {
      if (existing.status !== 'archived' || !existing.declinedAt) return { result: 'known' };
      if (existing.declinedAt.getTime() > now.getTime() - DECLINE_SUPPRESS_MS) return { result: 'suppressed' };
      await this.db(userId).kgSiteFact.deleteMany({ where: { id: existing.id, userId, status: 'archived' } });
    }
    const r = await this.store.proposeSiteFact(userId, { ...p, id: `kgsf-${randomUUID()}`, createdAt: now.toISOString() });
    return r.created ? { result: 'proposed', id: r.fact.id } : { result: 'known' };
  }

  /**
   * The owner's opt-in auto-approve (E46.36) for one proposal the derive step just created: `proposed` → `active`, `approvedBy: auto`, in one
   * conditional write, audited. Only an `autoApprovable` proposal reaches it. Returns whether the fact moved.
   */
  private async autoApprove(userId: string, id: string, p: SiteFactProposal): Promise<boolean> {
    if (!autoApprovable(p)) return false;
    const moved = await this.db(userId).kgSiteFact.updateMany({ where: { id, userId, status: 'proposed', source: 'derived' }, data: { status: 'active', approvedBy: 'auto' } });
    if (moved.count !== 1) return false;
    await this.audit(userId, 'kgraph.site_fact.auto_approved', id, { site: p.site, kind: p.kind });
    return true;
  }

  // ------------------------------------------------------------------ runs (E46.32)

  /** The owner's `active` facts of these sites, as a run reads them. */
  async activeFor(userId: string, sites: readonly string[]): Promise<InputSiteFact[]> {
    const facts = await this.store.listSiteFacts(userId, sites, 'active');
    return facts.map((f) => ({ id: f.id, site: f.site, kind: f.kind, text: f.text, lastUsedAt: f.lastUsedAt, createdAt: f.createdAt }));
  }

  /** The facts a run was given in its block, in their order, when an earlier job of the run chose them; null when none was recorded. */
  async offeredTo(userId: string, runId: string): Promise<string[] | null> {
    const kg = await this.db(userId).kgRun.findFirst({ where: { runId, userId }, select: { offeredFactIds: true } });
    return kg?.offeredFactIds.length ? kg.offeredFactIds : null;
  }

  /** Records the facts given in a run's block (ids only) on its `kg_runs` row. */
  async recordOffered(userId: string, runId: string, mode: string, ids: readonly string[]): Promise<void> {
    await this.db(userId).kgRun.upsert({ where: { runId }, create: { runId, userId, mode, offeredFactIds: [...ids] }, update: { offeredFactIds: [...ids] } });
  }

  /** Facts the run used: `lastUsedAt` now, and their ids added to the run's `fact_ids` (once each). Only the owner's own facts are kept. */
  async markUsed(userId: string, runId: string, ids: readonly string[], now = new Date()): Promise<void> {
    if (ids.length === 0) return;
    const db = this.db(userId);
    const mine = (await db.kgSiteFact.findMany({ where: { userId, id: { in: [...new Set(ids)] } }, select: { id: true } })).map((r) => r.id);
    if (mine.length === 0) return;
    await this.store.touchSiteFacts(userId, mine, now.toISOString());
    const kg = await db.kgRun.findFirst({ where: { runId, userId }, select: { factIds: true } });
    if (!kg) return;
    const next = [...kg.factIds, ...mine.filter((id) => !kg.factIds.includes(id))];
    if (next.length !== kg.factIds.length) await db.kgRun.updateMany({ where: { runId, userId }, data: { factIds: next } });
  }

  /**
   * After a run's final transition: the facts given in its block whose words overlap its own step summaries (server-recorded rows) are marked
   * used. Best effort: an error is logged and the run is unchanged. A run that was given no fact costs one read.
   */
  async afterRun(userId: string, runId: string): Promise<void> {
    try {
      const offered = await this.offeredTo(userId, runId);
      if (!offered) return;
      const facts = await this.db(userId).kgSiteFact.findMany({ where: { userId, id: { in: offered } }, select: { id: true, text: true } });
      // The run is the owner's (its kg_runs row was read through forUser); its steps are read by run id, for their summaries only.
      const steps = await this.prisma.runStep.findMany({ where: { runId }, select: { action: true, summary: true } });
      const own = new Set(['site_facts', 'propose_site_fact']);
      await this.markUsed(userId, runId, siteFactsNamed(facts, steps.filter((s) => !own.has(s.action ?? '')).map((s) => s.summary)));
    } catch (err) {
      this.log.warn(`run ${runId}: site facts not marked used: ${err instanceof Error ? err.name : 'error'}`);
    }
  }

  // ------------------------------------------------------------------ routes

  /** The owner's sites with their fact counts by status. */
  async sites(userId: string) {
    const rows = await this.db(userId).kgSiteFact.findMany({ where: { userId }, select: { site: true, status: true } });
    const by = new Map<string, { site: string; active: number; proposed: number; archived: number }>();
    for (const r of rows) {
      const s = by.get(r.site) ?? { site: r.site, active: 0, proposed: 0, archived: 0 };
      if (r.status === 'active' || r.status === 'proposed' || r.status === 'archived') s[r.status]++;
      by.set(r.site, s);
    }
    return [...by.values()].sort((a, b) => (a.site < b.site ? -1 : a.site > b.site ? 1 : 0));
  }

  async facts(userId: string, site: string, status?: 'proposed' | 'active' | 'archived') {
    const rows = await this.db(userId).kgSiteFact.findMany({ where: { userId, site, ...(status ? { status } : {}) }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
    return rows.map(siteFactView);
  }

  /** The owner typed a fact: active at once (an existing fact of the same identity becomes active). */
  async create(userId: string, site: string, input: { kind: SiteFactKind; text: string }) {
    await this.requireOn(userId);
    const p: SiteFactProposal = { site, kind: input.kind, text: input.text.trim(), source: 'owner', evidence: {} };
    this.validate(p);
    const { fact } = await this.store.proposeSiteFact(userId, { ...p, id: `kgsf-${randomUUID()}`, createdAt: new Date().toISOString() });
    if (fact.status !== 'active') {
      await this.store.setSiteFactStatus(userId, fact.id, fact.status, 'active');
      await this.db(userId).kgSiteFact.updateMany({ where: { id: fact.id, userId }, data: { declinedAt: null, approvedBy: 'owner' } });
    }
    await this.audit(userId, 'kgraph.site_fact.created', fact.id, { site, kind: p.kind });
    return siteFactView(await this.own(userId, fact.id));
  }

  /** Edit the text or kind, archive, or restore (archived → active). A proposal is approved in Reviews, never here. */
  async update(userId: string, id: string, input: { kind?: SiteFactKind; text?: string; status?: 'active' | 'archived' }) {
    await this.requireOn(userId);
    const r = await this.own(userId, id);
    if (input.text !== undefined || input.kind !== undefined) await this.edit(userId, r, input.kind ?? (r.kind as SiteFactKind), input.text ?? r.text);
    if (input.status && input.status !== r.status) {
      if (input.status === 'active' && r.status === 'proposed') throw new ConflictException({ code: 'KGRAPH_SITE_FACT_STATUS', message: 'A proposed fact is approved in Knowledge Graph reviews, signed in to the console' });
      const moved = await this.store.setSiteFactStatus(userId, id, r.status as 'active' | 'archived' | 'proposed', input.status);
      if (!moved) throw new ConflictException({ code: 'KGRAPH_SITE_FACT_STATUS', message: `A ${r.status} fact cannot become ${input.status}` });
      if (input.status === 'active') await this.db(userId).kgSiteFact.updateMany({ where: { id, userId }, data: { declinedAt: null, approvedBy: 'owner' } });
      await this.audit(userId, input.status === 'active' ? 'kgraph.site_fact.restored' : 'kgraph.site_fact.archived', id, { site: r.site });
    }
    return siteFactView(await this.own(userId, id));
  }

  /** New text or kind for a fact: validated, and refused (`409`) when it would be another fact of the owner's. */
  private async edit(userId: string, r: SiteFactRow, kind: SiteFactKind, text: string): Promise<void> {
    const p: SiteFactProposal = { site: r.site, kind, text: text.trim(), source: r.source as SiteFactSource, evidence: {} };
    this.validate(p);
    const identity = siteFactKey(p);
    const clash = await this.db(userId).kgSiteFact.findFirst({ where: { userId, identity, NOT: { id: r.id } }, select: { id: true } });
    if (clash) throw new ConflictException({ code: 'KGRAPH_SITE_FACT_EXISTS', message: 'You already have this fact about this site' });
    await this.db(userId).kgSiteFact.updateMany({ where: { id: r.id, userId }, data: { kind, text: p.text, identity } });
    await this.audit(userId, 'kgraph.site_fact.edited', r.id, { site: r.site, kind });
  }

  async remove(userId: string, id: string): Promise<void> {
    const n = await this.db(userId).kgSiteFact.deleteMany({ where: { id, userId } });
    if (n.count !== 1) throw NOT_FOUND();
    await this.audit(userId, 'kgraph.site_fact.deleted', id, {});
  }

  // ------------------------------------------------------------------ reviews

  async proposals(userId: string) {
    const rows = await this.db(userId).kgSiteFact.findMany({ where: { userId, status: 'proposed' }, orderBy: [{ createdAt: 'desc' }, { id: 'asc' }], take: 200 });
    return rows.map(siteFactView);
  }

  /**
   * The owner's answer to a proposal, from a signed-in browser session only (no token, OAuth app, MCP or webhook). Approve makes it active,
   * optionally with the owner's own edit of its text or kind; decline archives it and suppresses the same identity for 30 days.
   */
  async answer(userId: string, id: string, input: { approve: boolean; kind?: SiteFactKind; text?: string }, credentialKind: string | null | undefined) {
    if (credentialKind !== 'session') throw new ForbiddenException({ code: 'KGRAPH_REVIEW_CONSOLE_ONLY', message: 'A Knowledge Graph review is answered only by the owner, signed in to the console' });
    const r = await this.own(userId, id);
    if (r.status !== 'proposed') throw new ConflictException({ code: 'KGRAPH_REVIEW_ANSWERED', message: 'This proposal was already answered' });
    if (input.approve) {
      if (input.text !== undefined || input.kind !== undefined) await this.edit(userId, r, input.kind ?? (r.kind as SiteFactKind), input.text ?? r.text);
      if (!(await this.store.setSiteFactStatus(userId, id, 'proposed', 'active'))) throw new ConflictException({ code: 'KGRAPH_REVIEW_ANSWERED', message: 'This proposal was already answered' });
      await this.db(userId).kgSiteFact.updateMany({ where: { id, userId }, data: { approvedBy: 'owner' } });
    } else {
      const moved = await this.db(userId).kgSiteFact.updateMany({ where: { id, userId, status: 'proposed' }, data: { status: 'archived', declinedAt: new Date() } });
      if (moved.count !== 1) throw new ConflictException({ code: 'KGRAPH_REVIEW_ANSWERED', message: 'This proposal was already answered' });
    }
    await this.audit(userId, input.approve ? 'kgraph.site_fact.approved' : 'kgraph.site_fact.declined', id, { site: r.site, edited: input.text !== undefined || input.kind !== undefined });
    return siteFactView(await this.own(userId, id));
  }

  // ------------------------------------------------------------------ derive

  /**
   * Proposals from one finished run, read from server-recorded facts only, never from model or page prose, and the owner's opt-in
   * auto-approve (E46.36) for those it covers. Best effort: an error is logged and nothing else changes.
   * - A `learn` or `reuse` run (the `kgraph.compile` job): its `kg_traces` rows (with each call's duration from its step row), the owner's
   *   surface graph (masked labels) and the interrupt handlers that fired.
   * - An `everyday` run (a chat or one-off run, the `kgraph.site_facts` job, `everyday: true`): its `run_steps` rows (the tool, its duration,
   *   a handoff such as a one-time code) joined with the surface the everyday observer recorded for it (the host, path and masked element
   *   fingerprint of each call). Never a procedure: nothing is compiled from such a run.
   * With `kgraph.autoApproveFacts` on (and the Knowledge Graph available), a NEW proposal that `autoApprovable` accepts (source `derived`,
   * kind navigation, timing or quirk, valid) becomes active with `approvedBy: auto`. Everything else stays `proposed`.
   */
  async deriveForRun(userId: string, runId: string, options: { everyday?: boolean } = {}): Promise<Record<ProposeResult, number>> {
    const counts: Record<ProposeResult, number> = { proposed: 0, known: 0, suppressed: 0, refused: 0 };
    try {
      const db = this.db(userId);
      if (!(await db.run.findFirst({ where: { id: runId, userId }, select: { id: true } }))) return counts;
      const events = options.everyday ? await this.everydayEvents(userId, runId) : await this.traceEvents(userId, runId);
      const firings = (await db.kgNode.findMany({ where: { userId, type: INTERRUPT_FIRING_NODE, key: { startsWith: `${runId}:` } }, select: { props: true } }))
        .map((n) => n.props as Partial<InterruptFiring> | null)
        .filter((f): f is InterruptFiring => !!f && typeof f.host === 'string' && ['consent', 'overlay', 'signed_out', 'blocked'].includes(String(f.kind)));
      const sites = new Set<string>();
      for (const e of events) if (e.post.host) sites.add(registrableDomain(e.post.host));
      const elements: Element[] = [];
      if (sites.size > 0) {
        const nodes = await db.kgNode.findMany({ where: { userId, type: 'Element' }, select: { key: true, label: true, props: true } });
        for (const n of nodes) {
          const site = (n.props as { site?: unknown } | null)?.site;
          if (typeof site === 'string' && sites.has(site)) elements.push({ id: n.key, screen: 'sc:surface', label: maskSensitive(n.label).text.slice(0, 200), selectors: [] });
        }
      }
      const proposals = deriveSiteFacts({ runId, events }, { screens: [], elements }, firings, { secretCheck: consoleSecretCheck });
      const status = proposals.length > 0 ? await this.enabled.status(userId).catch(() => null) : null;
      const auto = status?.available === true && status.autoApproveFacts === true;
      let approved = 0;
      const now = new Date();
      for (const p of proposals) {
        const r = await this.proposeRow(userId, p, now);
        counts[r.result]++;
        if (auto && r.result === 'proposed' && r.id && (await this.autoApprove(userId, r.id, p))) approved++;
      }
      if (approved > 0) this.log.log(`run ${runId}: ${approved} site fact(s) approved automatically (the owner's setting)`);
    } catch (err) {
      this.log.warn(`run ${runId}: site facts not derived: ${err instanceof Error ? err.name : 'error'}`);
    }
    return counts;
  }

  /** A learn or reuse run's calls: its `kg_traces` rows, each with its duration from its step row. */
  private async traceEvents(userId: string, runId: string): Promise<SiteTraceEvent[]> {
    const rows = await this.db(userId).kgTrace.findMany({ where: { runId, userId }, orderBy: { seq: 'asc' } });
    // The run is the owner's (read through forUser by the caller); its steps are read by run id, for their durations only.
    const steps = await this.prisma.runStep.findMany({ where: { runId, kind: 'action' }, select: { seq: true, durationMs: true } });
    const duration = new Map(steps.map((s) => [s.seq, s.durationMs]));
    return rows.map((r) => {
      const ms = duration.get(r.seq);
      return { seq: r.seq, tool: r.tool, family: r.family, commits: r.commits, ok: r.ok, outcome: r.outcome as SiteTraceEvent['outcome'], bindings: (r.bindings ?? {}) as Record<string, TraceBinding>, post: (r.post ?? {}) as SiteTraceEvent['post'], ...(typeof ms === 'number' ? { durationMs: ms } : {}) };
    });
  }

  /**
   * An everyday run's calls (E46.36), from server records only: each finished `action` or `observe` step row (its tool, `ok` and duration)
   * and each handoff the run asked (its kind, such as `code`), joined by sequence with the surface the everyday observer recorded (the
   * page's host and path, and the masked fingerprint of the element a click acted on). A navigate step without a surface row is placed by
   * its recorded URL. No argument value, page text or model text is read.
   */
  private async everydayEvents(userId: string, runId: string): Promise<SiteTraceEvent[]> {
    const surface = new Map<number, RunSurfaceProps>();
    for (const n of await this.db(userId).kgNode.findMany({ where: { userId, type: RUN_SURFACE_NODE, key: { startsWith: `${runId}:` } }, select: { key: true, props: true } })) {
      const seq = Number(n.key.slice(runId.length + 1));
      if (Number.isInteger(seq)) surface.set(seq, (n.props ?? {}) as RunSurfaceProps);
    }
    // The run is the owner's (read through forUser by the caller); its steps are read by run id.
    const steps = await this.prisma.runStep.findMany({ where: { runId, kind: { in: ['action', 'observe', 'handoff'] } }, orderBy: { seq: 'asc' }, select: { seq: true, kind: true, action: true, args: true, ok: true, phase: true, durationMs: true } });
    const events: SiteTraceEvent[] = [];
    for (const s of steps) {
      const args = (s.args ?? {}) as Record<string, unknown>;
      if (s.kind === 'handoff') {
        // The handoff the agent asked (`request_human`): only its kind is read. The owner's answer and pre-approved steps have an action.
        if (s.action !== null || typeof args.kind !== 'string') continue;
        events.push({ seq: s.seq, tool: 'request_human', family: 'human', commits: false, ok: s.ok, outcome: 'ran', bindings: { kind: { kind: 'literal', value: args.kind.slice(0, 32) } } as Record<string, TraceBinding>, post: {} });
        continue;
      }
      if (s.phase !== 'done') continue;
      const at = surface.get(s.seq);
      const tool = typeof at?.tool === 'string' ? at.tool : (s.action ?? s.kind);
      const post: SiteTraceEvent['post'] = {};
      const navigated = tool === 'navigate' && typeof args.url === 'string' ? hostAndPath(args.url) : null;
      const host = typeof at?.host === 'string' ? at.host : navigated?.host;
      const path = typeof at?.path === 'string' ? at.path : navigated?.path;
      if (host) post.host = host;
      if (path) post.path = path;
      if (at?.element) post.element = at.element;
      events.push({ seq: s.seq, tool, family: typeof at?.family === 'string' ? at.family : 'browser', commits: false, ok: s.ok, outcome: 'ran', bindings: {}, post, ...(typeof s.durationMs === 'number' ? { durationMs: s.durationMs } : {}) });
    }
    return events;
  }

  /**
   * The hook for an everyday run (E46.28, E46.36: the `kgraph.site_facts` job): after a chat or one-off run whose mode was `everyday`, propose
   * what its steps, handoffs, surface and interrupt handlers show. Safe to call for any run (another user's or an unrecorded run proposes
   * nothing).
   */
  deriveAfterEverydayRun(userId: string, runId: string): Promise<Record<ProposeResult, number>> {
    return this.deriveForRun(userId, runId, { everyday: true });
  }

  /** The surface an everyday run recorded for the derive step: removed once it was read (or when the run did not succeed). */
  async dropRunSurface(userId: string, runId: string): Promise<number> {
    return (await this.db(userId).kgNode.deleteMany({ where: { userId, type: RUN_SURFACE_NODE, key: { startsWith: `${runId}:` } } })).count;
  }

  // ------------------------------------------------------------------ transfer

  /** The owner's active facts, for the export file: site, kind, text and source only. */
  async exportFacts(userId: string): Promise<ExportedSiteFact[]> {
    const rows = await this.db(userId).kgSiteFact.findMany({ where: { userId, status: 'active' }, orderBy: [{ site: 'asc' }, { createdAt: 'asc' }], take: SITE_FACT_TRANSFER_LIMIT, select: { site: true, kind: true, text: true, source: true } });
    return rows.map((r) => ({ site: r.site, kind: r.kind as SiteFactKind, text: r.text, source: r.source as SiteFactSource }));
  }

  /** Facts from an untrusted file: each validated, each stored `proposed` (it waits for the owner in Reviews), whatever the file says. */
  async importFacts(userId: string, raw: unknown): Promise<{ proposed: number; skipped: number }> {
    const list = Array.isArray(raw) ? raw.slice(0, SITE_FACT_TRANSFER_LIMIT) : [];
    let proposed = 0;
    let skipped = Array.isArray(raw) ? Math.max(0, raw.length - SITE_FACT_TRANSFER_LIMIT) : 0;
    for (const item of list) {
      const f = (item ?? {}) as Record<string, unknown>;
      const source = (SITE_FACT_SOURCES as readonly string[]).includes(String(f.source)) ? (f.source as SiteFactSource) : 'owner';
      const p = { site: String(f.site ?? ''), kind: f.kind as SiteFactKind, text: typeof f.text === 'string' ? f.text.trim() : '', source, evidence: {} };
      if (!(SITE_FACT_KINDS as readonly string[]).includes(String(f.kind))) {
        skipped++;
        continue;
      }
      if ((await this.propose(userId, p)) === 'proposed') proposed++;
      else skipped++;
    }
    return { proposed, skipped };
  }
}
