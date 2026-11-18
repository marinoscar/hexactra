// "Started by <app>" (#465): a confirmation the runner asks on a run an AI app
// started names the app, so the person approving a purchase sees where the
// goal came from (a hosted model may have been talked into it by a page).
import { friendlyAppName } from './request-client';

/** The line appended to a confirmation of an app's run. */
export function startedByLine(clientName: string | null | undefined): string {
  return `Started by ${friendlyAppName(clientName)}.`;
}

/**
 * `spec` with "Started by <app>" appended to its prompt when the run was
 * started by an AI app (`origin: mcp` with a client name) and the question is
 * a confirmation (`kind: confirmation` or `input: confirm`). Anything else is
 * returned as it is. The prompt stays within its 2,000 characters.
 */
export function withAppOrigin<T extends { kind: string; input: string; prompt: string }>(spec: T, run: { origin?: string | null; clientName?: string | null }): T {
  if (run.origin !== 'mcp' || !run.clientName) return spec;
  if (spec.kind !== 'confirmation' && spec.input !== 'confirm') return spec;
  const line = startedByLine(run.clientName);
  if (spec.prompt.includes(line)) return spec;
  const room = 2000 - line.length - 2;
  return { ...spec, prompt: `${spec.prompt.slice(0, room)}\n\n${line}` };
}
