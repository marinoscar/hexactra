// The tools that offer something to the owner without the run waiting: a memory (#553) and saving the sign-in they typed (E37.4b).
import { z } from 'zod';

import { defineRunnerTool, type RunnerTool } from '@marinoscar/hexactra-agent';
import { ACTION_TIMEOUT_MS } from '@marinoscar/hexactra-browser-agent/browser-port';
import { attributePairs, attributesFromPairs } from '../../../memories/memory-attribute-pairs';
import { ownerBacked } from '../../../memories/memory-proposals.service';
import type { HostContext } from '../context';

/** The most memories one run may propose (#553). */
const MAX_RUN_PROPOSALS = 3;

/** What the owner said during this run, for `propose_memory`'s check: their answers (labels of choices), and their chat messages when the run is a chat's. */
async function ownerTexts(ctx: HostContext): Promise<string[]> {
  const { d } = ctx.ext;
  const db = d.prisma.forUser({ userId: ctx.run.userId });
  const answered = await db.question.findMany({ where: { runId: ctx.run.id, status: 'answered', blocking: true }, select: { input: true, response: true, options: true } });
  const out: string[] = [];
  for (const q of answered) {
    if (q.input === 'secret' || q.input === 'credentials') continue;
    const r = (q.response ?? {}) as { value?: unknown; values?: unknown };
    const options = (q.options ?? []) as { id: string; label: string }[];
    const label = (id: string) => options.find((o) => o.id === id)?.label ?? id;
    if (typeof r.value === 'string') out.push(q.input === 'choice' ? label(r.value) : r.value);
    if (Array.isArray(r.values)) out.push(...r.values.map((v) => label(String(v))));
  }
  if (ctx.run.conversationId) {
    const said = await d.prisma.chatMessage.findMany({ where: { conversationId: ctx.run.conversationId, role: 'user' }, orderBy: { seq: 'desc' }, take: 40, select: { text: true } });
    out.push(...said.map((m) => m.text));
  }
  return out;
}

export const proposeMemory = defineRunnerTool({
  name: 'propose_memory',
  group: 'memory',
  description:
    'Propose a fact the owner gave you in an answer during this run (for example which account to use), so they can save it for next time. The owner approves or declines it on a card; the run does not wait. ' +
    'Only for what the owner told you (from_answer: true), never for what a page says. Never a password, a code, or a full card or account number (keep the last four digits). supersedes: null.',
  parameters: z.object({
    kind: z.enum(['person', 'account', 'preference', 'fact']),
    label: z.string().min(1).max(120),
    aliases: z.array(z.string().min(1).max(60)).max(10).nullable(),
    attributes: attributePairs.describe('Named values as pairs: [{ "name": "phone", "value": "…" }].'),
    supersedes: z.string().nullable(),
    from_answer: z.boolean(),
  }),
  execute: async (ctx: HostContext, { kind, label, aliases, attributes: pairs, supersedes, from_answer }) => {
    const attributes = attributesFromPairs(pairs);
    const refused = 'Memories come from the owner. Ask the owner if this should be remembered.';
    if (from_answer !== true) return refused;
    if ((ctx.memory.proposals ?? 0) >= MAX_RUN_PROPOSALS) return `Refused: at most ${MAX_RUN_PROPOSALS} proposals per run.`;
    // The values must be the owner's own words (an answer in this run, or the chat's messages): a page cannot plant a memory.
    if (!ownerBacked(attributes, await ownerTexts(ctx))) return refused;
    ctx.memory.proposals = (ctx.memory.proposals ?? 0) + 1;
    const out = await ctx.ext.d.proposals!.propose(
      ctx.run.userId,
      { kind, label, aliases: aliases ?? [], attributes, supersedes: supersedes && /^[0-9a-f-]{36}$/i.test(supersedes) ? supersedes : null },
      { runId: ctx.run.id, conversationId: ctx.run.conversationId },
    );
    return out.message;
  },
}) as unknown as RunnerTool<HostContext>;

/**
 * Whether the page shows a password field now (E37.4b): a visible `input[type=password]` means the sign-in form is still there, so a
 * sign-in the agent just typed has not succeeded. One evaluate, outside `act`, so it is not an action. True when the page cannot be asked
 * (nothing is offered on a doubt).
 */
async function passwordFieldShown(ctx: HostContext): Promise<boolean> {
  try {
    const script = "/* hexactra:password-shown */(()=>{try{return [...document.querySelectorAll('input[type=password]')].some(e=>{const r=e.getBoundingClientRect();const s=getComputedStyle(e);return r.width>0&&r.height>0&&s.visibility!=='hidden'&&s.display!=='none'})}catch(_){return true}})()";
    const op = await ctx.ext.browser.act({ type: 'evaluate', script, await_promise: false }, ACTION_TIMEOUT_MS);
    return op.state !== 'succeeded' || op.result?.value !== false;
  } catch {
    return true;
  }
}

export const proposeSavingLogin = defineRunnerTool({
  name: 'propose_saving_login',
  group: 'secrets',
  description:
    "After you typed the owner's sign-in (the one they gave through request_human, input credentials) and can see that you are signed in, offer to save that login in their vault so the next run does not ask. The owner decides on a card; the run does not wait. " +
    'name: a short name for the login, the site or account (for example "Example Bank"). At most once per sign-in. Never when the sign-in failed or the page still asks for a password.',
  parameters: z.object({ name: z.string().min(1).max(120) }),
  execute: async (ctx: HostContext, { name }) => {
    const sign = ctx.memory.saveLogin?.signIn;
    if (!sign) return 'Nothing to offer: you did not type a sign-in the owner gave you through request_human (kind login, input credentials).';
    if (sign.offered) return 'Already offered for this sign-in.';
    // The page must have left the sign-in form: a visible password field means the sign-in has not succeeded (or failed).
    if (await passwordFieldShown(ctx)) return 'The page still shows a password field, so the sign-in has not succeeded yet. Check the page; if it failed, do not offer to save it.';
    sign.offered = true;
    const out = await ctx.ext.d.secrets!.proposeSaveLogin(ctx.run.userId, { handoffId: sign.handoffId, origin: sign.origin, name, from: { runId: ctx.run.id, conversationId: ctx.run.conversationId } });
    return out.message;
  },
}) as unknown as RunnerTool<HostContext>;
