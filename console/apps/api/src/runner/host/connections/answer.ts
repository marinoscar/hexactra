// The owner's answer to a question that needs no browser (E39.7): a call through one of their connections they were asked to approve, or any
// question a run with no browser yet asked. The run waits with no handoff; this reads the answer back from the question the broker holds.
import type { QuestionAction } from '../../../questions/questions.contract';
import type { FabricHandoff } from '../../fabric-handoff';
import { clearUnknown } from '../../harness';
import { intentTarget } from '../tools/connections/support';
import type { ConnectionAsk } from './memory';
import type { RunMemory } from '../run-memory';

/** The broker's question, as the run reads it back (the columns the resume needs). */
export interface FreeQuestion {
  id: string;
  status: string;
  input: string;
  kind: string;
  prompt: string;
  action: unknown;
  response: unknown;
}

/** A handoff-shaped view of a question: the resume code folds a browser handoff and a question the same way. */
export function handoffOfQuestion(q: FreeQuestion): FabricHandoff {
  const r = (q.response ?? null) as { outcome?: 'completed' | 'cancelled'; value?: string; values?: string[]; remember?: boolean } | null;
  const status = q.status === 'answered' ? 'completed' : q.status === 'pending' ? 'pending' : q.status === 'expired' ? 'expired' : 'cancelled';
  return {
    id: q.id,
    status,
    input: q.input as FabricHandoff['input'],
    kind: q.kind,
    ...(r ? { response: { outcome: r.outcome, value: r.value, values: r.values, remember: r.remember } } : {}),
  };
}

/**
 * What the owner decided about a call through a connection: the approval lets exactly that call through once (the gate compares the hash of
 * the validated arguments), a refusal is remembered so the gate does not ask for the same call again. Returns the line the model reads.
 */
export function foldConnectionAnswer(memory: RunMemory, q: { id: string; prompt: string; action: unknown }, approved: boolean): string | null {
  const action = (q.action ?? null) as QuestionAction | null;
  if (!action) return null;
  const mem = (memory.connections ??= {});
  const asked: ConnectionAsk = { questionId: q.id, connectionId: action.connectionId, tool: action.tool, argsHash: action.hash ?? '', prompt: q.prompt };
  if (approved) {
    // The owner decided again about a call that may have happened (E38.3): it is no longer unknown.
    clearUnknown(memory, intentTarget(asked.tool, asked.connectionId));
    mem.approved = asked;
    return `The owner approved this call (${action.tool} with ${action.connectionLabel}). Call ${action.tool} again with exactly the same arguments.`;
  }
  mem.declined = [...(mem.declined ?? []), { connectionId: asked.connectionId, tool: asked.tool, argsHash: asked.argsHash }].slice(-20);
  return `The owner declined this call (${action.tool} with ${action.connectionLabel}). It was not done. Do not try it again; tell the owner it was not done and continue without it, or finish.`;
}
