// What the saved-login, saved-identity and saved-card tools share: the run's memory for each, the persistence of it, and the
// refusals. A value never reaches this process, a step, the memory or the model: only names, masked usernames and origins do.
import { SecretsProviderError } from '../../../secrets/secrets-provider.port';
import { currentUrl } from '@marinoscar/hexactra-browser-agent/page';
import { pageOf, noteFilled, type SavedIdentityMemory } from '../../saved-identity';
import type { SavedLoginsMemory } from '../../saved-logins';
import type { HostContext } from '../context';

export const sl = (ctx: HostContext): SavedLoginsMemory => (ctx.memory.savedLogins ??= { refs: {} });
export const si = (ctx: HostContext): SavedIdentityMemory => (ctx.memory.savedIdentity ??= { refs: {} });

export const loginOpts = (ctx: HostContext) => ({ runId: ctx.run.id, clientLabel: ctx.ext.clientLabel });

/** The saved-secrets memory is written at once, before and after every field: a crash between two fields finds what was typed. */
export async function persistSavedSecrets(ctx: HostContext): Promise<void> {
  if (!(await ctx.ports.store.saveMemory(ctx.memory))) ctx.state.stop = 'lease';
}

export function originOf(url: string | null): string | null {
  try {
    return url ? new URL(url).origin : null;
  } catch {
    return null;
  }
}

/** A refusal the model reads, recorded as a failed step (never a typed value: there is none). */
export async function refuseSaved(ctx: HostContext, action: string, args: Record<string, unknown>, started: number, text: string, summary: string): Promise<string> {
  await ctx.record('action', action, args, false, summary, started, undefined, { secret: true });
  return text;
}

/** The provider or the browser host refused for good (nothing was typed), as opposed to an outcome nobody knows (a timeout, a cancel). */
export const definitiveRefusal = (e: unknown): boolean => e instanceof SecretsProviderError && !['timed_out', 'cancelled', 'unknown'].includes(e.code);

/** The inputs of this page the browser host filled from a provider are never read back: record one (an identity field, or a login's username, password or code). */
export async function noteFilledInput(ctx: HostContext, selector: string, label: string): Promise<void> {
  const page = pageOf(await currentUrl(ctx));
  if (page) noteFilled(si(ctx), { page, selector, label });
}
