// Saved approvals (#554) against a real, migrated and seeded database:
// `createFromAnswer` (the one creator) and its idempotence, the unique key,
// isolation (another user's rule never matches and is 404), the narrowing-only
// PATCH, Pause all, uses recorded and capped, the audit events, run deletes,
// the busy-rule alert and the user's deletion.
import { randomUUID } from 'node:crypto';
import { AlertsEvaluationService } from '@marinoscar/platform-api/alerts';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';

import { HexactraAlertsService } from '../src/alerts/hexactra-alerts.service';
import { setAlertSources } from '../src/alerts/hexactra-alert-kinds';
import { ApprovalRulesService, type RememberedQuestion } from '../src/approvals/approval-rules.service';
import { APPROVAL_RULE_USES_KEPT } from '../src/approvals/approval-rules.schemas';
import { createApp } from '../src/main';
import { PrismaService } from '../src/prisma/prisma.service';
import { RunDeleteService } from '../src/tasks/run-delete.service';

let app: NestFastifyApplication;
let prisma: PrismaService;
let rules: ApprovalRulesService;
const stamp = `${Date.now()}`;

interface Session {
  token: string;
  userId: string;
}

async function login(name: string, role: 'contributor' | 'viewer' = 'contributor'): Promise<Session> {
  const res = await app.inject({ method: 'POST', url: '/api/auth/test/login', payload: { email: `${name}-${stamp}@example.test`, role } });
  const token = new URL(String(res.headers.location)).searchParams.get('token')!;
  const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { authorization: `Bearer ${token}` } });
  return { token, userId: me.json<{ data: { id: string } }>().data.id };
}

interface Reply<T> {
  statusCode: number;
  code: string;
  data: T;
}
async function call<T = unknown>(s: Session, method: 'GET' | 'PATCH' | 'PUT' | 'DELETE' | 'POST', url: string, payload?: unknown): Promise<Reply<T>> {
  const res = await app.inject({ method, url, headers: { authorization: `Bearer ${s.token}` }, ...(payload === undefined ? {} : { payload: payload as object }) });
  const body = res.body ? (res.json() as { data?: T; error?: { code?: string }; code?: string }) : {};
  return { statusCode: res.statusCode, code: body.error?.code ?? body.code ?? '', data: body.data as T };
}

interface RuleView {
  id: string;
  kind: string;
  host: string;
  category: string | null;
  matchKey: string;
  summary: string;
  taskId: string | null;
  taskName: string | null;
  conversationId: string | null;
  maxAmount: number | null;
  expiresAt: string | null;
  enabled: boolean;
  useCount: number;
  lastUsedRunId: string | null;
  uses?: { runId: string | null; stepSeq: number | null; usedAt: string }[];
}

function payQuestion(userId: string, over: Partial<RememberedQuestion> = {}): RememberedQuestion {
  return { id: randomUUID(), userId, rememberable: { kind: 'gate', host: 'bankofamerica.com', category: 'payment', matchKey: 'Pay $10.00' }, ...over };
}

async function run(userId: string, extra: Record<string, unknown> = {}): Promise<string> {
  const r = await prisma.run.create({ data: { userId, goal: 'Pay a bill', status: 'succeeded', ...extra } as never, select: { id: true } });
  return r.id;
}

beforeAll(async () => {
  app = await createApp();
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  prisma = app.get(PrismaService);
  rules = app.get(ApprovalRulesService, { strict: false });
});
afterAll(async () => {
  await app?.close();
});

describe('createFromAnswer: the one creator', () => {
  it('creates one rule from a gate question, keyed on host, category and the normalised label, and is idempotent', async () => {
    const alice = await login('apr-create');
    const q = payQuestion(alice.userId);
    const first = await rules.createFromAnswer(q);
    expect(first.created).toBe(true);
    expect(first.rule).toMatchObject({ kind: 'gate', host: 'bankofamerica.com', category: 'payment', matchKey: 'pay $#', summary: "Press 'Pay $10.00' on bankofamerica.com", taskId: null, conversationId: null, maxAmount: null, enabled: true, useCount: 0 });
    // The same tick again (another amount on the same button): the same rule, nothing new.
    const again = await rules.createFromAnswer(payQuestion(alice.userId, { rememberable: { kind: 'gate', host: 'bankofamerica.com', category: 'payment', matchKey: 'Pay $75.10' } }));
    expect(again).toEqual({ rule: expect.objectContaining({ id: first.rule.id }), created: false });
    expect(await prisma.approvalRule.count({ where: { userId: alice.userId } })).toBe(1);
    // The audit event: ids, host, category and kind; never the label.
    const ev = await prisma.auditEvent.findFirstOrThrow({ where: { action: 'approval_rule.created', targetId: first.rule.id } });
    expect(ev.meta).toMatchObject({ ruleId: first.rule.id, kind: 'gate', host: 'bankofamerica.com', category: 'payment', questionId: q.id });
    expect(JSON.stringify(ev.meta)).not.toMatch(/Pay \$|pay \$#|summary|matchKey/);
  });

  it('the unique key: a scoped rule is a different rule; the database refuses a duplicate', async () => {
    const alice = await login('apr-unique');
    const task = await prisma.task.create({ data: { userId: alice.userId, name: 'Zelle to Paula', goal: 'Send money' } });
    const a = await rules.createFromAnswer(payQuestion(alice.userId));
    const b = await rules.createFromAnswer(payQuestion(alice.userId, { taskId: task.id }), { scope: 'this_task' });
    expect(b.created).toBe(true);
    expect(b.rule.id).not.toBe(a.rule.id);
    expect(b.rule.taskId).toBe(task.id);
    await expect(
      prisma.approvalRule.create({ data: { userId: alice.userId, kind: 'gate', host: 'bankofamerica.com', category: 'payment', matchKey: 'pay $#', summary: 'dup' } }),
    ).rejects.toMatchObject({ code: 'P2002' });
  });

  it('an ask rule is keyed on host and topic; `other`, unknown topics and bad hosts are refused', async () => {
    const alice = await login('apr-ask');
    const ask = await rules.createFromAnswer({ id: randomUUID(), userId: alice.userId, rememberable: { kind: 'ask', host: 'bankofamerica.com', matchKey: 'choose_date' } });
    expect(ask.rule).toMatchObject({ kind: 'ask', category: null, matchKey: 'choose_date', summary: 'Choose dates on bankofamerica.com' });
    for (const bad of [
      { kind: 'ask', host: 'bankofamerica.com', matchKey: 'other' },
      { kind: 'ask', host: 'bankofamerica.com', matchKey: 'press_anything' },
      { kind: 'gate', host: 'bankofamerica.com', category: 'shopping', matchKey: 'Pay' },
      { kind: 'gate', host: 'bankofamerica.com', category: 'payment', matchKey: '   ' },
      { kind: 'gate', host: '*.bankofamerica.com', category: 'payment', matchKey: 'Pay' },
      { kind: 'gate', host: 'www.bankofamerica.com', category: 'payment', matchKey: 'Pay' },
      { kind: 'gate', host: 'localhost', category: 'payment', matchKey: 'Pay' },
      { kind: 'gate', host: '', category: 'payment', matchKey: 'Pay' },
    ] as const) {
      await expect(rules.createFromAnswer({ id: randomUUID(), userId: alice.userId, rememberable: bad as never })).rejects.toMatchObject({ status: 422 });
    }
    // A scope the question does not have.
    await expect(rules.createFromAnswer(payQuestion(alice.userId), { scope: 'this_task' })).rejects.toMatchObject({ status: 422 });
    await expect(rules.createFromAnswer(payQuestion(alice.userId), { scope: 'this_chat' })).rejects.toMatchObject({ status: 422 });
  });
});

describe('matching through the service', () => {
  it("matches on the page's registrable domain; another user's rule never matches", async () => {
    const alice = await login('apr-match-a');
    const bob = await login('apr-match-b');
    await rules.createFromAnswer(payQuestion(alice.userId));
    const q = { kind: 'gate' as const, category: 'payment', matchKey: 'pay $#', taskId: null, conversationId: null, amount: null };
    expect(await rules.match(alice.userId, { ...q, pageUrl: 'https://secure.bankofamerica.com/pay' })).not.toBeNull();
    expect(await rules.match(alice.userId, { ...q, pageUrl: 'https://bankofamerica.com.evil.com/pay' })).toBeNull();
    expect(await rules.match(alice.userId, { ...q, pageUrl: null })).toBeNull();
    expect(await rules.match(bob.userId, { ...q, pageUrl: 'https://secure.bankofamerica.com/pay' })).toBeNull();
  });

  it('Pause all: nothing matches while it is on, and it is audited', async () => {
    const alice = await login('apr-pause');
    await rules.createFromAnswer(payQuestion(alice.userId));
    const q = { kind: 'gate' as const, category: 'payment', matchKey: 'pay $#', taskId: null, conversationId: null, amount: null, pageUrl: 'https://bankofamerica.com/' };
    const on = await call<{ paused: boolean }>(alice, 'PUT', '/api/approval-rules/paused', { paused: true });
    expect(on).toMatchObject({ statusCode: 200, data: { paused: true } });
    expect(await rules.match(alice.userId, q)).toBeNull();
    expect((await call<{ paused: boolean }>(alice, 'GET', '/api/approval-rules')).data.paused).toBe(true);
    await call(alice, 'PUT', '/api/approval-rules/paused', { paused: false });
    expect(await rules.match(alice.userId, q)).not.toBeNull();
    const actions = (await prisma.auditEvent.findMany({ where: { actorUserId: alice.userId, action: { startsWith: 'approvals.' } }, orderBy: { createdAt: 'asc' } })).map((e) => e.action);
    expect(actions).toEqual(['approvals.paused', 'approvals.resumed']);
  });
});

describe('the API', () => {
  it('lists, reads with uses, and 404s another user on every route', async () => {
    const alice = await login('apr-api-a');
    const bob = await login('apr-api-b');
    const { rule } = await rules.createFromAnswer(payQuestion(alice.userId));
    const list = await call<{ paused: boolean; rules: RuleView[] }>(alice, 'GET', '/api/approval-rules');
    expect(list.statusCode).toBe(200);
    expect(list.data).toMatchObject({ paused: false, rules: [expect.objectContaining({ id: rule.id })] });
    expect((await call<{ rules: RuleView[] }>(alice, 'GET', '/api/approval-rules?host=chase.com')).data.rules).toEqual([]);
    expect((await call<{ rules: RuleView[] }>(alice, 'GET', '/api/approval-rules?enabled=false')).data.rules).toEqual([]);
    const runId = await run(alice.userId);
    await rules.recordUse({ ...rule, userId: alice.userId, kind: 'gate', category: 'payment' }, { runId, stepSeq: 7 });
    const one = await call<RuleView>(alice, 'GET', `/api/approval-rules/${rule.id}`);
    expect(one.data).toMatchObject({ id: rule.id, useCount: 1, lastUsedRunId: runId, uses: [{ runId, stepSeq: 7 }] });

    expect((await call(bob, 'GET', '/api/approval-rules')).data).toMatchObject({ rules: [] });
    for (const [method, payload] of [['GET'], ['PATCH', { enabled: false }], ['DELETE']] as const) {
      const r = await call(bob, method, `/api/approval-rules/${rule.id}`, payload);
      expect({ method, status: r.statusCode, code: r.code }).toEqual({ method, status: 404, code: 'APPROVAL_RULE_NOT_FOUND' });
    }
    expect((await call(alice, 'GET', `/api/approval-rules/${randomUUID()}`)).statusCode).toBe(404);
  });

  it('a viewer may read but not change; nobody may POST a rule', async () => {
    const owner = await login('apr-viewer', 'viewer');
    expect((await call(owner, 'GET', '/api/approval-rules')).statusCode).toBe(200);
    expect((await call(owner, 'PUT', '/api/approval-rules/paused', { paused: true })).statusCode).toBe(403);
    const writer = await login('apr-post');
    const post = await call(writer, 'POST', '/api/approval-rules', { kind: 'gate', host: 'bankofamerica.com', category: 'payment', matchKey: 'pay' });
    expect([404, 405]).toContain(post.statusCode);
    expect(await prisma.approvalRule.count({ where: { userId: writer.userId } })).toBe(0);
  });

  it('PATCH narrows and refuses to widen, field by field', async () => {
    const alice = await login('apr-narrow');
    const task = await prisma.task.create({ data: { userId: alice.userId, name: 'Zelle to Paula', goal: 'Send money' } });
    const otherTask = await prisma.task.create({ data: { userId: alice.userId, name: 'Rent', goal: 'Pay rent' } });
    const chat = await prisma.conversation.create({ data: { userId: alice.userId, title: 'Bills' } as never });
    const { rule } = await rules.createFromAnswer(payQuestion(alice.userId));
    const url = `/api/approval-rules/${rule.id}`;
    const widen = async (payload: unknown, field: string) => {
      const r = await call(alice, 'PATCH', url, payload);
      expect({ field, status: r.statusCode, code: r.code }).toEqual({ field, status: 400, code: 'RULE_CANNOT_WIDEN' });
    };

    // maxAmount: set (narrows), lower (narrows), raise (widens), remove (widens).
    expect((await call<RuleView>(alice, 'PATCH', url, { maxAmount: 50 })).data.maxAmount).toBe(50);
    expect((await call<RuleView>(alice, 'PATCH', url, { maxAmount: 25.5 })).data.maxAmount).toBe(25.5);
    await widen({ maxAmount: 100 }, 'maxAmount up');
    await widen({ maxAmount: null }, 'maxAmount removed');

    // expiresAt: set, shorten, lengthen, remove.
    const far = new Date(Date.now() + 30 * 86_400_000).toISOString();
    const near = new Date(Date.now() + 7 * 86_400_000).toISOString();
    expect((await call<RuleView>(alice, 'PATCH', url, { expiresAt: far })).data.expiresAt).toBe(far);
    expect((await call<RuleView>(alice, 'PATCH', url, { expiresAt: near })).data.expiresAt).toBe(near);
    await widen({ expiresAt: far }, 'expiresAt later');
    await widen({ expiresAt: null }, 'expiresAt removed');

    // taskId: add, change, remove.
    const scoped = await call<RuleView>(alice, 'PATCH', url, { taskId: task.id });
    expect(scoped.data).toMatchObject({ taskId: task.id, taskName: 'Zelle to Paula' });
    await widen({ taskId: otherTask.id }, 'taskId changed');
    await widen({ taskId: null }, 'taskId removed');
    // An unknown task is refused.
    expect((await call(alice, 'PATCH', url, { conversationId: randomUUID() })).statusCode).toBe(422);

    // conversationId: add, remove.
    expect((await call<RuleView>(alice, 'PATCH', url, { conversationId: chat.id })).data.conversationId).toBe(chat.id);
    await widen({ conversationId: null }, 'conversationId removed');

    // enabled: disable, then re-enable (allowed).
    expect((await call<RuleView>(alice, 'PATCH', url, { enabled: false })).data.enabled).toBe(false);
    expect((await call<RuleView>(alice, 'PATCH', url, { enabled: true })).data.enabled).toBe(true);

    // Fields a patch cannot touch at all.
    for (const payload of [{ host: 'chase.com' }, { matchKey: 'pay all' }, { category: 'send' }, { kind: 'ask' }, {}]) {
      expect((await call(alice, 'PATCH', url, payload)).statusCode).toBe(400);
    }
    const stored = await prisma.approvalRule.findUniqueOrThrow({ where: { id: rule.id } });
    expect(stored).toMatchObject({ host: 'bankofamerica.com', matchKey: 'pay $#', category: 'payment', taskId: task.id, conversationId: chat.id, enabled: true });

    const actions = (await prisma.auditEvent.findMany({ where: { targetId: rule.id }, orderBy: { createdAt: 'asc' } })).map((e) => e.action);
    expect(actions).toEqual(expect.arrayContaining(['approval_rule.created', 'approval_rule.narrowed', 'approval_rule.disabled', 'approval_rule.enabled']));
    const narrowed = await prisma.auditEvent.findFirstOrThrow({ where: { targetId: rule.id, action: 'approval_rule.narrowed' } });
    expect(narrowed.meta).toMatchObject({ ruleId: rule.id, kind: 'gate', host: 'bankofamerica.com', category: 'payment', fields: ['maxAmount'] });
  });

  it('DELETE removes the rule and its uses, and is audited', async () => {
    const alice = await login('apr-delete');
    const { rule } = await rules.createFromAnswer(payQuestion(alice.userId));
    await rules.recordUse({ id: rule.id, userId: alice.userId, kind: 'gate', host: rule.host, category: 'payment' }, { runId: await run(alice.userId) });
    expect((await call(alice, 'DELETE', `/api/approval-rules/${rule.id}`)).statusCode).toBe(204);
    expect(await prisma.approvalRule.count({ where: { id: rule.id } })).toBe(0);
    expect(await prisma.approvalRuleUse.count({ where: { ruleId: rule.id } })).toBe(0);
    expect(await prisma.auditEvent.count({ where: { targetId: rule.id, action: 'approval_rule.deleted' } })).toBe(1);
  });
});

describe('uses', () => {
  it(`are recorded, counted and capped at the newest ${APPROVAL_RULE_USES_KEPT}`, async () => {
    const alice = await login('apr-uses');
    const { rule } = await rules.createFromAnswer(payQuestion(alice.userId));
    const old = new Date(Date.now() - 86_400_000);
    await prisma.approvalRuleUse.createMany({ data: Array.from({ length: APPROVAL_RULE_USES_KEPT + 5 }, (_, n) => ({ ruleId: rule.id, stepSeq: n, usedAt: new Date(old.getTime() + n * 1000) })) });
    const runId = await run(alice.userId);
    await rules.recordUse({ id: rule.id, userId: alice.userId, kind: 'gate', host: rule.host, category: 'payment' }, { runId, stepSeq: 999 });
    expect(await prisma.approvalRuleUse.count({ where: { ruleId: rule.id } })).toBe(APPROVAL_RULE_USES_KEPT);
    const newest = await prisma.approvalRuleUse.findFirstOrThrow({ where: { ruleId: rule.id }, orderBy: { usedAt: 'desc' } });
    expect(newest).toMatchObject({ runId, stepSeq: 999 });
    // The oldest six went.
    expect(await prisma.approvalRuleUse.count({ where: { ruleId: rule.id, stepSeq: { lt: 6 } } })).toBe(0);
    const stored = await prisma.approvalRule.findUniqueOrThrow({ where: { id: rule.id } });
    expect(stored).toMatchObject({ useCount: 1, lastUsedRunId: runId });
    const used = await prisma.auditEvent.findFirstOrThrow({ where: { targetId: rule.id, action: 'approval_rule.used' } });
    expect(used.meta).toEqual({ ruleId: rule.id, kind: 'gate', host: 'bankofamerica.com', category: 'payment', runId, stepSeq: 999 });
  });

  it("deleting the run forgets it in the rule and its uses; the use stays", async () => {
    const alice = await login('apr-rundel');
    const { rule } = await rules.createFromAnswer(payQuestion(alice.userId));
    const runId = await run(alice.userId);
    await rules.recordUse({ id: rule.id, userId: alice.userId, kind: 'gate', host: rule.host, category: 'payment' }, { runId, stepSeq: 3 });
    await app.get(RunDeleteService, { strict: false }).deleteOne(alice.userId, runId);
    expect(await prisma.approvalRule.findUniqueOrThrow({ where: { id: rule.id } })).toMatchObject({ lastUsedRunId: null, useCount: 1 });
    expect(await prisma.approvalRuleUse.findFirstOrThrow({ where: { ruleId: rule.id } })).toMatchObject({ runId: null, stepSeq: 3 });
  });
});

describe('the busy saved approval alert', () => {
  it('fires above the threshold (default 20 a day) and not at it', async () => {
    const evaluation = app.get(AlertsEvaluationService, { strict: false });
    setAlertSources(app.get(HexactraAlertsService, { strict: false }).sources);
    const alertRule = await prisma.alertRule.findUniqueOrThrow({ where: { key: 'hexactra.approval_busy' } });
    expect(alertRule).toMatchObject({ enabled: true, config: { maxUses: 20, windowHours: 24 } });
    const alice = await login('apr-alert');
    const { rule } = await rules.createFromAnswer(payQuestion(alice.userId));
    await prisma.approvalRuleUse.createMany({ data: Array.from({ length: 20 }, () => ({ ruleId: rule.id })) });
    const at = (await evaluation.observe(alertRule)).find((o) => o.labels['approval_rule.id'] === rule.id);
    expect(at).toBeUndefined();
    await prisma.approvalRuleUse.create({ data: { ruleId: rule.id } });
    const over = (await evaluation.observe(alertRule)).find((o) => o.labels['approval_rule.id'] === rule.id);
    expect(over).toMatchObject({ breached: true, value: 21 });
    expect(over!.summary).toMatch(/used 21 times in 24 h \(limit 20\)/);
    expect(over!.summary).not.toMatch(/pay \$/i);
  });
});

describe('the user goes, the rules go', () => {
  it('deleting the user removes their rules and uses', async () => {
    const alice = await login('apr-user-del');
    const { rule } = await rules.createFromAnswer(payQuestion(alice.userId));
    await prisma.approvalRuleUse.create({ data: { ruleId: rule.id } });
    await prisma.user.delete({ where: { id: alice.userId } });
    expect(await prisma.approvalRule.count({ where: { id: rule.id } })).toBe(0);
    expect(await prisma.approvalRuleUse.count({ where: { ruleId: rule.id } })).toBe(0);
  });
});
