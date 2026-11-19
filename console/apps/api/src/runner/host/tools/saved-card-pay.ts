// pay_with_saved_card (E37.7, #596): the card typed into the checkout form in a fixed order, the security code last. The rules are in saved-card-helpers.ts.
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
import { definitive, FAIL_TARGET, targetOf, targetSchema, type CardHelpers, type SavedCardToolsContext } from './saved-card-helpers';

export function payWithSavedCard(ctx: SavedCardToolsContext, { sc, refuse, usableLookup, askOwner, rememberedApproval }: CardHelpers) {
  return defineRunnerTool({
    group: 'secrets',
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
    execute: async (_hc: HostContext, { ref, fields }) => {
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
}
