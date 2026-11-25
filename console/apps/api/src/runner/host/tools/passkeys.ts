// Hexactra passkeys (E47.5, #943): the agent signs in with a passkey the owner added for Hexactra, and, with the owner's approval,
// adds one. The browser host answers the site's WebAuthn request itself (E47.4): the model names only the button to press; it never
// sees a key, a signature, a challenge or which credential was used. Offered only when the run may use saved sign-ins and the owner's
// provider keeps passkeys (the built-in store).
//
// Adding a passkey is the owner's decision, every time: the first call asks a high-risk confirmation the SERVER words, naming the site
// the browser is on; only the runner's fold of that answer (start.ts) records the approval, for that site, once. A confirmation the
// model asks itself (request_human) records nothing here.
import { z } from 'zod';

import { registrableDomain } from '../../../approvals/approval-match';
import { FabricError } from '../../../fabric/fabric.client';
import { questionSpecSchema } from '../../../questions/questions.contract';
import { SecretsProviderError } from '../../../secrets/secrets-provider.port';
import { defineRunnerTool, type RunnerTool } from '@marinoscar/hexactra-agent';
import { currentUrl } from '@marinoscar/hexactra-browser-agent/page';
import type { HostContext } from '../context';
import { loginOpts, refuseSaved } from './secrets-support';

/** What the model reads for each way a passkey action ends without a sign-in (never a key, never which credential). */
export const PASSKEY_FAILURES: Record<string, string> = {
  no_request: 'The page did not ask for a passkey after that button. Check that it is the passkey sign-in button, or sign in another way.',
  no_passkey:
    'The owner has no Hexactra passkey for this site, so the browser shows its own passkey prompt. If it offers "use a phone or tablet" with a QR code, ask the owner with request_human (kind "passkey", input "scan", scan_source "desktop"); otherwise ask for a takeover (kind "passkey", input "takeover").',
  several_passkeys: 'The owner has several Hexactra passkeys for this site. Ask the owner which account to use (request_human, input "choice"), then sign in with that account another way, or ask for a takeover.',
  payment_refused:
    'That passkey request approves a payment: Hexactra never does that. Ask the owner to confirm it themselves (request_human, kind "verification", input "none", or input "scan", scan_source "desktop" when the browser shows a QR code).',
  origin_mismatch: 'The page asked for a passkey of another site. Do not try again; tell the owner.',
  unsupported_algorithm: 'This site does not accept the passkey type Hexactra makes. Tell the owner; they can keep using their own passkey.',
  already_registered: 'This account on the site already has a Hexactra passkey. Sign in with sign_in_with_passkey instead.',
  invalid_request: 'The page made a passkey request Hexactra cannot use. Sign in another way, or ask the owner.',
  unsupported: "The owner's secrets provider does not keep passkeys. Sign in another way, or ask the owner.",
};

/** A passkey failure as the line the model reads; anything that is not a provider or fabric error is rethrown. */
function failureText(e: unknown): { code: string; text: string } {
  if (e instanceof SecretsProviderError) return { code: e.code, text: PASSKEY_FAILURES[e.code] ?? `The passkey step failed (${e.code}). Sign in another way, or ask the owner.` };
  if (e instanceof FabricError) return { code: 'unavailable', text: 'The browser could not do the passkey step right now. Sign in another way, or ask the owner.' };
  throw e;
}

/** The site the browser is on, as the owner reads it (its registrable domain), or null. */
async function siteNow(ctx: HostContext): Promise<string | null> {
  const url = await currentUrl(ctx).catch(() => null);
  return url ? registrableDomain(url) : null;
}

export const ADD_PASSKEY_PROMPT = (domain: string): string =>
  `Add a Hexactra passkey to your account on ${domain}? Runs that may use your saved sign-ins could then sign in to ${domain} as you without asking. You can remove it in Settings, Secrets, and on the site.`;

export const passkeyTools: readonly RunnerTool<HostContext>[] = [
  defineRunnerTool({
    group: 'secrets',
    family: 'secrets',
    name: 'sign_in_with_passkey',
    description:
      "Sign in with the passkey the owner added for Hexactra on this site: press the site's passkey sign-in button (`selector`), and the browser answers the site's passkey request itself. You never see a key. If the owner has none for this site, the result says how to ask the owner instead.",
    parameters: z.object({ selector: z.string().min(1).max(2000) }),
    execute: async (ctx: HostContext, { selector }) => {
      const started = Date.now();
      const args = { selector };
      try {
        const r = await ctx.ext.fabric.session.passkeySignIn(ctx.ext.fabric.sessionId(), { selector, ...loginOpts(ctx) });
        await ctx.record('action', 'sign_in_with_passkey', args, true, `signed in with a Hexactra passkey for ${r.rpId}`, started, undefined, { secret: true });
        return `Signed in with the owner's Hexactra passkey for ${r.rpId}. Check the page.`;
      } catch (e) {
        const f = failureText(e);
        return refuseSaved(ctx, 'sign_in_with_passkey', args, started, f.text, `no passkey sign-in: ${f.code}`);
      }
    },
  }),
  defineRunnerTool({
    group: 'secrets',
    family: 'secrets',
    name: 'add_passkey',
    description:
      "Add a Hexactra passkey to the owner's account on this site, so later runs can sign in with sign_in_with_passkey. Only when the goal asks for it, on the site's own security settings page, signed in. `selector` is the site's \"add a passkey\" or \"create a passkey\" button. The first call asks the owner to approve it for this site and the run waits; after they approve, call it again with the same button.",
    parameters: z.object({ selector: z.string().min(1).max(2000) }),
    execute: async (ctx: HostContext, { selector }) => {
      const started = Date.now();
      const args = { selector };
      const domain = await siteNow(ctx);
      if (!domain) return refuseSaved(ctx, 'add_passkey', args, started, 'The page is not a website Hexactra can add a passkey to. Open the site first.', 'refused: no site');
      const mem = (ctx.memory.passkeys ??= {});
      if (!(mem.approved ?? []).includes(domain)) {
        // The owner decides, on a card the server words, naming the site the browser reports.
        const spec = questionSpecSchema.parse({ kind: 'passkey', input: 'confirm', risk: 'high', prompt: ADD_PASSKEY_PROMPT(domain), confirmLabel: 'Add passkey', denyLabel: 'Not now' });
        mem.asking = { domain };
        if (!(await ctx.askPerson(spec, started))) {
          mem.asking = null;
          return 'Could not reach the owner to approve adding a passkey. Do not add one.';
        }
        return `Waiting for the owner to approve adding a Hexactra passkey for ${domain}.`;
      }
      // One approval, one passkey.
      mem.approved = (mem.approved ?? []).filter((d) => d !== domain);
      try {
        const r = await ctx.ext.fabric.session.passkeyCreate(ctx.ext.fabric.sessionId(), { selector, ...loginOpts(ctx) });
        if (registrableDomain(`https://${r.rpId}/`) !== domain) {
          // Never expected (the fabric checks the RP ID against the page): recorded, and the owner is told.
          await ctx.record('action', 'add_passkey', args, false, `a passkey was made for ${r.rpId}, not ${domain}`, started, undefined, { secret: true });
          return `A passkey was made for ${r.rpId}, not ${domain}. Tell the owner to check their passkeys in Settings, Secrets.`;
        }
        await ctx.record('action', 'add_passkey', args, true, `added a Hexactra passkey for ${r.rpId}`, started, undefined, { secret: true });
        return `Added a Hexactra passkey for ${r.rpId}${r.userName ? ` (account ${r.userName})` : ''}. Check that the site lists it.`;
      } catch (e) {
        const f = failureText(e);
        return refuseSaved(ctx, 'add_passkey', args, started, f.text, `no passkey added: ${f.code}`);
      }
    },
  }),
];
