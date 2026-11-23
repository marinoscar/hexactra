import { Alert, Chip } from '@mui/material';

import type { KgHealth, KgMode, KgRunMode, KgStatus, KgStepHow, KgVersionItem, KgVersionState } from './api';
import { formatCost } from '../ui';

/** The three choices of a task, each with one line of help. `off` is "AI only". */
export const MODE_CHOICES: { value: KgMode; label: string; help: string }[] = [
  { value: 'off', label: 'AI only', help: 'The agent does every run, as today. Nothing is learned.' },
  { value: 'learn', label: 'Learn only', help: 'The agent still does every run; its steps are saved as a procedure you can read.' },
  { value: 'reuse', label: 'Learn and reuse', help: 'Saved steps run without the model; the agent takes over or repairs when a page changed.' },
];
export const MODE_LABEL: Record<KgMode, string> = { off: 'AI only', learn: 'Learn only', reuse: 'Learn and reuse' };
export const RUN_MODE_LABEL: Record<KgRunMode, string> = { ...MODE_LABEL, everyday: 'Chat or one-off run' };
/** "Used in chats and one-off runs: N" (E46.29): from the procedure's `everyday` ledger rows. */
export const everydayUsesText = (n: number) => `Used in chats and one-off runs: ${n}`;

export const STATE_LABEL: Record<KgVersionState, string> = { candidate: 'Candidate', verified: 'Verified', active: 'Active', suspended: 'Suspended', retired: 'Retired', rejected: 'Rejected' };
const STATE_COLOR: Record<KgVersionState, 'default' | 'info' | 'success' | 'warning' | 'error'> = { candidate: 'info', verified: 'info', active: 'success', suspended: 'warning', retired: 'default', rejected: 'error' };

export const HEALTH_LABEL: Record<KgHealth, string> = { healthy: 'Healthy', degraded: 'Degraded', failing: 'Failing', unknown: 'No runs yet' };
const HEALTH_COLOR: Record<KgHealth, 'default' | 'success' | 'warning' | 'error'> = { healthy: 'success', degraded: 'warning', failing: 'error', unknown: 'default' };

/** A step's kind in words. A kind this build does not know reads as its raw text. */
export const KIND_LABEL: Record<string, string> = { call: 'Action', extract: 'Read a value', judge: 'Decide', ask: 'Ask you', check: 'Check', branch: 'Choice', foreach: 'Repeat', agent: 'Agent' };
export const kindLabel = (kind: string) => KIND_LABEL[kind] ?? kind;

export const HOW_LABEL: Record<KgStepHow, string> = { replayed: 'Replayed', recovered: 'Recovered', judged: 'Small AI call', agent: 'Agent', not_reached: 'Not reached' };
const HOW_COLOR: Record<KgStepHow, 'default' | 'success' | 'info' | 'warning'> = { replayed: 'success', recovered: 'info', judged: 'warning', agent: 'warning', not_reached: 'default' };

export function StateChip({ state }: { state: KgVersionState | null }) {
  if (!state) return <Chip size="small" label="No version" />;
  return <Chip size="small" color={STATE_COLOR[state]} variant={state === 'active' ? 'filled' : 'outlined'} label={STATE_LABEL[state]} />;
}

export function HealthChip({ health }: { health: KgHealth }) {
  return <Chip size="small" variant="outlined" color={HEALTH_COLOR[health]} label={HEALTH_LABEL[health]} />;
}

/** Whether a step needs the model: none, one small call (a judge step) or the agent loop. */
export function AiChip({ kind, usesAi }: { kind: string; usesAi: boolean }) {
  const label = !usesAi ? 'No AI' : kind === 'agent' ? 'Agent' : 'Small AI call';
  return <Chip size="small" color={!usesAi ? 'success' : kind === 'agent' ? 'warning' : 'info'} variant="outlined" label={label} />;
}

export function HowChip({ how }: { how: KgStepHow }) {
  return <Chip size="small" variant="outlined" color={HOW_COLOR[how]} label={HOW_LABEL[how]} />;
}

/**
 * Where a version came from, from what the versions list carries: no parent is learned from a run; a copy of an earlier version
 * that keeps its `initial` change class is a restore; a structural or sensitive change is a repair.
 */
export function versionSource(v: KgVersionItem, all: readonly KgVersionItem[]): string {
  if (!v.parentId) return 'Learned from a run';
  const parent = all.find((p) => p.id === v.parentId);
  const of = parent ? ` from version ${parent.number}` : '';
  if (v.changeClass === 'initial') return `Restored${of}`;
  return `Repaired${of}${v.changeClass === 'sensitive' ? ' (sensitive change)' : ''}`;
}

/** "3 fewer model calls and $0.42 less than AI only per run", or "no baseline yet". */
export function savingText(s: { saving: { modelCalls: number; costUsd: number; costKnown: boolean } | null; note: string | null } | undefined): string {
  if (!s) return 'No runs with the Knowledge Graph yet';
  if (!s.saving) return s.note ?? 'No saving measured yet';
  const calls = Math.round(s.saving.modelCalls * 10) / 10;
  const callsText = calls >= 0 ? `${calls} fewer model calls` : `${-calls} more model calls`;
  const cost = formatCost(Math.abs(s.saving.costUsd), s.saving.costKnown) ?? '$0.00';
  return `${callsText} and ${cost} ${s.saving.costUsd >= 0 ? 'less' : 'more'} than AI only, per run`;
}

/** Why "Use in chats and one-off runs" cannot be changed yet: it works only while the Knowledge Graph is on for the deployment and the owner. */
export function everydayDisabledReason(status: KgStatus): string | null {
  if (!status.deployment) return 'Available once your administrator allows the Knowledge Graph on this console.';
  if (!status.user) return 'Turn on "Use the Knowledge Graph for my saved tasks" first.';
  return null;
}

/** Why the feature does nothing for this viewer, or null when it is on. Says who can turn it on and that nothing was deleted. */
export function offReason(status: KgStatus | null): string | null {
  if (!status) return 'The Knowledge Graph is not available to you.';
  if (!status.deployment) return 'The Knowledge Graph is off for this console. Only an administrator can turn it on. Nothing learned was deleted.';
  if (!status.user) return 'You have not turned the Knowledge Graph on. Turn it on in Settings, Knowledge Graph. Nothing learned was deleted.';
  return null;
}

/** The off state of a page: what the feature is, that it is off, who can turn it on, and that nothing was deleted. */
export function KgraphOffNotice({ status }: { status: KgStatus | null }) {
  const reason = offReason(status);
  if (!reason) return null;
  return (
    <Alert severity="info" sx={{ mb: 2 }} data-testid="kgraph-off">
      The Knowledge Graph learns the steps of your saved tasks from their runs, so later runs can repeat them without the model. {reason}
    </Alert>
  );
}
