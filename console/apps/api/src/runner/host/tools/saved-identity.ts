// The saved-identity tools (E37.6, #595). The model names a field of a saved item (`fill_from_identity`); the browser host types it, or
// chooses the select's option, from the owner's provider and answers only "filled". The run knows WHICH inputs were filled (a selector,
// never a value) and keeps them out of everything the model can read back (host/read-masking.ts).
import { z } from 'zod';

import { FabricError } from '../../../fabric/fabric.client';
import { questionSpecSchema } from '../../../questions/questions.contract';
import { SecretsProviderError } from '../../../secrets/secrets-provider.port';
import { actionTarget, defineRunnerTool, type RunnerTool } from '../../harness';
import { describeTarget, currentUrl } from '../../browser/page';
import { hostOf } from '../../browser/policy';
import {
  appendUsedSavedIdentity,
  askedKey,
  findField,
  identityLookupOf,
  identityLookupText,
  safeLabel,
  type LookedUpField,
  type LookedUpIdentity,
  type SavedIdentityLookup,
} from '../../saved-identity';
import type { HostContext } from '../context';
import { definitiveRefusal, loginOpts, noteFilledInput, originOf, persistSavedSecrets, si } from './secrets-support';

/** The first fill of a detail in this run: `runs.used_saved_identity` (labels only). */
async function markIdentityUsed(ctx: HostContext, item: LookedUpIdentity, field: LookedUpField, lookup: SavedIdentityLookup): Promise<void> {
  const next = appendUsedSavedIdentity(ctx.ext.used.identity, { provider: lookup.provider, itemName: item.name, label: field.label, origin: lookup.origin, at: new Date() });
  if (next.length === ctx.ext.used.identity.length) return;
  ctx.ext.used.identity = next;
  await ctx.ext.db.run.updateMany({ where: { id: ctx.run.id }, data: { usedSavedIdentity: next as never } });
}
/** The refusal a provider or the fabric gave a fill, as the words the model reads. Never the provider's message. */
function identityFailure(e: unknown): { text: string; summary: string; outcome: string | null } {
  if (!(e instanceof SecretsProviderError) && !(e instanceof FabricError)) throw e;
  const code = e instanceof SecretsProviderError ? e.code : 'unavailable';
  const ASK = 'If the form needs personal details, ask the owner for them in one request (request_human, input "text") listing every detail you need.';
  switch (code) {
    case 'cross_origin_frame':
      return { text: 'Stop. This field is in an embedded frame from another site, so nothing may be typed into it from the saved details. Tell the owner.', summary: 'the field is in a frame of another site: nothing was typed', outcome: null };
    case 'insecure_origin':
      return { text: 'This page does not use https, so this detail is not typed here. Tell the owner; do not ask for it to be typed into this page.', summary: 'refused: the page does not use https', outcome: null };
    case 'no_option':
      return { text: 'None of the options of that select is the saved detail (or the element is not a select). Look at the options with observe_elements and tell the owner what is missing.', summary: 'no option matched the saved detail', outcome: null };
    case 'typing_failed':
      return { text: 'Could not fill that field. Check the selector with observe_elements and call the tool again for that field only.', summary: 'could not fill the field', outcome: null };
    case 'origin_unavailable':
      return { text: 'The page address could not be read, so nothing was filled. Wait for the page to load and try again once.', summary: 'the page address could not be read', outcome: null };
    case 'unauthorized':
      return { text: `Saved details are not available right now. ${ASK}`, summary: 'the provider refused the connection', outcome: 'UNAUTHORIZED' };
    case 'rate_limited':
      return { text: `Saved details are not available right now. ${ASK}`, summary: 'the provider asked to wait', outcome: 'RATE_LIMITED' };
    case 'cancelled':
      return { text: 'The step was cancelled.', summary: 'cancelled', outcome: null };
    default:
      return { text: `Saved details are not available right now. ${ASK}`, summary: 'saved details could not be used', outcome: code === 'unavailable' ? 'UNAVAILABLE' : null };
  }
}
/**
 * A sensitive detail this site is not on the allowed list for: the model is told, and the owner is asked once through a
 * card with two choices. Hexactra cannot widen a provider's allowed list itself, so "allow" points the owner to the provider.
 */
async function detailNotAllowed(ctx: HostContext, action: string, args: Record<string, unknown>, item: LookedUpIdentity, field: LookedUpField, lookup: SavedIdentityLookup, selector: string, started: number): Promise<string> {
  const key = askedKey(item.itemId, field.key, lookup.origin);
  const asked = (si(ctx).askedKeys ?? []).filter((k) => k === key).length;
  await ctx.record('action', action, args, false, `refused: ${field.label} is saved but not allowed on this site`, started, undefined, { secret: true });
  if (asked >= 2) return 'This detail is saved but not allowed on this site, and the owner was already asked. Do not ask again: carry on without it, or finish and say what is missing.';
  si(ctx).askedKeys = [...(si(ctx).askedKeys ?? []), key];
  si(ctx).asked = { ref: item.ref, itemId: item.itemId, key: field.key, label: field.label, origin: lookup.origin, itemName: item.name, selector };
  const site = hostOf(lookup.origin) ?? lookup.origin;
  const where = (await ctx.ext.d.secrets?.providerAddress(ctx.run.userId)) ?? 'your secrets provider';
  const spec = questionSpecSchema.parse({
    kind: 'other',
    input: 'choice',
    prompt: `The agent needs your ${field.label} (saved in '${item.name}') for a form on ${site}, but that detail is only allowed on the sites you listed for it. To allow this site, add ${site} to '${item.name}' in ${where}, then choose "Allow this site". Or choose "Type it this time" and enter it yourself: the agent types it and never sees it.`,
    options: [
      { id: 'allow_site', label: `Allow this site for ${field.label}`.slice(0, 100) },
      { id: 'type_now', label: 'Type it this time' },
    ],
  });
  if (await ctx.askPerson(spec, started)) return 'This detail is saved but not allowed on this site. The owner has been asked: allow the site, or type it this time.';
  return 'This detail is saved but not allowed on this site. Tell the owner.';
}

export const savedIdentityTools = [
  defineRunnerTool({
    group: 'secrets',
    name: 'saved_identity',
    description:
      'List the personal details the owner saved that a form on the page now on screen may ask for (a name, a date of birth, an ID number, an address, a phone number): none, or `{ ref, name, fields: [{ key, label, sensitive, usableHere }] }` per saved item. Labels only: you never see a value, not even its length. Call it on a form that asks for personal details.',
    parameters: z.object({}),
    execute: async (ctx: HostContext) => {
      const started = Date.now();
      const spent = ctx.budgetStop();
      if (spent) return spent;
      let found;
      try {
        found = await ctx.ext.fabric.session.secretsLookup(ctx.ext.fabric.sessionId(), 'identity', loginOpts(ctx));
      } catch (e) {
        const f = identityFailure(e);
        if (f.outcome) await ctx.ext.d.secrets?.outcome(ctx.run.userId, { ok: false, code: f.outcome });
        await ctx.record('action', 'saved_identity', {}, false, f.summary, started, undefined, { secret: true });
        return f.text;
      }
      await ctx.ext.d.secrets?.outcome(ctx.run.userId, { ok: true });
      const lookup = identityLookupOf(si(ctx), found);
      si(ctx).lookup = lookup;
      const fields = lookup.items.reduce((n, i) => n + i.fields.length, 0);
      await ctx.record('action', 'saved_identity', {}, true, `looked up saved details: ${lookup.items.length === 0 ? 'none' : `${lookup.items.length} item${lookup.items.length === 1 ? '' : 's'}, ${fields} field${fields === 1 ? '' : 's'}`}`, started);
      await persistSavedSecrets(ctx);
      return identityLookupText(lookup);
    },
  }),
  defineRunnerTool({
    group: 'secrets',
    name: 'fill_from_identity',
    description:
      "Fill one field of a saved detail into the input or select you name, on the page now on screen: the system types it (or chooses the matching option) with real input. You never see the value. `ref` and `field` (the key) come from saved_identity. For a date of birth in three selects, pass `part` (day, month or year) for each; otherwise null. Not for passwords or codes. Filling a field commits nothing: submitting the form does.",
    parameters: z.object({ ref: z.string().min(1).max(40), field: z.string().min(1).max(60), selector: z.string().min(1).max(2000), part: z.enum(['day', 'month', 'year']).nullable() }),
    execute: async (ctx: HostContext, { ref, field, selector, part }) => {
      const started = Date.now();
      const args = { ref, field, selector, part };
      const spent = ctx.budgetStop();
      if (spent) return spent;
      const refuse = async (text: string, summary: string) => {
        await ctx.record('action', 'fill_from_identity', args, false, summary, started, undefined, { secret: true });
        return text;
      };
      const lookup = si(ctx).lookup;
      if (!lookup) return refuse('Call saved_identity first, on the page you are filling.', 'refused: no lookup of this page yet');
      const item = lookup.items.find((i) => i.ref === ref);
      if (!item) return refuse(`There is no saved item "${ref}". Call saved_identity again for this page and use a reference it gives.`, 'refused: unknown reference');
      const f = findField(item, field);
      if (!f) return refuse(`That item has no field "${field}". Its fields: ${item.fields.map((x) => x.key).join(', ')}.`, 'refused: the item has no such field');
      const now = originOf(await currentUrl(ctx));
      if (now && now !== lookup.origin) return refuse('The page changed since saved_identity looked it up. Call saved_identity again for the page you are on.', 'refused: the page changed since the lookup');
      if (!f.usableHere && !(si(ctx).tryAnyway ?? []).includes(askedKey(item.itemId, f.key, lookup.origin))) return detailNotAllowed(ctx, 'fill_from_identity', args, item, f, lookup, selector, started);
      // A select takes the option that matches; an input takes the keystrokes. The page says which it is.
      const facts = await describeTarget(ctx, { selector });
      const isSelect = facts?.tag === 'select';
      if (part && !isSelect) return refuse('`part` is only for a select. Pass null for an input.', 'refused: part given for an input');
      const label = safeLabel(f.label);
      await ctx.setActivity('acting', { action: { type: 'type', selector, secret: '', submit: false }, target: actionTarget({ selector }, ctx.ext.state.marks.values()) });
      try {
        if (isSelect) await ctx.ext.fabric.session.selectFromProvider(ctx.ext.fabric.sessionId(), { itemId: item.itemId, field: f.key, selector, ...(part ? { part } : {}), ...loginOpts(ctx) });
        else await ctx.ext.fabric.session.typeFromProvider(ctx.ext.fabric.sessionId(), { itemId: item.itemId, field: f.key, selector, purpose: 'form', clear: true, submit: false, ...loginOpts(ctx) });
      } catch (e) {
        // A refusal is definitive: nothing was typed. A crash, a lost connection or a timeout is not: the field may be filled.
        if (!definitiveRefusal(e)) await noteFilledInput(ctx, selector, label);
        // The provider said this site is not on the item's list although the lookup said usable (it changed since): the same card.
        if (e instanceof SecretsProviderError && e.code === 'origin_mismatch') return detailNotAllowed(ctx, 'fill_from_identity', args, item, f, lookup, selector, started);
        const failure = identityFailure(e);
        if (failure.outcome) await ctx.ext.d.secrets?.outcome(ctx.run.userId, { ok: false, code: failure.outcome });
        await ctx.record('action', 'fill_from_identity', args, false, failure.summary, started, undefined, { secret: true });
        return failure.text;
      } finally {
        await ctx.setActivity('thinking');
      }
      await noteFilledInput(ctx, selector, label);
      await markIdentityUsed(ctx, item, f, lookup);
      await persistSavedSecrets(ctx);
      await ctx.ext.d.secrets?.outcome(ctx.run.userId, { ok: true });
      await ctx.record('action', 'fill_from_identity', args, true, `filled ${label} from the saved details '${item.name}'`, started, undefined, { secret: true });
      return `Filled ${label}. Check the page; the value is not shown to you.`;
    },
  }),
] as unknown as RunnerTool<HostContext>[];
