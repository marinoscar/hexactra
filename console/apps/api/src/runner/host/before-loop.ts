// What a run asks for before the model works: a detail the owner chose to type themselves (E37.6) and the sensitive values the task needs (#552).
// The fabric keeps the value and types it (`type_handoff_secret`); the model never sees it.
import { readRunInputs } from '../../tasks/task-params.schemas';
import { hostOf } from '../browser/policy';
import { closeRun, pauseForPerson, type RunOutcome } from '../harness';
import type { HostContext } from './context';

export async function beforeLoop(ctx: HostContext): Promise<RunOutcome | null> {
  const { memory, run } = ctx;
  const ask = async (raw: Record<string, unknown>): Promise<boolean> => {
    const parsed = ctx.ports.questions.parse(raw);
    if (!parsed.ok) throw new Error(parsed.message);
    return ctx.askPerson(parsed.spec, Date.now());
  };

  // The owner chose "Type it this time" for a saved detail this site may not have (E37.6): ask for it as a secret now.
  const typeNow = memory.savedIdentity?.typeNow;
  if (typeNow) {
    memory.savedIdentity!.typeNow = null;
    memory.log.push(`The owner is asked to enter ${typeNow.label}. When they have, type it into ${typeNow.selector} with type_handoff_secret (no parameter) and carry on with the form.`);
    if (await ask({ kind: 'other', input: 'secret', prompt: `Enter your ${typeNow.label} for the form on ${hostOf(typeNow.origin) ?? typeNow.origin}. The agent types it into the page; it is never shown to the agent or stored.` })) {
      await ctx.checkpoint();
      return pauseForPerson(ctx);
    }
  }

  // A parameter defaulted from a saved identity field (E37.6) is filled by the fabric when the run may use saved details; without that it is
  // asked for like a sensitive value. Either way the model reads [provided: <name>] and never a value.
  const inputs = readRunInputs(ctx.ext.run.inputs);
  const identityParams = inputs?.identity ?? [];
  const savedIdentityOn = ctx.ext.flags.savedIdentity;
  if (identityParams.length && savedIdentityOn && (memory.chunks ?? 0) === 0) {
    for (const p of identityParams) memory.log.push(`[provided: ${p.label}] is your saved detail "${p.field}": fill it with fill_from_identity (call saved_identity first, on the page with the form).`);
  }
  const unasked = [...(inputs?.sensitive ?? []), ...(savedIdentityOn ? [] : identityParams.map((p) => ({ key: p.key, label: p.label })))].filter((p) => !memory.paramSecrets?.[p.key]);
  if (unasked.length) {
    const p = unasked[0]!;
    memory.askingParam = p.key;
    if (await ask({ kind: 'other', input: 'secret', prompt: `Enter ${p.label} for this run. The agent types it into the page; it is never shown to the agent or stored.` })) {
      await ctx.checkpoint();
      return pauseForPerson(ctx);
    }
    memory.askingParam = null;
    await closeRun(ctx, 'failed', { error: `Could not ask for ${p.label}`, stopReason: 'error' });
    return 'failed';
  }
  void run;
  return null;
}
