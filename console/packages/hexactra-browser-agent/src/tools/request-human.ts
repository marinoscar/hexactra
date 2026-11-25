import { z } from 'zod';

import { clip, defineRunnerTool } from '@marinoscar/hexactra-agent';
import type { BrowserContext } from '../context';
import { currentUrl } from '../page';
import { requestHumanSpec } from '../request-human-spec';

/** A rememberable question with the scopes this run offers: always everywhere; this task or this chat when it has one. */
function withScopes<T extends object>(ctx: BrowserContext, r: T | null): (T & { scopes: ('everywhere' | 'this_task' | 'this_chat')[] }) | null {
  return r ? { ...r, scopes: ['everywhere', ...(ctx.run.taskId ? (['this_task'] as const) : []), ...(ctx.run.conversationId ? (['this_chat'] as const) : [])] } : null;
}

export const requestHuman = defineRunnerTool({
  name: 'request_human',
  group: 'human',
  family: 'human',
  description:
    'Ask the person for what only they have: a username, a password, a one-time code, a passkey touch, a CAPTCHA, a choice, a number, or a confirmation before an irreversible step (kind "verification": their bank wants them to confirm a payment in a banking app). ' +
    'For a sign-in, ask once for the username and password (kind login, input credentials), then any code (kind code, input secret), and type each yourself; do not ask the person to sign in in the browser. ' +
    'input: none (they do something, then press Done), text, secret (a code or password; type it with type_handoff_secret), credentials (a username, typed with type_text, and a password, typed with type_handoff_secret), choice (one of options), ' +
    'multi_choice (several of options), number (with constraints min/max/step/unit), confirm (approve or deny; risk "high" by default), ' +
    'scan (they scan or read what is on the screen with their phone, then press Done: a sign-in QR code the page shows, a number to match in an app, or Chrome\'s "use a phone or tablet" passkey QR code; kind passkey, login, verification or code; scan_source "page" for a code the page draws, "desktop" for Chrome\'s own passkey window; they see a live picture the server takes, never one you send), ' +
    'takeover (they take over the browser, then press Done: only for a passkey on this computer or a security key, a CAPTCHA you cannot pass, or when they declined to give a credential). ' +
    'Set the fields that do not apply to null. The run pauses until they answer.',
  parameters: z.object({
    kind: z.enum(['captcha', 'code', 'passkey', 'login', 'confirmation', 'verification', 'other']),
    prompt: z.string().min(1).max(1500),
    input: z.enum(['none', 'text', 'secret', 'choice', 'multi_choice', 'number', 'confirm', 'takeover', 'credentials', 'scan']),
    /** Bare option labels (each its own id); or use `options`. */
    choices: z.array(z.string().max(100)).max(10).nullable(),
    options: z.array(z.object({ id: z.string().max(64), label: z.string().max(100), description: z.string().max(200).nullable() })).max(10).nullable(),
    constraints: z
      .object({
        max_length: z.number().int().nullable(),
        pattern: z.string().max(200).nullable(),
        multiline: z.boolean().nullable(),
        min: z.number().nullable(),
        max: z.number().nullable(),
        step: z.number().nullable(),
        unit: z.string().max(20).nullable(),
        min_selections: z.number().int().nullable(),
        max_selections: z.number().int().nullable(),
      })
      .nullable(),
    confirm_label: z.string().max(40).nullable(),
    deny_label: z.string().max(40).nullable(),
    risk: z.enum(['low', 'high']).nullable(),
    /** credentials and secret: the words of the page's "remember me" option, or null. */
    remember_label: z.string().max(200).nullable(),
    /** kind confirmation: what the step is, from the fixed list (#555), so the owner can say "don't ask again". */
    topic: z.string().max(40).nullable(),
    /** scan: where the code is, "page" (drawn by the site) or "desktop" (Chrome's own passkey window). */
    scan_source: z.enum(['page', 'desktop']).nullable(),
  }),
  execute: async (ctx: BrowserContext, args) => {
    const started = Date.now();
    const parsed = ctx.ports.questions.parse(requestHumanSpec(args));
    if (!parsed.ok) return `Invalid request_human: ${parsed.message}. Fix it and call request_human again.`;
    const spec = parsed.spec;
    const { memory, ports } = ctx;
    // A scan that cannot work on this machine (#924): say so before anything is asked, so the agent asks for a takeover instead.
    if (spec.input === 'scan' && ports.questions.scanCheck) {
      const refused = await ports.questions.scanCheck(args.scan_source ?? 'page').catch(() => null);
      if (refused) return refused;
    }
    const approvals = ports.approvals;
    // The commitment the gate stopped travels with the confirmation (#550), from the server's own record:
    // a `gate` (or a host) in the model's arguments is not in the schema and never reaches here.
    if (spec.kind === 'confirmation' && memory.gatePending?.category) {
      const gate = { host: memory.gatePending.host, category: memory.gatePending.category, label: memory.gatePending.label };
      spec.gate = gate;
      memory.gatePending = null;
      // What "Don't ask again" would remember (#555): the gate's own facts, never the model's.
      if (spec.input === 'confirm' || spec.input === 'none') spec.rememberable = withScopes(ctx, (approvals?.rememberableGate(gate) as object | null) ?? null);
    } else if (approvals && spec.kind === 'confirmation' && (spec.input === 'confirm' || spec.input === 'none')) {
      // An ask the agent makes on its own (#555): keyed on a fixed topic and the page the browser reports.
      const topic = approvals.topicOf(args.topic);
      const url = topic !== 'other' && approvals.enabled ? await currentUrl(ctx) : null;
      if (url) {
        const rule = await approvals.matchAsk(topic, url).catch(() => null);
        if (rule) {
          // The owner's standing approval: no question. A trace step, not an action (no budget, no stall).
          ctx.state.seq += 1;
          await ports.store.appendStep({ seq: ctx.state.seq, kind: 'handoff', action: 'pre_approved', args: { topic, approval: { ruleId: rule.id } }, ok: true, summary: clip(`went ahead on a saved approval: ${rule.summary}`, 1_900), durationMs: 0 });
          await approvals.recordUse(rule, { stepSeq: ctx.state.seq }).catch(() => undefined);
          memory.log.push(`(Not asked: the owner has a standing approval on this site for: ${topic}.)`);
          return 'The owner has a standing approval for this on this site. Go ahead.';
        }
        spec.rememberable = withScopes(ctx, (approvals.rememberableAsk(topic, url) as object | null) ?? null);
      }
    }
    if (!(await ctx.askPerson(spec, started))) return 'Could not reach a person right now.';
    return 'Waiting for the person.';
  },
});
