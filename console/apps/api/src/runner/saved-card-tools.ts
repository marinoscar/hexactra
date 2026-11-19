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
import { defineTool, type AiDefinedTool } from '@marinoscar/platform-api/ai';
import type { ApprovalRule } from '@prisma/client';
import { z } from 'zod';

import { cardMatchKey, registrableDomain } from '../approvals/approval-match';
import type { ApprovalRulesService } from '../approvals/approval-rules.service';
import { knownAmount } from '../approvals/approval-runner';
import { questionSpecSchema, type QuestionSpec } from '../questions/questions.contract';
import type { RunNotifier } from '../tasks/run-notifier';
import { FabricError } from '../fabric/fabric.client';
import { SecretsProviderError } from '../secrets/secrets-provider.port';
import type { RunActivityPhase, runActivity } from './activity';
import type { CardFieldName, FabricSession } from './fabric-session';
import type { GateTarget } from './policy';
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
} from './saved-cards';

/** A model's target for one card field: a selector in the page, or x and y for a field inside an embedded payment frame. */
const targetSchema = z.object({
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

const FAIL_TARGET = 'Give exactly one of selector, or x and y, for each field.';

function targetOf(t: z.infer<typeof targetSchema> | null | undefined): CardTarget | null | 'bad' {
  if (!t) return null;
  const hasSel = typeof t.selector === 'string' && t.selector.length > 0;
  const hasPoint = t.x !== null && t.x !== undefined && t.y !== null && t.y !== undefined;
  if (hasSel === hasPoint) return 'bad';
  return { selector: hasSel ? t.selector : null, x: hasPoint ? t.x! : null, y: hasPoint ? t.y! : null };
}

export function buildSavedCardTools(ctx: SavedCardToolsContext): AiDefinedTool[] {
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

  const saved_cards = defineTool({
    name: 'saved_cards',
    description:
      'List the payment cards the owner allowed at the shop now on screen: none, or `{ ref, name, brand, last4, limit, expires, securityCode }` per card. You never see a card number, an expiry or a code, and you never type one yourself. Call it on the shop\'s checkout page before paying.',
    parameters: z.object({}),
    execute: async () => {
      const started = Date.now();
      const spent = ctx.budgetStop();
      if (spent) return spent;
      if (sc().stopped) return refuse('saved_cards', {}, started, 'Saved cards are switched off for the rest of this run. Tell the owner.', 'refused: saved cards are off for this run', 'refused_shop');
      let found;
      try {
        found = await ctx.session.secretsLookup(ctx.sessionId(), 'card', ctx.loginOpts);
      } catch (e) {
        if (!(e instanceof SecretsProviderError) && !(e instanceof FabricError)) throw e;
        const f = cardFailureOf(e instanceof SecretsProviderError ? e.code : 'unavailable', e instanceof SecretsProviderError ? e.retryAfterSeconds : undefined);
        if (f.outcome) await ctx.providerOutcome(f.outcome);
        ctx.metric('refused_other');
        await ctx.record('action', 'saved_cards', {}, false, f.summary, started, undefined, { secret: true });
        return f.text;
      }
      await ctx.providerOutcome('ok');
      const lookup = cardLookupOf(sc(), found);
      sc().lookup = lookup;
      await ctx.record('action', 'saved_cards', {}, true, `looked up saved cards: ${lookup.cards.length === 0 ? 'none' : `${lookup.cards.length} card${lookup.cards.length === 1 ? '' : 's'}`}`, started);
      await ctx.persist();
      return cardLookupText(lookup, false);
    },
  });

  const declare_charge = defineTool({
    name: 'declare_charge',
    description:
      "Say what you are about to pay, BEFORE typing a card: the exact total you read on the page (a decimal such as 42.50), its currency (ISO 4217, such as USD) and what is being bought. The system records it, shows it to the owner in the approval and checks it against the owner's limit. The shop is the page now on screen. Nothing is typed without it.",
    parameters: z.object({ amount: z.string().min(1).max(20), currency: z.string().min(3).max(3), description: z.string().min(1).max(200) }),
    execute: async ({ amount, currency, description }) => {
      const started = Date.now();
      const args = { amount, currency, description: safeText(description, 120) };
      const spent = ctx.budgetStop();
      if (spent) return spent;
      if (sc().stopped) return refuse('declare_charge', args, started, 'Saved cards are switched off for the rest of this run. Tell the owner.', 'refused: saved cards are off for this run', 'refused_shop');
      if (sc().paymentUnknown) return refuse('declare_charge', args, started, 'A payment of this run may already have been made and cannot be told. Do not pay again. Ask the owner (request_human).', 'refused: a payment of this run may already have happened');
      const amt = normaliseAmount(amount);
      const cur = normaliseCurrency(currency);
      if (!amt || !isAmount(amt)) return refuse('declare_charge', args, started, 'The amount must be the total as a plain decimal with at most two places, for example 42.50.', 'refused: not a valid amount');
      if (!cur) return refuse('declare_charge', args, started, 'The currency must be three letters (ISO 4217), for example USD.', 'refused: not a valid currency');
      const url = await ctx.currentUrl();
      const host = merchantHostOf(url);
      if (!host || !url) return refuse('declare_charge', args, started, "The page is not an https page, or its address cannot be read. A card is only paid on an https shop page: open the shop's checkout and try again.", 'refused: the page is not an https shop page', 'refused_shop');
      if (!ctx.siteAllowed(url)) return refuse('declare_charge', args, started, 'That site is not allowed for this task. Do not pay there.', 'refused: the site is not allowed', 'refused_shop');
      // The owner's own amount for this task (a money input, #552) is a ceiling for what the agent may declare.
      const owners = knownAmount({ inputs: ctx.runInputs, task: ctx.task });
      if (owners !== null && cents(amt) > Math.round(owners * 100)) return refuse('declare_charge', args, started, `That is more than the amount the owner set for this task (${owners.toFixed(2)}). Do not pay. Tell the owner.`, 'refused: more than the amount the owner set', 'refused_amount');
      const memory = sc();
      memory.charge = { amount: amt, currency: cur, merchantHost: host, description: safeText(description, 160), declaredAt: new Date().toISOString() };
      // A new charge is a new payment: what the last one left (its approval, its fields) does not carry over.
      if (memory.approval && (memory.approval.pay === 'done' || memory.approval.amount !== amt || memory.approval.currency !== cur || memory.approval.site !== siteOfHost(host))) {
        memory.approval = null;
        memory.fields = {};
      }
      await ctx.record('action', 'declare_charge', args, true, `declared a charge of ${moneyWords(amt, cur)} at ${host}`, started);
      await ctx.persist();
      return `Recorded: ${moneyWords(amt, cur)} at ${host}. Now call saved_cards if you have not on this page, then pay_with_saved_card.`;
    },
  });

  /** The question the owner answers before a card is typed at a shop. */
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

  const pay_with_saved_card = defineTool({
    name: 'pay_with_saved_card',
    description:
      'Type a saved card into the checkout form, after declare_charge: the system types the number, then the expiry, the name and the postal code, and the security code last, with real input; you never see them. `ref` comes from saved_cards. For each field the form has, give where it is: a selector, or x and y for a field inside an embedded payment frame (a card number box that is part of another site\'s frame). `expiry` is one combined MM/YY input; use exp_month and exp_year when they are separate. number is required; give security_code only if the form asks for it and saved_cards says it is allowed; null for the rest. Typing the card commits nothing: pressing the pay button does. Pressing it needs the owner\'s approval, which the system has recorded for this amount.',
    parameters: z.object({
      ref: z.string().min(1).max(40),
      fields: z.object({
        number: targetSchema,
        expiry: targetSchema.nullable(),
        exp_month: targetSchema.nullable(),
        exp_year: targetSchema.nullable(),
        holder_name: targetSchema.nullable(),
        postal_code: targetSchema.nullable(),
        security_code: targetSchema.nullable(),
      }),
    }),
    execute: async ({ ref, fields }) => {
      const started = Date.now();
      const args = { ref, fields: Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== null).map(([k, v]) => [k, v!.selector ? { selector: v!.selector } : { x: v!.x, y: v!.y }])) };
      const ok = await usableLookup('pay_with_saved_card', args, started);
      if (typeof ok === 'string') return ok;
      const { lookup } = ok;
      const card = lookup.cards.find((c) => c.ref === ref);
      if (!card) return refuse('pay_with_saved_card', args, started, `There is no saved card "${ref}". Call saved_cards again for this page and use a reference it gives.`, 'refused: unknown reference');
      const charge = sc().charge;
      if (!charge) return refuse('pay_with_saved_card', args, started, 'Call declare_charge first: the exact total, its currency and what is being bought. Nothing is typed without it.', 'refused: no charge was declared');

      // The shop: https, allowed for this task, the same site the charge was declared on and the card was looked up for.
      const url = await ctx.currentUrl();
      const host = merchantHostOf(url);
      const site = siteOfHost(host);
      if (!url || !host || !site) return refuse('pay_with_saved_card', args, started, 'The page is not an https page, or its address cannot be read, so nothing was typed. A card is only typed into an https shop page.', 'refused: the page is not an https shop page', 'refused_shop');
      if (!ctx.siteAllowed(url)) return refuse('pay_with_saved_card', args, started, 'That site is not allowed for this task. Nothing was typed.', 'refused: the site is not allowed', 'refused_shop');
      if (site !== siteOfHost(charge.merchantHost)) return refuse('pay_with_saved_card', args, started, 'This page is not the shop the charge was declared for. Nothing was typed. Call declare_charge on the shop you are paying, or stop and tell the owner.', 'refused: the page is not the shop of the declared charge', 'refused_shop');
      if (registrableDomain(lookup.origin) !== site) return refuse('pay_with_saved_card', args, started, 'The page changed since saved_cards looked it up. Call saved_cards again for the shop you are on.', 'refused: the page changed since the lookup');
      if (charge.currency !== card.currency) return refuse('pay_with_saved_card', args, started, `The owner allowed this card at this shop in ${card.currency}, but the charge is in ${charge.currency}. Nothing was typed. ${'Tell the owner and do not try another card or shop.'}`, 'refused: not the currency the owner allowed', 'refused_amount');
      if (cents(charge.amount) > cents(card.maxAmount)) return refuse('pay_with_saved_card', args, started, `The charge is above what the owner allowed for this card at this shop (${moneyWords(card.maxAmount, card.currency)}). Nothing was typed. Tell the owner and do not try another amount or card.`, "refused: the amount is above the owner's limit for this card", 'refused_amount');

      // The fields, in the order they are typed.
      const wanted: { field: CardFieldName; target: CardTarget }[] = [];
      for (const f of CARD_FIELD_ORDER) {
        const t = targetOf((fields as Record<string, z.infer<typeof targetSchema> | null>)[f]);
        if (t === 'bad') return refuse('pay_with_saved_card', args, started, `${FAIL_TARGET} (field ${f})`, 'refused: a field needs exactly one target');
        if (t) wanted.push({ field: f, target: t });
      }
      const has = (f: CardFieldName) => wanted.some((w) => w.field === f);
      if (!has('number')) return refuse('pay_with_saved_card', args, started, 'Give the card number field.', 'refused: no card number field');
      if (!has('expiry') && !(has('exp_month') && has('exp_year'))) return refuse('pay_with_saved_card', args, started, 'Give the expiry: one expiry field, or exp_month and exp_year.', 'refused: no expiry field');
      if (has('expiry') && (has('exp_month') || has('exp_year'))) return refuse('pay_with_saved_card', args, started, 'Give either one expiry field or exp_month and exp_year, not both.', 'refused: both expiry forms');
      if (has('security_code') && !card.securityCode) {
        return refuse(
          'pay_with_saved_card',
          args,
          started,
          'The owner did not allow the security code for this card at this shop. Ask the owner to type it: call request_human with kind "other" and input "secret", then type_handoff_secret into the code field. Call pay_with_saved_card again without security_code for the other fields first.',
          'refused: the security code is not allowed for this card',
        );
      }

      // The approval: this card, this shop, this amount, in this run, or a remembered approval within its limit.
      const memory = sc();
      let approval = memory.approval;
      const covers = approval && approval.cardRef === card.cardRef && approval.site === site && approval.amount === charge.amount && approval.currency === charge.currency;
      let rule: ApprovalRule | null = null;
      if (!covers) {
        approval = null;
        rule = await rememberedApproval(card, lookup.provider, url, charge.amount, charge.currency);
        if (!rule) {
          if (ctx.unattended) ctx.metric('unattended_waits');
          return askOwner(card, lookup.provider, site, host, charge.amount, charge.currency, charge.description, started);
        }
        approval = { cardRef: card.cardRef, itemId: card.itemId, provider: lookup.provider, site, amount: charge.amount, currency: charge.currency, via: 'rule', ruleId: rule.id, typed: false };
        memory.approval = approval;
        memory.fields = {};
        ctx.metric('approved');
      }
      const ap = approval!;
      if (ap.pay === 'done') return refuse('pay_with_saved_card', args, started, 'This charge was already paid. Do not pay again: declare a new charge for a new purchase.', 'refused: this charge was already paid');

      // Type them: one provider call per field, the security code last, no picture in between (the tool is one step).
      await ctx.setActivity('acting', { action: { type: 'type', selector: 'card', secret: '', submit: false } });
      const done: string[] = [];
      try {
        for (const w of wanted) {
          if (memory.fields?.[w.field] === 'typed') {
            done.push(w.field);
            continue;
          }
          memory.fields = { ...(memory.fields ?? {}), [w.field]: 'typing' };
          await ctx.persist();
          await ctx.session.typeCardField(ctx.sessionId(), {
            itemId: card.itemId,
            field: w.field,
            ...(w.target.selector ? { selector: w.target.selector } : { point: { x: w.target.x!, y: w.target.y! } }),
            amount: charge.amount,
            currency: charge.currency,
            clear: true,
            ...ctx.loginOpts,
          } as Parameters<FabricSession['typeCardField']>[1]);
          memory.fields = { ...memory.fields, [w.field]: 'typed' };
          await ctx.noteFilled(w.target, 'Card');
          await ctx.persist();
          done.push(w.field);
        }
      } catch (e) {
        // A refusal is definitive: nothing more was typed. A crash, a lost connection or a timeout is not: the field may be filled.
        const code = e instanceof SecretsProviderError ? e.code : e instanceof FabricError ? 'unavailable' : null;
        if (code === null) throw e;
        if (!definitive(e)) {
          // The field that was being typed may be filled: it stays `typing` in the memory and the page keeps its cover.
          const stuck = Object.entries(memory.fields ?? {}).filter(([, v]) => v === 'typing').map(([k]) => k);
          for (const k of stuck) await ctx.noteFilled(wanted.find((w) => w.field === k)!.target, 'Card');
        } else {
          for (const w of wanted) if (memory.fields?.[w.field] === 'typing') delete memory.fields[w.field];
        }
        const f: CardFailure = cardFailureOf(code, e instanceof SecretsProviderError ? e.retryAfterSeconds : undefined);
        if (f.outcome) await ctx.providerOutcome(f.outcome);
        ctx.metric(code === 'amount_exceeded' || code === 'currency_mismatch' ? 'refused_amount' : code === 'origin_mismatch' || code === 'frame_unknown' || code === 'insecure_origin' ? 'refused_shop' : code === 'limit_reached' || code === 'grant_expired' ? 'refused_limit' : 'refused_other');
        await ctx.record('action', 'pay_with_saved_card', args, false, f.summary, started, undefined, { secret: true });
        await ctx.persist();
        if (f.warn) {
          memory.stopped = true;
          memory.approval = null;
          await ctx.persist();
          const spec = questionSpecSchema.parse({ kind: 'login', input: 'takeover', prompt: ctx.warnPrompt(host) });
          const asked = await ctx.askPerson(spec, started);
          return `${f.text}${asked ? ' The owner has been asked to look.' : ''}`;
        }
        return done.length ? `${f.text} (Fields typed before this: ${done.join(', ')}.)` : f.text;
      } finally {
        await ctx.setActivity('thinking');
      }

      // Every field is in. This is the one use of the card: recorded, notified, counted (a retry for a field that was missing is not another use).
      ap.typed = true;
      if (ap.usedIndex !== undefined) {
        await ctx.persist();
        await ctx.record('action', 'pay_with_saved_card', args, true, `typed the remaining card fields (${done.join(', ')})`, started, undefined, { secret: true });
        return 'Typed the card details. The value is not shown to you. Now press the pay button for this charge.';
      }
      const used = appendUsedSavedCard(ctx.usedCards(), {
        provider: lookup.provider,
        itemName: card.name,
        brand: card.brand,
        last4: card.last4,
        merchant: host,
        origin: lookup.origin,
        currency: charge.currency,
        declaredAmount: charge.amount,
        at: new Date(),
      });
      ap.usedIndex = used.length - 1;
      await ctx.setUsedCards(used);
      await ctx.persist();
      await ctx.providerOutcome('ok');
      ctx.metric('typed');
      const words = `${cardWords(card)} at ${host}: ${moneyWords(charge.amount, charge.currency)}`;
      await ctx.record('action', 'pay_with_saved_card', args, true, `typed the saved card ${words}${ap.via === 'rule' ? ' (a remembered approval)' : ''}`, started, undefined, { secret: true });
      if (rule) {
        try {
          await ctx.approvals?.recordUse(rule, { runId: ctx.runId, stepSeq: ctx.stepSeq(), orgId: ctx.orgId });
        } catch (e) {
          ctx.log.warn(`run ${ctx.runId}: could not record a saved approval's use: ${e instanceof Error ? e.message : String(e)}`);
        }
        await ctx.confirmedAction(`by saved approval: Pay with ${cardWords(card)} on ${site}`, 'pay_with_saved_card');
      } else {
        await ctx.confirmedAction(`approved by the owner: pay ${moneyWords(charge.amount, charge.currency)} with ${cardWords(card)} at ${host}`, 'pay_with_saved_card');
      }
      // The owner hears about every use, attended or not.
      void ctx.notifier?.cardUsed(ctx.userId, ctx.run, `Paid with ${words}`).catch((e: unknown) => ctx.log.warn(`run ${ctx.runId}: could not notify a card use: ${e instanceof Error ? e.message : String(e)}`));
      return (
        'Typed the card details. The value is not shown to you. Now press the pay button for this charge (the system lets that one click through for the declared amount). ' +
        'If the page then shows a step from the owner\'s bank or card issuer (a frame or a page asking to verify the payment, a code, an approval in a banking app), do NOT type, click or answer inside it: call request_human with kind "verification", input "none" and the prompt "Your bank wants you to confirm this payment in your banking app", wait, and continue when the page moves on. A code sent by text is a request_human with kind "code" and input "secret". ' +
        'After the payment, read the amount shown on the confirmation page and call confirm_charge.'
      );
    },
  });

  const confirm_charge = defineTool({
    name: 'confirm_charge',
    description:
      'After paying, report the amount the confirmation page says was charged (a decimal such as 42.50) and its currency. The system compares it with the amount you declared and tells the owner if they differ. Read it from the page: do not repeat the declared amount from memory.',
    parameters: z.object({ amount: z.string().min(1).max(20), currency: z.string().min(3).max(3) }),
    execute: async ({ amount, currency }) => {
      const started = Date.now();
      const args = { amount, currency };
      const a = sc().approval;
      const list = ctx.usedCards();
      const entry = a && a.usedIndex !== undefined ? list[a.usedIndex] : undefined;
      if (!a || !entry) return refuse('confirm_charge', args, started, 'No card payment of this run is waiting to be confirmed.', 'refused: no card payment to confirm');
      if (a.pay !== 'done') return refuse('confirm_charge', args, started, 'Press the pay button first, then read the confirmation page.', 'refused: the payment was not made yet');
      const amt = normaliseAmount(amount);
      const cur = normaliseCurrency(currency);
      if (!amt || !cur) return refuse('confirm_charge', args, started, 'Give the amount as a plain decimal and the currency as three letters, as the page shows them.', 'refused: not a valid amount');
      const agree = cur === entry.currency && amountsAgree(entry.declaredAmount, amt);
      const next = list.map((u, i) => (i === a.usedIndex ? { ...u, confirmedAmount: amt, mismatch: !agree } : u));
      await ctx.setUsedCards(next);
      if (!agree) {
        ctx.metric('mismatch');
        const line = `The amount charged at ${entry.merchant} (${moneyWords(amt, cur)}) differs from the one declared (${moneyWords(entry.declaredAmount, entry.currency)})`;
        await ctx.record('action', 'confirm_charge', args, true, line, started);
        void ctx.notifier?.cardAmountMismatch(ctx.userId, ctx.run, line).catch((e: unknown) => ctx.log.warn(`run ${ctx.runId}: could not notify an amount mismatch: ${e instanceof Error ? e.message : String(e)}`));
        return `The amount charged (${moneyWords(amt, cur)}) differs from the amount you declared (${moneyWords(entry.declaredAmount, entry.currency)}). It has been flagged for the owner. Say so plainly in your finish result; do not try to fix it by paying again.`;
      }
      await ctx.record('action', 'confirm_charge', args, true, `confirmed the charge: ${moneyWords(amt, cur)} at ${entry.merchant}`, started);
      return `Confirmed: ${moneyWords(amt, cur)} was charged, as declared.`;
    },
  });

  return [saved_cards, declare_charge, pay_with_saved_card, confirm_charge];
}

/** The provider or the fabric refused for good (nothing was typed), as opposed to an outcome nobody knows (a timeout, a cancel). */
function definitive(e: unknown): boolean {
  return e instanceof SecretsProviderError && !['timed_out', 'cancelled', 'unknown'].includes((e as SecretsProviderError).code);
}
