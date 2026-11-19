// Saved approvals (#554): the owner's standing answers, "on this site, do not ask
// me before this step".
//
// THE ONE WRITE PATH THAT CREATES A RULE is `createFromAnswer`, called by the
// question answer handler (#555) with a question the SERVER created and whose
// `rememberable` facts the server computed (the page's registrable domain from
// the fabric, the gate's category, the element's normalised label, or a fixed
// ask topic). Nothing else creates or widens a rule: not a route, not the CLI,
// not an MCP tool, not the model. Owners (and their tokens) may only list,
// narrow, disable, re-enable, delete and pause.
import { ConflictException, HttpException, HttpStatus, Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';
import { UserSettingsService } from '@marinoscar/platform-api/settings';
import { Prisma, type ApprovalRule } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { findRule, normaliseLabel, normaliseRecipient, recipientDomain, registrableDomain, ruleSummary, ASK_TOPICS, CARD_MATCH_KEY_PREFIX, GATE_CATEGORIES, MATCH_KEY_MAX, type ApprovalRuleKind, type MatchQuery } from './approval-match';
import { ApprovalMetrics } from './approval-metrics';
import { APPROVAL_RULE_USES_KEPT, APPROVAL_RULE_USES_SHOWN, type ApprovalRuleDetailView, type ApprovalRuleView, type ApprovalRulesList, type PatchApprovalRule } from './approval-rules.schemas';
import './approvals.errors';

/** What the server worked out a question may be remembered as (#555 sets it on the question). */
export interface Rememberable {
  kind: ApprovalRuleKind;
  /** The registrable domain of the page, from the fabric. */
  host: string;
  /** For `gate`: the gate's category. */
  category?: string | null;
  /** For `gate`: the element's label (normalised here again); for `ask`: the topic. */
  matchKey: string;
  /** What the owner reads; recomputed when absent. */
  summary?: string | null;
  /**
   * A saved card (E37.7): `<provider>:<item id>`. Set by the runner from its own record of the card, never from a model or a
   * request. A card rule is a `gate` rule of category `payment` keyed on `saved card <currency>`; the owner's amount limit is
   * REQUIRED for it.
   */
  cardRef?: string | null;
  /**
   * `connection` (E39.7): the tool (`mail_send`, `sheet_append_rows`, ...) is `matchKey` and the connection's id is `host`. The server sets
   * `recipients` from the call it validated (never from the model's words): the addresses the approved call reaches. Required for a tool
   * that reaches people (the rule then carries those people, or their domains), empty for the others.
   */
  recipients?: string[] | null;
}

/** The owner's choices when they tick "Don't ask again" (#555). All optional. */
export interface RememberRuleChoice {
  scope?: 'everywhere' | 'this_task' | 'this_chat';
  maxAmount?: number | null;
  expiresInDays?: number | null;
  /** `connection` rules that reach people: remember `these` people (the call's addresses) or `domain` (anyone at their domains). */
  recipientsFrom?: 'these' | 'domain';
}

/** The question a rule is made from: created by the server, answered by its owner. */
export interface RememberedQuestion {
  id: string;
  userId: string;
  rememberable: Rememberable;
  /** The task and chat of the question's run, for a scoped rule. */
  taskId?: string | null;
  conversationId?: string | null;
}

/** A transaction client, or the service's own. */
type Db = Prisma.TransactionClient | PrismaService;

/** The audit actions of saved approvals; ids, host, category and kind only. */
export const APPROVAL_AUDIT = {
  created: 'approval_rule.created',
  used: 'approval_rule.used',
  narrowed: 'approval_rule.narrowed',
  disabled: 'approval_rule.disabled',
  enabled: 'approval_rule.enabled',
  deleted: 'approval_rule.deleted',
  paused: 'approvals.paused',
  resumed: 'approvals.resumed',
} as const;

const DAY_MS = 86_400_000;

function iso(d: Date | null): string | null {
  return d ? d.toISOString() : null;
}

function amount(d: Prisma.Decimal | null): number | null {
  return d === null ? null : Number(d.toString());
}

function notFound(): NotFoundException {
  return new NotFoundException({ code: 'APPROVAL_RULE_NOT_FOUND', message: 'No such saved approval.' });
}

function cannotWiden(field: string, why: string): HttpException {
  return new HttpException(
    { code: 'RULE_CANNOT_WIDEN', message: `${why} A saved approval can only be narrowed; answer a new question to make a looser one.`, details: { field } },
    HttpStatus.BAD_REQUEST,
  );
}

function invalid(message: string): HttpException {
  return new HttpException({ code: 'APPROVAL_RULE_INVALID', message }, HttpStatus.UNPROCESSABLE_ENTITY);
}

/** A card rule without an amount limit is refused (E37.7): unlike other approvals, the limit is required. */
function needsLimit(): HttpException {
  return new HttpException({ code: 'CARD_RULE_NEEDS_AMOUNT_LIMIT', message: 'A saved approval for a card needs an amount limit: choose the most it may pay without asking.' }, HttpStatus.UNPROCESSABLE_ENTITY);
}

/** A rule as the API returns it. */
export function ruleView(r: ApprovalRule, taskName: string | null = null): ApprovalRuleView {
  return {
    id: r.id,
    kind: r.kind,
    host: r.host,
    category: r.category || null,
    matchKey: r.matchKey,
    summary: r.summary,
    taskId: r.taskId || null,
    taskName,
    conversationId: r.conversationId || null,
    maxAmount: amount(r.maxAmount),
    cardRef: r.cardRef || null,
    recipients: [...(r.recipients ?? [])],
    expiresAt: iso(r.expiresAt),
    enabled: r.enabled,
    createdFromQuestionId: r.createdFromQuestionId,
    useCount: r.useCount,
    lastUsedAt: iso(r.lastUsedAt),
    lastUsedRunId: r.lastUsedRunId,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

/** A rule's facts as the matcher reads them. */
function matchable(r: ApprovalRule) {
  return { ...r, category: r.category || null, taskId: r.taskId || null, conversationId: r.conversationId || null, cardRef: r.cardRef || null, recipients: r.recipients ?? [], maxAmount: amount(r.maxAmount) };
}

@Injectable()
export class ApprovalRulesService {
  private readonly log = new Logger(ApprovalRulesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: UserSettingsService,
    @Optional() private readonly metrics: ApprovalMetrics = new ApprovalMetrics(),
  ) {}

  // ---- Reading ----

  /** The caller's rules, newest first, and whether "Pause all" is on. */
  async list(userId: string, q: { host?: string; enabled?: boolean } = {}): Promise<ApprovalRulesList> {
    const rows = await this.prisma.approvalRule.findMany({
      where: { userId, ...(q.host ? { host: q.host } : {}), ...(q.enabled === undefined ? {} : { enabled: q.enabled }) },
      orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
      take: 1_000,
    });
    const names = await this.taskNames(userId, rows.map((r) => r.taskId).filter(Boolean));
    return { paused: await this.isPaused(userId), rules: rows.map((r) => ruleView(r, names.get(r.taskId) ?? null)) };
  }

  /** One rule with its newest uses; 404 for a missing rule and for another user's alike. */
  async get(userId: string, id: string): Promise<ApprovalRuleDetailView> {
    const r = await this.own(userId, id);
    const uses = await this.prisma.approvalRuleUse.findMany({ where: { ruleId: r.id }, orderBy: { usedAt: 'desc' }, take: APPROVAL_RULE_USES_SHOWN });
    const names = await this.taskNames(userId, r.taskId ? [r.taskId] : []);
    return { ...ruleView(r, names.get(r.taskId) ?? null), uses: uses.map((u) => ({ runId: u.runId, stepSeq: u.stepSeq, usedAt: u.usedAt.toISOString() })) };
  }

  /** Whether the owner's "Pause all" switch is on (the `approvals` user settings namespace). */
  async isPaused(userId: string): Promise<boolean> {
    const row = await this.prisma.userSettings.findUnique({ where: { userId }, select: { value: true } });
    const value = (row?.value ?? null) as { approvals?: { paused?: unknown } } | null;
    return value?.approvals?.paused === true;
  }

  /**
   * The rule that allows a step, or null: the owner's enabled rules for that registrable domain, through
   * the pure matcher (`findRule`), with "Pause all" honoured. `pageUrl` is the page's real URL as the
   * fabric reported it; an unknown URL never matches. For #555.
   */
  async match(userId: string, q: Omit<MatchQuery, 'host' | 'paused' | 'now'> & { pageUrl: string | null; now?: Date }): Promise<ApprovalRule | null> {
    const host = registrableDomain(q.pageUrl);
    if (!host) return null;
    if (await this.isPaused(userId)) return null;
    const rows = await this.prisma.approvalRule.findMany({ where: { userId, host, enabled: true, kind: q.kind } });
    const hit = findRule(rows.map(matchable), { ...q, host, now: q.now ?? new Date(), paused: false });
    return hit ? (rows.find((r) => r.id === hit.id) ?? null) : null;
  }

  /**
   * The saved approval that lets a call through one of the owner's connections (E39.7), or null: the owner's enabled `connection` rules for
   * this connection and tool, in this run's scope, with "Pause all" honoured. `recipients` are the addresses the validated call reaches; a rule
   * covers the call only when its approved set covers every one of them. The connection id and the tool come from the server, never the model.
   */
  async matchConnection(userId: string, q: { connectionId: string; tool: string; recipients: readonly string[]; taskId: string | null; conversationId: string | null; now?: Date }): Promise<ApprovalRule | null> {
    if (await this.isPaused(userId)) return null;
    const rows = await this.prisma.approvalRule.findMany({ where: { userId, host: q.connectionId, matchKey: q.tool, enabled: true, kind: 'connection' } });
    const hit = findRule(rows.map(matchable), { kind: 'connection', host: q.connectionId, category: null, matchKey: q.tool, taskId: q.taskId, conversationId: q.conversationId, amount: null, recipients: q.recipients, now: q.now ?? new Date(), paused: false });
    return hit ? (rows.find((r) => r.id === hit.id) ?? null) : null;
  }

  /**
   * The ask topics the owner has enabled rules for on a site, in this run's scope (#555): the line the model reads
   * so it stops asking. Never gate rules. Empty while paused, for an unknown site, or with no rules.
   */
  async askTopics(userId: string, q: { pageUrl: string | null; taskId: string | null; conversationId: string | null; now?: Date }): Promise<string[]> {
    const host = registrableDomain(q.pageUrl);
    if (!host || (await this.isPaused(userId))) return [];
    const rows = await this.prisma.approvalRule.findMany({ where: { userId, host, enabled: true, kind: 'ask' } });
    const now = q.now ?? new Date();
    return [...new Set(rows.filter((r) => findRule([matchable(r)], { kind: 'ask', host, category: null, matchKey: r.matchKey, taskId: q.taskId, conversationId: q.conversationId, amount: null, now })).map((r) => r.matchKey))];
  }

  /** The gate rules a run used, one entry per use, oldest first (#555): the end-of-run notification and the chat's result card. */
  async gateUsesOfRun(userId: string, runId: string): Promise<{ ruleId: string; summary: string }[]> {
    const uses = await this.prisma.approvalRuleUse.findMany({ where: { runId, rule: { userId, kind: 'gate' } }, orderBy: { usedAt: 'asc' }, select: { ruleId: true, rule: { select: { summary: true } } } });
    return uses.map((u) => ({ ruleId: u.ruleId, summary: u.rule.summary }));
  }

  // ---- The one creator ----

  /**
   * Makes the rule a question's answer asked for (#555), or returns the identical one that already exists.
   * The ONLY way a rule comes to exist. `question.rememberable` must have been computed by the server;
   * a scope must be the question's own run's. Runs in the caller's transaction when given.
   */
  async createFromAnswer(question: RememberedQuestion, choice: RememberRuleChoice = {}, opts: { tx?: Prisma.TransactionClient; now?: Date; orgId?: string | null } = {}): Promise<{ rule: ApprovalRuleView; created: boolean }> {
    const db: Db = opts.tx ?? this.prisma;
    const now = opts.now ?? new Date();
    const r = question.rememberable;
    const kind = r.kind;
    if (kind !== 'gate' && kind !== 'ask' && kind !== 'connection') throw invalid('The question cannot be remembered.');
    const cardRef = (r.cardRef ?? '').trim();
    const host = (r.host ?? '').trim().toLowerCase();
    // A connection rule has no site: its `host` is the connection's id (a UUID the server read from its own record).
    if (kind === 'connection') {
      if (!/^[0-9a-f-]{36}$/.test(host)) throw invalid('The question has no connection a rule could be kept for.');
    } else if (!host || host.includes('*') || host.length > 253 || registrableDomain(`https://${host}/`) !== host) throw invalid('The question has no site a rule could be kept for.');
    let category = '';
    let matchKey: string;
    let label: string | null = null;
    if (cardRef) {
      // A saved card (E37.7): a payment gate rule bound to the merchant's site and this card, in one currency.
      if (kind !== 'gate' || (r.category ?? '').trim().toLowerCase() !== 'payment' || !/^[a-z][a-z0-9_-]{0,19}:[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(cardRef)) throw invalid('The question has no card a rule could be kept for.');
      category = 'payment';
      matchKey = (r.matchKey ?? '').trim().toLowerCase();
      if (!new RegExp(`^${CARD_MATCH_KEY_PREFIX} [a-z]{3}$`).test(matchKey)) throw invalid('The question has no currency a card rule could be kept for.');
    } else if (kind === 'connection') {
      matchKey = (r.matchKey ?? '').trim();
      if (!/^[a-z][a-z_]{2,40}$/.test(matchKey)) throw invalid('The question has no tool a rule could be kept for.');
    } else if (kind === 'gate') {
      category = (r.category ?? '').trim().toLowerCase();
      if (!(GATE_CATEGORIES as readonly string[]).includes(category)) throw invalid('The question has no commitment a rule could be kept for.');
      label = r.matchKey;
      matchKey = normaliseLabel(r.matchKey);
      if (!matchKey) throw invalid('The question has no button label a rule could be kept for.');
    } else {
      matchKey = (r.matchKey ?? '').trim();
      if (!(ASK_TOPICS as readonly string[]).includes(matchKey) || matchKey === 'other') throw invalid('This kind of question cannot be remembered.');
    }
    const scope = choice.scope ?? 'everywhere';
    const taskId = scope === 'this_task' ? (question.taskId ?? '') : '';
    const conversationId = scope === 'this_chat' ? (question.conversationId ?? '') : '';
    if (scope === 'this_task' && !taskId) throw invalid('The question did not come from a task.');
    if (scope === 'this_chat' && !conversationId) throw invalid('The question did not come from a chat.');
    const maxAmount = choice.maxAmount ?? null;
    if (cardRef && maxAmount === null) throw needsLimit();
    if (maxAmount !== null && !(Number.isFinite(maxAmount) && maxAmount > 0)) throw invalid('An amount limit must be a positive number.');
    const days = choice.expiresInDays ?? null;
    if (days !== null && !(Number.isInteger(days) && days > 0 && days <= 3650)) throw invalid('An expiry must be a whole number of days.');
    const summary = (r.summary?.trim() || ruleSummary({ kind, host, label, topic: matchKey, card: cardRef ? 'a saved card' : null })).slice(0, 300);

    // The recipients a connection rule covers (E39.7): the approved call's own addresses, or their domains; never "anyone", never the model's.
    let recipients: string[] = [];
    if (kind === 'connection' && (r.recipients ?? []).length > 0) {
      const own = (r.recipients ?? []).map((a) => normaliseRecipient(a)).filter((a): a is string => Boolean(a) && !a!.startsWith('@'));
      if (own.length === 0 || own.length !== (r.recipients ?? []).length) throw invalid('The question has no recipients a rule could be kept for.');
      recipients = [...new Set(choice.recipientsFrom === 'domain' ? own.map((a) => recipientDomain(a)!) : own)].slice(0, 50);
    }

    const key = { userId: question.userId, kind, host, category, matchKey: matchKey.slice(0, MATCH_KEY_MAX), taskId, conversationId, cardRef };
    const existing = await db.approvalRule.findUnique({ where: { approval_rule_key: key } });
    if (existing) {
      // Another approved call to new people (E39.7): the owner's tick on this request adds them to the rule; nothing else adds a recipient.
      const merged = [...new Set([...existing.recipients, ...recipients])].slice(0, 200);
      if (kind === 'connection' && merged.length !== existing.recipients.length) {
        const updated = await db.approvalRule.update({ where: { id: existing.id }, data: { recipients: merged } });
        await this.audit(db, question.userId, opts.orgId ?? null, APPROVAL_AUDIT.narrowed, updated, { questionId: question.id, recipientsAdded: merged.length - existing.recipients.length });
        return { rule: ruleView(updated), created: false };
      }
      return { rule: ruleView(existing), created: false };
    }
    let row: ApprovalRule;
    try {
      row = await db.approvalRule.create({
        data: {
          ...key,
          summary,
          recipients,
          maxAmount: maxAmount === null ? null : new Prisma.Decimal(maxAmount.toFixed(2)),
          expiresAt: days === null ? null : new Date(now.getTime() + days * DAY_MS),
          createdFromQuestionId: question.id,
        },
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002' && !opts.tx) {
        const again = await db.approvalRule.findUnique({ where: { approval_rule_key: key } });
        if (again) return { rule: ruleView(again), created: false };
      }
      throw e;
    }
    await this.audit(db, question.userId, opts.orgId ?? null, APPROVAL_AUDIT.created, row, { questionId: question.id, scoped: Boolean(taskId || conversationId), limited: maxAmount !== null, expires: days !== null, ...(cardRef ? { card: true } : {}) });
    return { rule: ruleView(row), created: true };
  }

  // ---- Uses ----

  /** Records that a rule allowed a step (#555): the count, the last use, one `approval_rule_uses` row (the newest 200 kept), the audit event and the counter. */
  async recordUse(rule: Pick<ApprovalRule, 'id' | 'userId' | 'kind' | 'host' | 'category'>, use: { runId: string | null; stepSeq?: number | null; now?: Date; orgId?: string | null }): Promise<void> {
    const usedAt = use.now ?? new Date();
    await this.prisma.$transaction(async (tx) => {
      await tx.approvalRule.update({ where: { id: rule.id }, data: { useCount: { increment: 1 }, lastUsedAt: usedAt, lastUsedRunId: use.runId } });
      await tx.approvalRuleUse.create({ data: { ruleId: rule.id, runId: use.runId, stepSeq: use.stepSeq ?? null, usedAt } });
      const stale = await tx.approvalRuleUse.findMany({ where: { ruleId: rule.id }, orderBy: [{ usedAt: 'desc' }, { id: 'desc' }], skip: APPROVAL_RULE_USES_KEPT, select: { id: true } });
      if (stale.length > 0) await tx.approvalRuleUse.deleteMany({ where: { id: { in: stale.map((s) => s.id) } } });
      await this.audit(tx, rule.userId, use.orgId ?? null, APPROVAL_AUDIT.used, rule, { runId: use.runId, stepSeq: use.stepSeq ?? null });
    });
    this.metrics.used(rule.kind, rule.category || null);
  }

  // ---- Narrowing, disabling, deleting ----

  /**
   * Applies a patch that only narrows (or disables, or re-enables) the rule. Each field is checked against
   * the stored value: raising or removing a limit, lengthening or removing an expiry, or removing or
   * changing a scope is `400 RULE_CANNOT_WIDEN`.
   */
  async patch(userId: string, id: string, body: PatchApprovalRule, opts: { orgId?: string | null } = {}): Promise<ApprovalRuleView> {
    const r = await this.own(userId, id);
    const data: Prisma.ApprovalRuleUpdateInput = {};
    const narrowed: string[] = [];

    if (body.maxAmount !== undefined) {
      const current = amount(r.maxAmount);
      if (body.maxAmount === null) {
        if (current !== null) throw cannotWiden('maxAmount', 'The amount limit cannot be removed.');
      } else {
        if (current !== null && body.maxAmount > current) throw cannotWiden('maxAmount', `The amount limit cannot be raised above ${current}.`);
        if (current === null || body.maxAmount < current) {
          data.maxAmount = new Prisma.Decimal(body.maxAmount.toFixed(2));
          narrowed.push('maxAmount');
        }
      }
    }
    if (body.expiresAt !== undefined) {
      if (body.expiresAt === null) {
        if (r.expiresAt) throw cannotWiden('expiresAt', 'The expiry cannot be removed.');
      } else {
        const next = new Date(body.expiresAt);
        if (r.expiresAt && next.getTime() > r.expiresAt.getTime()) throw cannotWiden('expiresAt', 'The expiry cannot be moved later.');
        if (!r.expiresAt || next.getTime() < r.expiresAt.getTime()) {
          data.expiresAt = next;
          narrowed.push('expiresAt');
        }
      }
    }
    for (const field of ['taskId', 'conversationId'] as const) {
      const v = body[field];
      if (v === undefined) continue;
      const current = r[field] || null;
      if (v === null || (current !== null && v !== current)) {
        if (current !== null) throw cannotWiden(field, field === 'taskId' ? 'The task scope cannot be removed or changed.' : 'The chat scope cannot be removed or changed.');
        continue;
      }
      if (current === null) {
        if (field === 'taskId' && !(await this.prisma.task.findFirst({ where: { id: v, userId }, select: { id: true } }))) throw invalid('No such task.');
        if (field === 'conversationId' && !(await this.prisma.conversation.findFirst({ where: { id: v, userId }, select: { id: true } }))) throw invalid('No such chat.');
        data[field] = v;
        narrowed.push(field);
      }
    }
    const enabledChange = body.enabled !== undefined && body.enabled !== r.enabled ? body.enabled : undefined;
    if (enabledChange !== undefined) data.enabled = enabledChange;
    if (Object.keys(data).length === 0) return (await this.get(userId, id)) as ApprovalRuleView;

    let row: ApprovalRule;
    try {
      row = await this.prisma.$transaction(async (tx) => {
        const updated = await tx.approvalRule.update({ where: { id: r.id }, data });
        if (narrowed.length > 0) await this.audit(tx, userId, opts.orgId ?? null, APPROVAL_AUDIT.narrowed, updated, { fields: narrowed });
        if (enabledChange !== undefined) await this.audit(tx, userId, opts.orgId ?? null, enabledChange ? APPROVAL_AUDIT.enabled : APPROVAL_AUDIT.disabled, updated, {});
        return updated;
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new ConflictException({ code: 'APPROVAL_RULE_DUPLICATE', message: 'You already have this saved approval with that scope.' });
      }
      throw e;
    }
    const names = await this.taskNames(userId, row.taskId ? [row.taskId] : []);
    return ruleView(row, names.get(row.taskId) ?? null);
  }

  /** Deletes a rule and its uses; 404 for a missing rule and for another user's alike. */
  async remove(userId: string, id: string, opts: { orgId?: string | null } = {}): Promise<void> {
    const r = await this.own(userId, id);
    await this.prisma.$transaction(async (tx) => {
      await tx.approvalRule.delete({ where: { id: r.id } });
      await this.audit(tx, userId, opts.orgId ?? null, APPROVAL_AUDIT.deleted, r, {});
    });
  }

  /** The "Pause all" switch: stored in the `approvals` user settings namespace, audited when it changes. */
  async setPaused(userId: string, paused: boolean, opts: { orgId?: string | null } = {}): Promise<{ paused: boolean }> {
    const was = await this.isPaused(userId);
    await this.settings.patchSettings(userId, { approvals: { paused } } as never);
    if (was !== paused) {
      await this.prisma.auditEvent.create({ data: { actorUserId: userId, action: paused ? APPROVAL_AUDIT.paused : APPROVAL_AUDIT.resumed, targetType: 'user', targetId: userId, orgId: opts.orgId ?? null, meta: { paused } } });
    }
    return { paused };
  }

  // ---- Alerts ----

  /** Rules used at least `minUses` times since `since`, busiest first (the "saved approval used a lot" alert). */
  async busyRules(minUses: number, since: Date): Promise<{ ruleId: string; userId: string; kind: string; category: string | null; uses: number }[]> {
    const counts = await this.prisma.approvalRuleUse.groupBy({ by: ['ruleId'], where: { usedAt: { gte: since } }, _count: { _all: true } });
    const busy = counts.filter((c) => c._count._all >= minUses);
    if (busy.length === 0) return [];
    const rules = await this.prisma.approvalRule.findMany({ where: { id: { in: busy.map((b) => b.ruleId) } }, select: { id: true, userId: true, kind: true, category: true } });
    const byId = new Map(rules.map((r) => [r.id, r]));
    return busy
      .flatMap((b) => {
        const r = byId.get(b.ruleId);
        return r ? [{ ruleId: r.id, userId: r.userId, kind: r.kind, category: r.category || null, uses: b._count._all }] : [];
      })
      .sort((a, b) => b.uses - a.uses);
  }

  // ---- Helpers ----

  private async own(userId: string, id: string): Promise<ApprovalRule> {
    const r = await this.prisma.approvalRule.findFirst({ where: { id, userId } });
    if (!r) throw notFound();
    return r;
  }

  private async taskNames(userId: string, ids: string[]): Promise<Map<string, string>> {
    if (ids.length === 0) return new Map();
    const rows = await this.prisma.task.findMany({ where: { id: { in: [...new Set(ids)] }, userId }, select: { id: true, name: true } });
    return new Map(rows.map((t) => [t.id, t.name]));
  }

  /** One audit event: ids, host, category and kind only; never a page label beyond the stored summary. */
  private async audit(db: Db, userId: string, orgId: string | null, action: string, rule: Pick<ApprovalRule, 'id' | 'kind' | 'host' | 'category'>, meta: Record<string, unknown>): Promise<void> {
    try {
      await db.auditEvent.create({
        data: { actorUserId: userId, action, targetType: 'approval_rule', targetId: rule.id, orgId, meta: { ruleId: rule.id, kind: rule.kind, host: rule.host, category: rule.category || null, ...meta } as Prisma.InputJsonValue },
      });
    } catch (e) {
      if (db !== this.prisma) throw e;
      this.log.warn(`approvals: the audit record ${action} could not be written: ${e instanceof Error ? e.name : 'error'}`);
    }
  }
}
