import { AsyncLocalStorage } from 'node:async_hooks';
import { defineTool, type AiDefinedTool } from '@marinoscar/platform-api/ai';
import type { z } from 'zod';

// Commit-class tools (E38.3): a tool that can commit something outside the run (a click that pays or orders, a typed secret, later
// a provider fill or a connection tool that sends or creates) declares `commits: true`. The runner then writes an `intent` step
// before the action is sent, so a job that dies between the send and the recording of the result leaves evidence: on the next
// start the step is `unknown` and is never repeated blindly (reconcile.ts).

const scope = new AsyncLocalStorage<{ commits: true }>();

/** Whether the tool call running now was declared `commits: true`. */
export function inCommitTool(): boolean {
  return scope.getStore()?.commits === true;
}

/**
 * `defineTool` with one more field. `commits: true` marks the tool commit-class: its fabric actions get an intent record.
 * Parallel calls of one model response each keep their own marker (async local storage), never a shared flag.
 */
export function defineRunTool<P extends z.ZodTypeAny, R>(def: Parameters<typeof defineTool<P, R>>[0] & { commits?: boolean }): AiDefinedTool<P, R> {
  const { commits, ...rest } = def;
  const tool = defineTool<P, R>(rest);
  if (!commits) return tool;
  return { ...tool, execute: (args, ctx) => scope.run({ commits: true }, () => tool.execute(args, ctx)) };
}

/** Fabric actions that change the page or the machine, as opposed to reading it. After an approved confirmation each of them is intent-recorded. */
const MUTATING = new Set(['click', 'click_at', 'type', 'type_keys', 'key', 'press', 'evaluate', 'drag', 'type_secret', 'desktop_click', 'desktop_type', 'desktop_key', 'desktop_drag']);
export function mutatingAction(type: string): boolean {
  return MUTATING.has(type);
}

/** What an intent step names, in the words the model reads back if the step ends `unknown`. */
export function describeIntent(action: string, args: Record<string, unknown>, gate?: { label: string | null } | null): string {
  if (gate?.label) return `press '${gate.label}'`;
  if (action === 'type' && 'secret' in args) return 'type a secret into a field';
  if (typeof args.selector === 'string') return `${action} ${args.selector}`;
  return action;
}
