// What the saved-card tools need of the run (E37.7): closures over the run's own helpers, so the tools reach for nothing else.
import { pageOf } from '../saved-identity';
import { currentUrl } from '@marinoscar/hexactra-browser-agent/page';
import type { SavedCardToolsContext } from '../saved-card-tools';
import type { HostContext } from './context';
import { loginOpts, noteFilledInput, persistSavedSecrets } from './tools/secrets-support';

/** A rememberable question with the scopes this run offers: always everywhere; this task or this chat when it has one. */
function withScopes<T extends object>(ctx: HostContext, r: T | null): (T & { scopes: ('everywhere' | 'this_task' | 'this_chat')[] }) | null {
  return r ? { ...r, scopes: ['everywhere', ...(ctx.run.taskId ? (['this_task'] as const) : []), ...(ctx.run.conversationId ? (['this_chat'] as const) : [])] } : null;
}

export function buildSavedCardContext(ctx: HostContext): SavedCardToolsContext {
  const { d, db, fabric, used } = ctx.ext;
  const { memory } = ctx;
  const run = ctx.run;
  return {
    userId: run.userId,
    orgId: run.orgId,
    runId: run.id,
    taskId: run.taskId,
    conversationId: run.conversationId,
    runInputs: ctx.ext.run.inputs,
    task: ctx.ext.run.task ? { parameters: ctx.ext.run.task.parameters } : null,
    unattended: ctx.ext.unattended,
    unattendedPayments: ctx.ext.run.task?.unattendedPayments === 'allow' ? 'allow' : 'ask',
    appConfirmsPurchases: ctx.ext.appConfirmsPurchases,
    sessionId: fabric.sessionId,
    session: fabric.session,
    memory: () => (memory.savedCards ??= { refs: {} }),
    persist: () => persistSavedSecrets(ctx),
    loginOpts: loginOpts(ctx),
    approvals: d.approvals,
    notifier: d.notifier,
    run: { id: run.id, goal: run.goal, taskId: run.taskId, trigger: run.trigger as string, conversationId: run.conversationId },
    log: d.log,
    currentUrl: () => currentUrl(ctx),
    siteAllowed: ctx.ext.sites.allowed,
    budgetStop: () => ctx.budgetStop(),
    record: (...a) => ctx.record(...a),
    setActivity: (...a) => ctx.setActivity(...a),
    askPerson: (spec, started) => ctx.askPerson(spec, started),
    withScopes: (r) => withScopes(ctx, r),
    noteFilled: async (target, label) => {
      if (target.selector) return noteFilledInput(ctx, target.selector, label);
      const page = pageOf(await currentUrl(ctx));
      const sc = (memory.savedCards ??= { refs: {} });
      if (page && target.x !== null && target.y !== null && !(sc.points ?? []).some((p) => p.page === page && p.x === target.x && p.y === target.y)) sc.points = [...(sc.points ?? []), { page, x: target.x, y: target.y }].slice(-20);
    },
    usedCards: () => used.cards,
    setUsedCards: async (next) => {
      used.cards = next;
      await db.run.updateMany({ where: { id: run.id }, data: { usedSavedCards: next as never } });
    },
    stepSeq: () => ctx.state.seq,
    confirmedAction: (prompt, action) => ctx.ports.store.appendConfirmedAction({ seq: ctx.state.seq, prompt, action, at: new Date() }),
    providerOutcome: async (o) => {
      await d.secrets?.outcome(run.userId, o === 'ok' ? { ok: true } : { ok: false, code: o });
    },
    metric: (o) => d.tasks.metrics.cardUse(o),
    providerAddress: async () => (await d.secrets?.providerAddress(run.userId)) ?? null,
    warnPrompt: (merchant) =>
      `Warning: the agent tried to pay with a saved card at ${merchant}, but that shop (or the payment frame on it) is not what you allowed this card for. Nothing was typed. Please look at the browser; the agent will not use a card again in this run.`,
  };
}
