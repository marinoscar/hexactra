// Site facts (phase 5, E46.31; docs/decisions/knowledge-graph.md, "Site facts"). A fact is DATA about one site, never an instruction or a
// permission. Only the owner's own act makes one `active`: typing it (POST, active at once) or approving a proposal in Reviews, signed in, in
// the console. Derived proposals (the `kgraph.compile` job, from server-recorded facts) and the agent's proposals (`propose_site_fact`) are
// stored `proposed`. A declined proposal is archived and its identity is not proposed again for 30 days; one the owner archived is never
// proposed again. No fact holds Secret Material: `validateSiteFact` with the console's secret check refuses it (`422`).
import { randomUUID } from 'node:crypto';

import { ConflictException, ForbiddenException, Injectable, Logger, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import {
  deriveSiteFacts,
  registrableDomain,
  siteFactKey,
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
} from '@marinoscar/hexactra-kgraph';
import type { SiteFactProposalOutcome } from '@marinoscar/hexactra-kgraph/harness';

import { PrismaService } from '../prisma/prisma.service';
import { maskSensitive } from '../tasks/mask';
import { KgraphEnabledService } from './kgraph-enabled.service';
import { consoleSecretCheck, PrismaSiteFactStore, type SiteFactRow } from './prisma-site-fact-store';
import { DECLINE_SUPPRESS_MS } from './reviews.service';

/** The kg_nodes type of an interrupt handler that fired during a replay (E46.15), kept for the derive step. Ids and kinds only. */
export const INTERRUPT_FIRING_NODE = 'InterruptFiring';

/** At most this many facts in an export or an import file. */
export const SITE_FACT_TRANSFER_LIMIT = 500;

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
    if (validateSiteFact(p, { secretCheck: consoleSecretCheck }).length > 0) return 'refused';
    const identity = siteFactKey(p);
    const existing = await this.db(userId).kgSiteFact.findFirst({ where: { userId, identity } });
    if (existing) {
      if (existing.status !== 'archived' || !existing.declinedAt) return 'known';
      if (existing.declinedAt.getTime() > now.getTime() - DECLINE_SUPPRESS_MS) return 'suppressed';
      await this.db(userId).kgSiteFact.deleteMany({ where: { id: existing.id, userId, status: 'archived' } });
    }
    const r = await this.store.proposeSiteFact(userId, { ...p, id: `kgsf-${randomUUID()}`, createdAt: now.toISOString() });
    return r.created ? 'proposed' : 'known';
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
      await this.db(userId).kgSiteFact.updateMany({ where: { id: fact.id, userId }, data: { declinedAt: null } });
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
      if (input.status === 'active') await this.db(userId).kgSiteFact.updateMany({ where: { id, userId }, data: { declinedAt: null } });
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
    } else {
      const moved = await this.db(userId).kgSiteFact.updateMany({ where: { id, userId, status: 'proposed' }, data: { status: 'archived', declinedAt: new Date() } });
      if (moved.count !== 1) throw new ConflictException({ code: 'KGRAPH_REVIEW_ANSWERED', message: 'This proposal was already answered' });
    }
    await this.audit(userId, input.approve ? 'kgraph.site_fact.approved' : 'kgraph.site_fact.declined', id, { site: r.site, edited: input.text !== undefined || input.kind !== undefined });
    return siteFactView(await this.own(userId, id));
  }

  // ------------------------------------------------------------------ derive

  /**
   * Proposals from one finished run, read from server-recorded facts only: its `kg_traces` rows (with each call's duration from its step
   * row), the owner's surface graph (masked labels) and the interrupt handlers that fired. Called by the `kgraph.compile` job after a
   * `learn` or `reuse` run. `everyday` (the hook for #850's everyday runs) keeps only what comes from handoffs and handlers: `sign_in` and
   * `quirk`. Best effort: an error is logged and nothing else changes.
   */
  async deriveForRun(userId: string, runId: string, options: { everyday?: boolean } = {}): Promise<Record<ProposeResult, number>> {
    const counts: Record<ProposeResult, number> = { proposed: 0, known: 0, suppressed: 0, refused: 0 };
    try {
      const db = this.db(userId);
      if (!(await db.run.findFirst({ where: { id: runId, userId }, select: { id: true } }))) return counts;
      const rows = await db.kgTrace.findMany({ where: { runId, userId }, orderBy: { seq: 'asc' } });
      // The run is the owner's (read above through forUser); its steps are read by run id, for their durations only.
      const steps = await this.prisma.runStep.findMany({ where: { runId, kind: 'action' }, select: { seq: true, durationMs: true } });
      const duration = new Map(steps.map((s) => [s.seq, s.durationMs]));
      const events: SiteTraceEvent[] = rows.map((r) => {
        const ms = duration.get(r.seq);
        return { seq: r.seq, tool: r.tool, family: r.family, commits: r.commits, ok: r.ok, outcome: r.outcome as SiteTraceEvent['outcome'], bindings: (r.bindings ?? {}) as Record<string, TraceBinding>, post: (r.post ?? {}) as SiteTraceEvent['post'], ...(typeof ms === 'number' ? { durationMs: ms } : {}) };
      });
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
      let proposals = deriveSiteFacts({ runId, events }, { screens: [], elements }, firings, { secretCheck: consoleSecretCheck });
      if (options.everyday) proposals = proposals.filter((p) => p.kind === 'sign_in' || p.kind === 'quirk');
      for (const p of proposals) counts[await this.propose(userId, p)]++;
    } catch (err) {
      this.log.warn(`run ${runId}: site facts not derived: ${err instanceof Error ? err.name : 'error'}`);
    }
    return counts;
  }

  /**
   * The hook for an everyday run (#850, `kgraph.everyday`): after a chat or one-off run whose mode was `everyday`, propose only what its
   * handoffs and interrupt handlers show (`sign_in`, `quirk`), from the same server-recorded rows. Nothing calls it until #850 marks those
   * runs; it is safe to call for any run (another user's or an unrecorded run proposes nothing).
   */
  deriveAfterEverydayRun(userId: string, runId: string): Promise<Record<ProposeResult, number>> {
    return this.deriveForRun(userId, runId, { everyday: true });
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
