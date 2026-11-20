// The saved-card tools (E37.7, #596): saved_cards, declare_charge, pay_with_saved_card, confirm_charge. The rules are in saved-card-helpers.ts.
import { defineRunnerTool, type RunnerTool } from '@marinoscar/hexactra-agent';
import type { HostContext } from '../context';
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
import { cardHelpers, definitive, FAIL_TARGET, targetOf, targetSchema, type SavedCardToolsContext } from './saved-card-helpers';
import { payWithSavedCard } from './saved-card-pay';

export function buildSavedCardTools(ctx: SavedCardToolsContext): RunnerTool<HostContext>[] {
  const h = cardHelpers(ctx);
  const { sc, refuse, usableLookup, askOwner, rememberedApproval } = h;

  const saved_cards = defineRunnerTool({
    group: 'secrets',
    family: 'secrets',
    name: 'saved_cards',
    description:
      'List the payment cards the owner allowed at the shop now on screen: none, or `{ ref, name, brand, last4, limit, expires, securityCode }` per card. You never see a card number, an expiry or a code, and you never type one yourself. Call it on the shop\'s checkout page before paying.',
    parameters: z.object({}),
    execute: async (_hc: HostContext) => {
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


  const declare_charge = defineRunnerTool({
    group: 'secrets',
    family: 'secrets',
    name: 'declare_charge',
    description:
      "Say what you are about to pay, BEFORE typing a card: the exact total you read on the page (a decimal such as 42.50), its currency (ISO 4217, such as USD) and what is being bought. The system records it, shows it to the owner in the approval and checks it against the owner's limit. The shop is the page now on screen. Nothing is typed without it.",
    parameters: z.object({ amount: z.string().min(1).max(20), currency: z.string().min(3).max(3), description: z.string().min(1).max(200) }),
    execute: async (_hc: HostContext, { amount, currency, description }) => {
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
  const confirm_charge = defineRunnerTool({
    group: 'secrets',
    family: 'secrets',
    name: 'confirm_charge',
    description:
      'After paying, report the amount the confirmation page says was charged (a decimal such as 42.50) and its currency. The system compares it with the amount you declared and tells the owner if they differ. Read it from the page: do not repeat the declared amount from memory.',
    parameters: z.object({ amount: z.string().min(1).max(20), currency: z.string().min(3).max(3) }),
    execute: async (_hc: HostContext, { amount, currency }) => {
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

  return [saved_cards, declare_charge, payWithSavedCard(ctx, h), confirm_charge] as unknown as RunnerTool<HostContext>[];
}
