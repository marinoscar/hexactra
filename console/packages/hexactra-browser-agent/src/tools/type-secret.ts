import { z } from 'zod';

import { actionTarget, defineRunnerTool, LEASE_LOST_TEXT, inCommitTool } from '@marinoscar/hexactra-agent';
import type { BrowserContext } from '../context';

export const typeHandoffSecret = defineRunnerTool({
  name: 'type_handoff_secret',
  group: 'human',
  family: 'browser',
  // Typing a secret can submit a payment or a sign-in: it is intent-recorded before the fabric types it (E38.3).
  commits: true,
  description:
    'Type the secret (code or password) the person gave through request_human into an input. You never see the value. ' +
    'For a sensitive task value shown in the goal as [provided: <name>], pass that name as parameter; otherwise null.',
  // Every property is required and the optional one is nullable: OpenAI's strict function calling refuses an optional property (#675).
  parameters: z.object({ selector: z.string().max(2000), submit: z.boolean(), parameter: z.string().max(80).nullable() }),
  execute: async (ctx: BrowserContext, { selector, submit, parameter }) => {
    const started = Date.now();
    const { memory, state } = ctx;
    let handoffId: string;
    if (parameter) {
      // A sensitive task parameter (#552): its own secret, matched by key or label.
      const sens = ctx.ext.sensitiveParams();
      const norm = (v: string) => v.trim().toLowerCase().replace(/[\s_-]+/g, '_');
      const key = sens.find((p) => norm(p.key) === norm(parameter) || norm(p.label) === norm(parameter))?.key;
      const id = key ? memory.paramSecrets?.[key] : undefined;
      if (!key || !id) return `No value is available for "${parameter}".`;
      handoffId = id;
    } else {
      if (!memory.secretHandoffId) return 'No secret is available: call request_human with input "secret" first.';
      handoffId = memory.secretHandoffId;
      memory.secretHandoffId = null;
    }
    if (state.stop === 'lease' || !(await ctx.ports.store.holdsRun())) {
      state.stop = 'lease';
      return LEASE_LOST_TEXT;
    }
    const intent = inCommitTool() ? await ctx.openIntent('type', { selector, secret: '' }, null) : null;
    if (inCommitTool() && intent === null) return LEASE_LOST_TEXT;
    await ctx.setActivity('acting', { action: { type: 'type', selector, secret: '', submit }, target: actionTarget({ selector }, ctx.ext.state.marks.values()) });
    let op;
    try {
      // The browser host types the value itself: the console never sees it.
      op = await ctx.ext.browser.typeSecret({ handoffId, selector, clear: true, submit });
    } catch {
      await ctx.record('action', 'type', { selector, secret: '' }, false, 'the secret was already used or expired', started, undefined, { secret: true }, intent);
      return 'The secret is no longer available; ask the person again if needed.';
    } finally {
      await ctx.setActivity('thinking');
    }
    const ok = op.state === 'succeeded';
    await ctx.record('action', 'type', { selector, submit }, ok, ok ? 'typed the secret' : (op.error ?? op.state), started, undefined, { secret: true }, intent);
    // The owner's own sign-in was typed (E37.4b): the host remembers which one, so it can be offered for saving.
    if (ok && !parameter) await ctx.ext.hooks.secretTyped?.({ handoffId });
    return ok ? 'Typed the secret.' : `Failed: ${op.error ?? op.state}`;
  },
});
