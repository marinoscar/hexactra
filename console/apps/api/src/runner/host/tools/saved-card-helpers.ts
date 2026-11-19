// The runner tools that pay with a saved card (E37.7, #596): `saved_cards`, `declare_charge`, `pay_with_saved_card` and
// `confirm_charge`, offered only when the run may use cards. Built here, not in the goal runner, from the runner's own helpers
// (`SavedCardToolsContext`) so the rules of a card are in one place.
//
// THE RULES, IN ORDER (every one is enforced by this server, never by the model's good will):
//   1. Cards are offered only with the task's or chat's `useSavedCards`, the AI app's `allowSavedCards` (default off), saved logins
//      on and a provider whose grant holds the card scopes.
//   2. Nothing is typed before the agent DECLARED the charge (`declare_charge`): the amount and currency it read on the page, the
//      merchant host the FABRIC reported (not the model's words), what is being bought. The provider checks the amount against the
//      owner's grant; the owner sees it in the approval.
//   3. The merchant must be an `https` page the run may visit, on the same registrable domain as the declared charge.
//   4. The owner approves each merchant: a confirmation card (merchant, card, amount, what is bought). "Don't ask again" makes a
//      remembered approval bound to the merchant AND the card with a REQUIRED amount limit; it is matched by the server.
//   5. An unattended run (not started from a chat) types a card only with the task's `unattendedPayments: allow` AND such a
//      remembered approval; otherwise it waits for the owner. An AI app's "confirm purchases" limit always asks.
//   6. Number, expiry, holder name and postal code are typed in that order, the security code LAST, in one tool call with no
//      screenshot between them; the pay click is a separate action that passes through the confirmation gate, and the approval for
//      the card at this merchant covers it for the declared amount (once).
//   7. A crash after the card was typed and before the pay click, or around the pay click, never leads to a second payment: the
//      phases are saved before each step, and a pay click that may or may not have happened ends the run's card use.
//
// What a tool returns, a step records and a notification says: a card's brand and last four digits, a merchant's host, amounts.
// Never a number, an expiry or a security code: the fabric types them and answers `{ typed: true }`.
import { Logger } from '@nestjs/common';
import type { ApprovalRule } from '@prisma/client';
import { z } from 'zod';

import { cardMatchKey, registrableDomain } from '../../../approvals/approval-match';
import type { ApprovalRulesService } from '../../../approvals/approval-rules.service';
import { knownAmount } from '../../../approvals/approval-runner';
import { questionSpecSchema, type QuestionSpec } from '../../../questions/questions.contract';
import type { RunNotifier } from '../../../tasks/run-notifier';
import { FabricError } from '../../../fabric/fabric.client';
import { SecretsProviderError } from '../../../secrets/secrets-provider.port';
import type { RunActivityPhase, runActivity } from '@marinoscar/hexactra-agent/activity';
import type { CardFieldName, FabricSession } from '../../fabric-session';
import type { GateTarget } from '@marinoscar/hexactra-browser-agent/policy';
import {
  amountsAgree,
  appendUsedSavedCard,
  cardFailureOf,
  cardLookupOf,
  cardLookupText,
  CARD_FIELD_ORDER,
  cardWords,
  cents,
  isAmount,
  merchantHostOf,
  moneyWords,
  normaliseAmount,
  normaliseCurrency,
  safeText,
  siteOfHost,
  type CardApproval,
  type CardFailure,
  type CardTarget,
  type LookedUpCard,
  type SavedCardsMemory,
  type UsedSavedCard,
} from '../../saved-cards';

/** A model's target for one card field: a selector in the page, or x and y for a field inside an embedded payment frame. */
export const targetSchema = z.object({
  selector: z.string().max(2000).nullable().describe('A CSS selector of the input in the page itself; null for a field inside an embedded frame.'),
  x: z.number().int().min(0).nullable().describe('Viewport x (CSS pixels) of the input, for a field inside an embedded payment frame; null when you give a selector.'),
  y: z.number().int().min(0).nullable().describe('Viewport y (CSS pixels) of the input; null when you give a selector.'),
});

/** What the tools need of the runner. Closures over its state: the tools never reach for anything else. */
export interface SavedCardToolsContext {
  userId: string;
  orgId: string | null;
  runId: string;
  taskId: string | null;
  conversationId: string | null;
  /** The run's `inputs` and task, for the amount the owner's own inputs make known (#552). */
  runInputs: unknown;
  task: { parameters?: unknown } | null;
  /** Not started from a chat: a schedule, the API, MCP, a task run with nobody in a thread. */
  unattended: boolean;
  /** The task's `unattendedPayments`: an unattended run types a card only with `allow` AND a remembered approval. */
  unattendedPayments: 'ask' | 'allow';
  /** The run's AI app asks before purchases (#464): then a remembered approval never applies. */
  appConfirmsPurchases: boolean;
  sessionId: () => string;
  session: FabricSession;
  memory: () => SavedCardsMemory;
  /** The run's memory is written at once, before and after each field and around the pay click: a crash finds what was done. */
  persist: () => Promise<void>;
  loginOpts: { runId: string; clientLabel: string };
  approvals: ApprovalRulesService | undefined;
  notifier: RunNotifier | undefined;
  run: { id: string; goal: string; taskId: string | null; trigger: string; conversationId: string | null };
  log: Logger;
  /** The URL of the active tab, as the fabric reports it; never the model's words. */
  currentUrl: () => Promise<string | null>;
  siteAllowed: (url: string) => boolean;
  /** The budget line when a budget is spent (the tool then returns it), else null. */
  budgetStop: () => string | null;
  record: (kind: string, action: string | null, args: Record<string, unknown> | null, ok: boolean, summary: string, started: number, reasoning?: string, extra?: { secret?: boolean }) => Promise<void>;
  setActivity: (phase: RunActivityPhase, opts?: Parameters<typeof runActivity>[1]) => Promise<void>;
  askPerson: (spec: QuestionSpec, started: number) => Promise<boolean>;
  withScopes: <T extends object>(r: T | null) => (T & { scopes: ('everywhere' | 'this_task' | 'this_chat')[] }) | null;
  /** Remember where a card field was typed, so no picture shows it (a selector in the page, or a point inside a frame). */
  noteFilled: (target: CardTarget, label: string) => Promise<void>;
  usedCards: () => UsedSavedCard[];
  setUsedCards: (next: UsedSavedCard[]) => Promise<void>;
  /** The step the run just recorded, for a confirmed-action entry and a rule's use. */
  stepSeq: () => number;
  confirmedAction: (prompt: string, action: string) => Promise<void>;
  /** The outcome of one provider call, for the connection's status. */
  providerOutcome: (outcome: NonNullable<CardFailure['outcome']> | 'ok') => Promise<void>;
  /** The saved logins' and cards' `stopped` flag also ends the run's other card tools. */
  metric: (outcome: 'typed' | 'asked' | 'approved' | 'declined' | 'refused_amount' | 'refused_shop' | 'refused_limit' | 'refused_other' | 'unattended_waits' | 'mismatch') => void;
  /** The provider's address, to point the owner to it. */
  providerAddress: () => Promise<string | null>;
  /** The warning card for a shop or frame that is not what the owner allowed. */
  warnPrompt: (merchant: string) => string;
}

/** The owner's card question's facts, kept so the resumed run can tell what was approved. */
export function cardAskOf(card: LookedUpCard, provider: string, site: string, amount: string, currency: string): NonNullable<SavedCardsMemory['asking']> {
  return { cardRef: card.cardRef, itemId: card.itemId, provider, site, amount, currency };
}

/** An approval the resumed run reads from the owner's "approve" answer to the card question. */
export function approvalFromAsk(ask: NonNullable<SavedCardsMemory['asking']>): CardApproval {
  return { cardRef: ask.cardRef, itemId: ask.itemId, provider: ask.provider, site: ask.site, amount: ask.amount, currency: ask.currency, via: 'owner', typed: false };
}

/** Whether the approval for a card payment covers this click: the pay button of the approved merchant, before it was pressed. */
export function cardCovers(memory: SavedCardsMemory | undefined, target: GateTarget): boolean {
  const a = memory?.approval;
  if (!a || !a.typed || a.pay === 'done' || a.pay === 'unknown' || memory?.paymentUnknown || memory?.stopped) return false;
  if (target.category !== 'payment' && target.category !== 'purchase') return false;
  return siteOfHost(target.host) === a.site;
}

/** Before the click the approval covers: the intent is saved first, so a crash around the click is recognised. */
export async function beginCardPay(ctx: Pick<SavedCardToolsContext, 'memory' | 'persist'>, target: GateTarget | null): Promise<boolean> {
  if (!target || !cardCovers(ctx.memory(), target)) return false;
  ctx.memory().approval!.pay = 'intent';
  await ctx.persist();
  return true;
}

/** After the click: carried out (`done`: nothing covers another click, the charge is spent) or it failed (the approval stands for a retry). */
export async function endCardPay(ctx: Pick<SavedCardToolsContext, 'memory' | 'persist'>, carriedOut: boolean): Promise<void> {
  const sc = ctx.memory();
  const a = sc.approval;
  if (!a) return;
  if (carriedOut) {
    a.pay = 'done';
    sc.charge = null;
    sc.fields = {};
  } else {
    a.pay = undefined;
  }
  await ctx.persist();
}

/** A job that died around the pay click leaves `intent`: the payment may or may not have happened. Returns the line the model reads, or null. */
export function reconcileCardsOnStart(sc: SavedCardsMemory | undefined): string[] {
  const lines: string[] = [];
  if (!sc) return lines;
  if (sc.approval?.pay === 'intent') {
    sc.approval.pay = 'unknown';
    sc.paymentUnknown = true;
    lines.push(
      '(The run was interrupted while the pay button was being pressed: the payment may or may not have gone through. Do not press pay again and do not use a card again in this run. Look at the page and at what it says about the order; if you cannot tell, ask the owner (request_human) before doing anything else.)',
    );
  }
  const typing = Object.entries(sc.fields ?? {}).filter(([, v]) => v === 'typing').map(([k]) => k);
  if (typing.length) {
    for (const k of typing) delete sc.fields![k as CardFieldName];
    lines.push('(A card entry was cut off while a field was being typed. Look at the page and read which card fields are filled, then call pay_with_saved_card again for the fields that are not. Fields already typed are not typed again.)');
  }
  return lines;
}

export const FAIL_TARGET = 'Give exactly one of selector, or x and y, for each field.';

export function targetOf(t: z.infer<typeof targetSchema> | null | undefined): CardTarget | null | 'bad' {
  if (!t) return null;
  const hasSel = typeof t.selector === 'string' && t.selector.length > 0;
  const hasPoint = t.x !== null && t.x !== undefined && t.y !== null && t.y !== undefined;
  if (hasSel === hasPoint) return 'bad';
  return { selector: hasSel ? t.selector : null, x: hasPoint ? t.x! : null, y: hasPoint ? t.y! : null };
}
/** What the card tools share: the memory, the refusal and the lookup every tool needs first. */
export function cardHelpers(ctx: SavedCardToolsContext) {
  const sc = () => ctx.memory();

  /** Refuse before anything is fetched or typed: a failed step the model reads, and the metric. */
  const refuse = async (action: string, args: Record<string, unknown>, started: number, text: string, summary: string, metric: Parameters<SavedCardToolsContext['metric']>[0] = 'refused_other'): Promise<string> => {
    ctx.metric(metric);
    await ctx.record('action', action, args, false, summary, started, undefined, { secret: true });
    return text;
  };

  const usableLookup = async (action: string, args: Record<string, unknown>, started: number): Promise<{ lookup: NonNullable<SavedCardsMemory['lookup']> } | string> => {
    const spent = ctx.budgetStop();
    if (spent) return spent;
    if (sc().stopped) return refuse(action, args, started, 'Saved cards are switched off for the rest of this run, because a shop or payment frame was refused as not the one the owner allowed. Do not try another card or site. Tell the owner.', 'refused: saved cards are off for this run', 'refused_shop');
    if (sc().paymentUnknown) return refuse(action, args, started, 'A payment of this run may already have been made and cannot be told. Do not pay again. Look at the page; if you cannot tell, ask the owner (request_human).', 'refused: a payment of this run may already have happened');
    const lookup = sc().lookup;
    if (!lookup) return refuse(action, args, started, 'Call saved_cards first, on the shop page you are paying on.', 'refused: no lookup of this page yet');
    return { lookup };
  };


  const askOwner = async (card: LookedUpCard, provider: string, site: string, host: string, amount: string, currency: string, description: string, started: number): Promise<string> => {
    const words = cardWords(card);
    const spec = questionSpecSchema.parse({
      kind: 'confirmation',
      input: 'confirm',
      risk: 'high',
      prompt: `The agent wants to pay with ${words} at ${host}: ${moneyWords(amount, currency)}${description ? ` for ${description}` : ''}. The card number, expiry and code are typed by the system and are never shown to the agent. Allow this payment?`,
      confirmLabel: 'Allow this payment',
      denyLabel: 'Do not pay',
    });
    spec.rememberable = ctx.withScopes({ kind: 'gate' as const, host: site, category: 'payment', matchKey: cardMatchKey(currency), summary: `Pay with ${words} on ${site}`, cardRef: card.cardRef, requiresLimit: true, currency, amount });
    sc().asking = cardAskOf(card, provider, site, amount, currency);
    await ctx.persist();
    ctx.metric('asked');
    if (await ctx.askPerson(spec, started)) return `The owner is asked to allow paying ${moneyWords(amount, currency)} with ${words} at ${host}. Wait for the answer; do not type a card yourself.`;
    sc().asking = null;
    return 'Could not reach the owner right now. Do not type a card yourself.';
  };

  /** A remembered approval that lets this payment through: bound to the shop and the card, with its amount limit; never when an app or an unattended run forbids it. */
  const rememberedApproval = async (card: LookedUpCard, provider: string, url: string, amount: string, currency: string): Promise<ApprovalRule | null> => {
    if (!ctx.approvals || ctx.appConfirmsPurchases) return null;
    if (ctx.unattended && ctx.unattendedPayments !== 'allow') return null;
    try {
      return await ctx.approvals.match(ctx.userId, {
        kind: 'gate',
        pageUrl: url,
        category: 'payment',
        matchKey: cardMatchKey(currency),
        cardRef: card.cardRef,
        taskId: ctx.taskId,
        conversationId: ctx.conversationId,
        amount: Number(amount),
      });
    } catch (e) {
      ctx.log.warn(`run ${ctx.runId}: could not read saved approvals: ${e instanceof Error ? e.message : String(e)}`);
      return null;
    }
  };

  return { sc, refuse, usableLookup, askOwner, rememberedApproval };
}
export type CardHelpers = ReturnType<typeof cardHelpers>;

/** The provider or the browser host refused for good (nothing was typed), as opposed to an outcome nobody knows (a timeout, a cancel). */
export function definitive(e: unknown): boolean {
  return e instanceof SecretsProviderError && !['timed_out', 'cancelled', 'unknown'].includes((e as SecretsProviderError).code);
}
