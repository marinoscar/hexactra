import { AsyncLocalStorage } from 'node:async_hooks';
// Commit-class tools (E38.3): a tool that can commit something outside the run (a click that pays or orders, a typed secret, later
// a provider fill or a connection tool that sends or creates) declares `commits: true`. The runner then writes an `intent` step
// before the action is sent, so a job that dies between the send and the recording of the result leaves evidence: on the next
// start the step is `unknown` and is never repeated blindly (reconcile.ts).

const scope = new AsyncLocalStorage<{ commits: true }>();

/** Whether the tool call running now was declared `commits: true`. */
export function inCommitTool(): boolean {
  return scope.getStore()?.commits === true;
}

/** Runs `fn` as a commit-class tool call: `inCommitTool()` is true inside it, for this call only (parallel calls keep their own marker). */
export function runAsCommit<T>(fn: () => T): T {
  return scope.run({ commits: true }, fn);
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
