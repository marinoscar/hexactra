// The saved-login tools (E37.3, #592). The model passes a per-run reference from the lookup of the page it is on; the browser host reads the
// page's origin itself when it types and asks the owner's provider with it. A value never reaches this process, a step, the memory or the
// model: only names, masked usernames and origins do. Offered only when the run may use saved logins.
import { z } from 'zod';

import { FabricError } from '../../../fabric/fabric.client';
import { questionSpecSchema } from '../../../questions/questions.contract';
import { SecretsProviderError } from '../../../secrets/secrets-provider.port';
import { actionTarget, defineRunnerTool, type RunnerTool } from '../../harness';
import { hostOf } from '../../browser/policy';
import { currentUrl } from '../../browser/page';
import {
  appendUsedSavedLogin,
  failureOf,
  loginKey,
  loginLabel,
  lookupOf,
  lookupText,
  MAX_CODE_TRIES,
  maskUsername,
  MISMATCH_LOG,
  mismatchPrompt,
  notPasswordPrompt,
  PASSWORD_ALREADY_TYPED,
  type LookedUpLogin,
  type SavedLoginFailure,
  type SavedLoginLookup,
} from '../../saved-logins';
import type { HostContext } from '../context';
import { definitiveRefusal, loginOpts, noteFilledInput, originOf, persistSavedSecrets, refuseSaved, sl } from './secrets-support';

/** A saved login's first use in this run: `runs.used_saved_logins`, and (unattended) the confirmation before a commitment turns on. */
async function markUsed(ctx: HostContext, login: LookedUpLogin, lookup: SavedLoginLookup): Promise<void> {
  const next = appendUsedSavedLogin(ctx.ext.used.logins, { provider: lookup.provider, itemName: login.name, origin: lookup.origin, at: new Date() });
  if (next.length === ctx.ext.used.logins.length) return;
  const first = ctx.ext.used.logins.length === 0;
  ctx.ext.used.logins = next;
  await ctx.ext.db.run.updateMany({ where: { id: ctx.run.id }, data: { usedSavedLogins: next as never } });
  if (first && ctx.ext.unattended && (ctx.ext.run.task?.unattendedPayments ?? 'ask') !== 'allow') {
    ctx.memory.log.push('(This run signed in with a saved login and nobody is watching: the server asks the owner before a payment or another commitment.)');
  }
}
/**
 * A provider failure as an instruction (the table of `failureOf`). A mismatch ends the attempt and asks the owner with a
 * warning card; saved logins are off for the rest of the run. Anything that is not a provider or fabric error is rethrown.
 */
async function savedLoginFailure(ctx: HostContext, action: string, args: Record<string, unknown>, e: unknown, started: number, about?: { name: string; origin: string }): Promise<string> {
  let f: SavedLoginFailure;
  if (e instanceof SecretsProviderError) f = failureOf(e.code, e.retryAfterSeconds);
  else if (e instanceof FabricError) f = failureOf('unavailable');
  else throw e;
  if (f.outcome) await ctx.ext.d.secrets?.outcome(ctx.run.userId, { ok: false, code: f.outcome });
  await ctx.record('action', action, args, false, f.summary, started, undefined, { secret: true });
  if (f.askOwner) {
    // The password went nowhere: the owner is asked to sign in, and the login stays usable for a field that is one.
    const spec = questionSpecSchema.parse({ kind: 'login', input: 'takeover', prompt: notPasswordPrompt(hostOf(await currentUrl(ctx)), about?.name ?? 'saved login') });
    return (await ctx.askPerson(spec, started)) ? f.text : f.text.replace(' The owner has been asked to sign in.', ' Ask the owner: call request_human with kind "login", input "credentials".');
  }
  if (!f.warn) return f.text;
  sl(ctx).stopped = true;
  sl(ctx).attempt = null;
  ctx.memory.log.push(MISMATCH_LOG);
  await persistSavedSecrets(ctx);
  // `about.origin` is the site the login is saved for (the page it matched); the tab may be somewhere else now.
  const pageNow = await currentUrl(ctx);
  const spec = questionSpecSchema.parse({ kind: 'login', input: 'takeover', prompt: mismatchPrompt(hostOf(pageNow), about?.name ?? 'saved login', hostOf(about?.origin ?? null)) });
  return (await ctx.askPerson(spec, started)) ? `${f.text} The owner has been asked to look.` : f.text;
}
/** The page's lookup and a reference the owner may use now: exact, chosen when several match, on the page still on screen. */
async function usableLogin(ctx: HostContext, action: string, args: Record<string, unknown>, ref: string, started: number): Promise<{ login: LookedUpLogin; lookup: SavedLoginLookup } | string> {
  const spent = ctx.budgetStop();
      if (spent) return spent;
  const refuse = (text: string, summary: string) => refuseSaved(ctx, action, args, started, text, summary);
  if (sl(ctx).stopped) return refuse('Saved logins are switched off for the rest of this run, because a page was refused as the wrong site. Do not try another login. Tell the owner.', 'refused: saved logins are off for this run');
  const lookup = sl(ctx).lookup;
  if (!lookup) return refuse('Call saved_logins first, on the page you are signing in to.', 'refused: no lookup of this page yet');
  const login = lookup.logins.find((l) => l.ref === ref);
  if (!login) return refuse(`There is no saved login "${ref}". Call saved_logins again for this page and use a reference it gives.`, 'refused: unknown reference');
  const now = originOf(await currentUrl(ctx));
  if (now && now !== lookup.origin) return refuse('The page changed since saved_logins looked it up. Call saved_logins again for the page you are on.', 'refused: the page changed since the lookup');
  if (!login.exact) return refuse('That login is saved for a different address of this site. Ask the owner: call request_human with kind "login", input "credentials".', 'refused: saved for a different address of the site');
  if (lookup.ambiguous && lookup.chosen !== login.ref) {
    return refuse('Several logins are saved for this address, and the owner has not chosen one. Ask the owner with request_human (kind "login", input "choice"; the options are the references from saved_logins).', 'refused: the owner has not chosen between several logins');
  }
  return { login, lookup };
}

export const savedLoginTools = [
  defineRunnerTool({
    group: 'secrets',
    name: 'saved_logins',
    description:
      'List the logins the owner saved for the page now on screen: none, or `{ ref, name, username, exact, hasCode }` each. Only a login marked exact may be used. Call it first on a sign-in page. A username is not secret; passwords and codes are never shown.',
    parameters: z.object({}),
    execute: async (ctx: HostContext) => {
      const started = Date.now();
      const spent = ctx.budgetStop();
      if (spent) return spent;
      if (sl(ctx).stopped) return refuseSaved(ctx, 'saved_logins', {}, started, 'Saved logins are switched off for the rest of this run, because a page was refused as the wrong site. Do not try another login. Tell the owner.', 'refused: saved logins are off for this run');
      let found;
      try {
        found = await ctx.ext.fabric.session.secretsLookup(ctx.ext.fabric.sessionId(), 'login', loginOpts(ctx));
      } catch (e) {
        return await savedLoginFailure(ctx, 'saved_logins', {}, e, started);
      }
      await ctx.ext.d.secrets?.outcome(ctx.run.userId, { ok: true });
      const previous = sl(ctx).lookup;
      const lookup = lookupOf(sl(ctx), found);
      // The owner's choice between several logins stands for this page for the rest of the run.
      if (previous?.chosen && previous.origin === lookup.origin && lookup.logins.some((l) => l.exact && l.ref === previous.chosen)) lookup.chosen = previous.chosen;
      // The model reads the lookup now; the run keeps it with the usernames masked (a username is not secret, but nothing needs it again).
      const text = lookupText(lookup);
      sl(ctx).lookup = { ...lookup, logins: lookup.logins.map((l) => ({ ...l, username: l.username === null ? null : maskUsername(l.username) })) };
      // A new page, a new attempt; but a sign-in cut off on this very page (a crash, a retried job) keeps what it typed.
      if (!(previous && previous.origin === lookup.origin && sl(ctx).attempt && sl(ctx).attempt!.password !== 'typed')) sl(ctx).attempt = null;
      const exact = lookup.logins.filter((l) => l.exact).length;
      const n = lookup.logins.length;
      await ctx.record('action', 'saved_logins', {}, true, `looked up saved logins: ${n === 0 ? 'no match' : `${n} match${n === 1 ? '' : 'es'}${exact === n ? '' : `, ${exact} exact`}`}`, started);
      await persistSavedSecrets(ctx);
      return text;
    },
  }),
  defineRunnerTool({
    group: 'secrets',
    name: 'sign_in_with_saved_login',
    description:
      "Sign in with a login the owner saved, on the page now on screen: types its username and password into the fields you name with real keystrokes. You never see either. `ref` comes from saved_logins and must be marked exact. When the site asks for the username and the password on separate pages, pass one selector per call and null for the other. `submit` presses Enter after the last field typed. `password_selector` must name the password field itself (an input of type password): a saved password is not typed into any other field. A password is typed at most once per run: if the site rejects it, ask the owner.",
    parameters: z.object({ ref: z.string().min(1).max(40), username_selector: z.string().max(2000).nullable(), password_selector: z.string().max(2000).nullable(), submit: z.boolean() }),
    execute: async (ctx: HostContext, { ref, username_selector, password_selector, submit }) => {
      const started = Date.now();
      const args = { ref, username_selector, password_selector, submit };
      if (!username_selector && !password_selector) return 'Give a username_selector, a password_selector or both.';
      const pre = await usableLogin(ctx, 'sign_in_with_saved_login', args, ref, started);
      if (typeof pre === 'string') return pre;
      const { login, lookup } = pre;
      const mem = sl(ctx);
      const key = loginKey(login.itemId, lookup.origin);
      const attempt = mem.attempt && mem.attempt.itemId === login.itemId ? mem.attempt : (mem.attempt = { ref: login.ref, itemId: login.itemId });
      // A password is typed once per login and site in a run, whatever happened: repeated wrong passwords lock accounts.
      if (password_selector && attempt.password === 'typing') {
        return refuseSaved(ctx, 'sign_in_with_saved_login', args, started, "A previous attempt was cut off while typing this login's password, so it may already be typed. Look at the page: if you are signed in, carry on. If not, do not type it again: ask the owner to sign in with request_human, kind \"login\", input \"credentials\".", 'refused: the password may already have been typed');
      }
      if (password_selector && mem.passwordTyped?.includes(key)) return refuseSaved(ctx, 'sign_in_with_saved_login', args, started, PASSWORD_ALREADY_TYPED, 'refused: the password was already typed in this run');
      const todo = (
        [
          ['username', username_selector],
          ['password', password_selector],
        ] as const
      ).filter(([field, selector]) => selector && !(field === 'username' && attempt.username === 'typed'));
      if (todo.length === 0) return 'The username was already typed on this page. Pass the password_selector to type the password.';
      const label = loginLabel(login.name, login.username);
      const done: string[] = [];
      for (const [i, [field, selector]] of todo.entries()) {
        // The phase is written before the keystrokes and the field is `typed` only after the fabric says so.
        attempt[field] = 'typing';
        await persistSavedSecrets(ctx);
        await ctx.note('note', 'saved_login_phase', `typing the ${field} of the saved login ${label}`);
        await ctx.setActivity('acting', { action: { type: 'type', selector, secret: '', submit }, target: actionTarget({ selector: selector! }, ctx.ext.state.marks.values()) });
        try {
          await ctx.ext.fabric.session.typeFromProvider(ctx.ext.fabric.sessionId(), { itemId: login.itemId, field, selector: selector!, purpose: 'login', clear: true, submit: submit && i === todo.length - 1, ...loginOpts(ctx) });
        } catch (e) {
          // A refusal is definitive: nothing was typed. A crash, a lost connection or a timeout is not: the field may be typed.
          if (definitiveRefusal(e)) attempt[field] = undefined;
          await persistSavedSecrets(ctx);
          return await savedLoginFailure(ctx, 'sign_in_with_saved_login', args, e, started, { name: login.name, origin: lookup.origin });
        } finally {
          await ctx.setActivity('thinking');
        }
        attempt[field] = 'typed';
        await noteFilledInput(ctx, selector!, field === 'password' ? 'Password' : 'Username');
        if (field === 'password') mem.passwordTyped = [...(mem.passwordTyped ?? []), key];
        await markUsed(ctx, login, lookup);
        await persistSavedSecrets(ctx);
        done.push(field);
      }
      await ctx.ext.d.secrets?.outcome(ctx.run.userId, { ok: true });
      const typedPassword = done.includes('password');
      await ctx.record('action', 'sign_in_with_saved_login', args, true, typedPassword ? `signed in with the saved login ${label}` : `typed the username of the saved login ${label}`, started, undefined, { secret: true });
      return typedPassword
        ? `Typed ${done.join(' and ')} of the saved login ${ref}${submit ? ' and submitted' : ''}. Check the page.`
        : `Typed the username of the saved login ${ref}${submit ? ' and submitted' : ''}. When the site shows the password field, call this again with password_selector (and null for username_selector).`;
    },
  }),
  defineRunnerTool({
    group: 'secrets',
    name: 'type_saved_code',
    description:
      'Type the one-time authenticator code of a saved login into the field you name, fresh at that moment; you never see it. Only for a login marked hasCode, and only when the page asks for an authenticator-app code (never a code sent by text message or email). `ref` comes from saved_logins and must be exact. `submit` presses Enter after typing.',
    parameters: z.object({ ref: z.string().min(1).max(40), selector: z.string().min(1).max(2000), submit: z.boolean() }),
    execute: async (ctx: HostContext, { ref, selector, submit }) => {
      const started = Date.now();
      const args = { ref, selector, submit };
      const pre = await usableLogin(ctx, 'type_saved_code', args, ref, started);
      if (typeof pre === 'string') return pre;
      const { login, lookup } = pre;
      if (!login.hasCode) {
        return refuseSaved(ctx, 'type_saved_code', args, started, 'That login has no authenticator code saved. Ask the owner for the code: call request_human with kind "code", input "secret", and type it with type_handoff_secret.', 'refused: the login has no code');
      }
      const mem = sl(ctx);
      const key = loginKey(login.itemId, lookup.origin);
      if ((mem.codes?.[key] ?? 0) >= MAX_CODE_TRIES) {
        return refuseSaved(ctx, 'type_saved_code', args, started, `A code from this login was already typed ${MAX_CODE_TRIES} times in this run. Do not try again: ask the owner.`, 'refused: too many codes typed in this run');
      }
      mem.codes = { ...(mem.codes ?? {}), [key]: (mem.codes?.[key] ?? 0) + 1 };
      const attempt = mem.attempt && mem.attempt.itemId === login.itemId ? mem.attempt : (mem.attempt = { ref: login.ref, itemId: login.itemId });
      attempt.code = 'typing';
      await persistSavedSecrets(ctx);
      await ctx.note('note', 'saved_login_phase', `typing the authenticator code of the saved login ${loginLabel(login.name, login.username)}`);
      await ctx.setActivity('acting', { action: { type: 'type', selector, secret: '', submit }, target: actionTarget({ selector }, ctx.ext.state.marks.values()) });
      try {
        await ctx.ext.fabric.session.typeCodeFromProvider(ctx.ext.fabric.sessionId(), { itemId: login.itemId, selector, clear: true, submit, ...loginOpts(ctx) });
      } catch (e) {
        if (definitiveRefusal(e)) attempt.code = undefined;
        await persistSavedSecrets(ctx);
        return await savedLoginFailure(ctx, 'type_saved_code', args, e, started, { name: login.name, origin: lookup.origin });
      } finally {
        await ctx.setActivity('thinking');
      }
      attempt.code = 'typed';
      await noteFilledInput(ctx, selector, 'Code');
      await markUsed(ctx, login, lookup);
      await persistSavedSecrets(ctx);
      await ctx.ext.d.secrets?.outcome(ctx.run.userId, { ok: true });
      await ctx.record('action', 'type_saved_code', args, true, `typed the authenticator code of the saved login ${loginLabel(login.name, login.username)}`, started, undefined, { secret: true });
      return `Typed the code${submit ? ' and submitted' : ''}. Check the page.`;
    },
  }),
] as unknown as RunnerTool<HostContext>[];
