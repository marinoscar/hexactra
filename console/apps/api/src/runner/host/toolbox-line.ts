// What a run reads about its tools (E41.2, #699): the instructions built from the families offered, and the round's context lines (the
// allowed sites when the browser is offered, then the toolbox line naming the families, the accounts and the added tools). Shared by the
// host (`build-context.ts`) and the scenario kit, so a scenario reads exactly what a run reads. Identical in every round of a run.
import { browserInstructions } from '@marinoscar/hexactra-browser-agent/instructions';
import { sitesLine } from '@marinoscar/hexactra-browser-agent/round';
import { toolFamilyOf, type AnyContext, type ToolRegistry } from '@marinoscar/hexactra-agent';

/** The instructions of a run: the neutral identity, the families offered with the routing rule and their how-to, the general sections, the notes. */
export function runInstructions<C extends AnyContext>(registry: ToolRegistry<C>, ctx: C, askTopics: readonly string[]): string {
  return browserInstructions(askTopics, { families: registry.families(ctx) as never, usageNotes: registry.usageNotes(ctx) });
}

/** Whether a browser tool is offered: a run with none reads no "Allowed sites" line. */
export const offersBrowser = <C extends AnyContext>(registry: ToolRegistry<C>, ctx: C): boolean => registry.list(ctx).some((t) => toolFamilyOf(t) === 'browser');

/**
 * The toolbox line: `Tools you have: <family titles>. Accounts: <...>. Added tools: <...>.` Segments with nothing to say are omitted; null
 * when the run has no family to name.
 */
export function toolboxLine<C extends AnyContext>(registry: ToolRegistry<C>, ctx: C): string | null {
  const families = registry.families(ctx);
  if (families.length === 0) return null;
  const accounts = families.filter((f) => f.id === 'accounts').map((f) => f.toolbox?.(ctx)).filter((x): x is string => Boolean(x));
  const added = families.filter((f) => f.id.startsWith('mcp:')).map((f) => f.toolbox?.(ctx)).filter((x): x is string => Boolean(x));
  return [`Tools you have: ${families.map((f) => f.title).join(', ')}.`, ...(accounts.length ? [`Accounts: ${accounts.join('; ')}.`] : []), ...(added.length ? [`Added tools: ${added.join('; ')}.`] : [])].join(' ');
}

/** The round's context lines: the allowed sites (only with a browser), then the toolbox line, then the host's own (`extra`). */
export function runContextLines<C extends AnyContext>(registry: ToolRegistry<C>, ctx: C, extra: readonly string[] = []): string[] {
  const toolbox = toolboxLine(registry, ctx);
  return [...(offersBrowser(registry, ctx) ? [sitesLine(ctx as never)] : []), ...(toolbox ? [toolbox] : []), ...extra];
}

/** The volatile line of the pictures the agent can attach (E41.4), at most 15, newest last; null with none. */
export function attachableLine(steps: readonly number[]): string | null {
  if (steps.length === 0) return null;
  return `Screenshots you can attach: steps ${steps.slice(-15).join(', ')}.`;
}

const EXPECTS: Record<string, string> = {
  accounts: "the owner's accounts only",
  browser: 'a website',
  both: "both a website and the owner's accounts",
};

/** The chat's hint of what the job needs (E41.3), or null: only for a run with a connection, and never a limit (no tool is removed). */
export function expectsLine(expects: unknown, hasConnections: boolean): string | null {
  if (!hasConnections || typeof expects !== 'string' || !(expects in EXPECTS)) return null;
  return `The chat expects this job to need: ${EXPECTS[expects]}.`;
}
