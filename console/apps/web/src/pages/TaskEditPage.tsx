import { isPlatformApiError, usePlatformHost } from '@marinoscar/platform-web/core';
import { Alert } from '@mui/material';
import { useCallback, useEffect, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';

import { getTask } from '../taskForm/api';
import { TaskForm, taskPath } from '../components/TaskForm';
import { valuesFromTask, type TaskWithSchedules } from '../taskForm/values';
import { TaskKgraphControl } from '../kgraph/TaskKgraphControl';
import { createSiteFact } from '../kgraph/api';
import { getImprovement, markApplied, type Improvement } from '../taskImprover/api';
import { CardSkeleton, EmptyState, ErrorBanner, PageContainer, PageHeader, toast } from '../ui';

/**
 * `/tasks/:id/edit`: change a task and its schedules in one form. With `?improvement=<id>` (E52.9) the goal starts as that proposal's,
 * with a banner; nothing changes until the owner saves. After the save, the proposal is marked applied with the goal as saved, then the
 * site facts the owner ticked (`?facts=0,2`) are added as the owner's own. A failure there is said, and never undoes the save.
 */
export function TaskEditPage() {
  const { api } = usePlatformHost();
  const { id = '' } = useParams();
  const [search] = useSearchParams();
  const improvementId = search.get('improvement');
  const tickedFacts = (search.get('facts') ?? '')
    .split(',')
    .filter(Boolean)
    .map(Number)
    .filter((n) => Number.isInteger(n) && n >= 0);
  const [task, setTask] = useState<TaskWithSchedules | null>(null);
  const [proposal, setProposal] = useState<Improvement | null>(null);
  const [missing, setMissing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    // The proposal first, so the form opens once, with the right goal.
    let found: Improvement | null = null;
    if (improvementId) {
      try {
        const p = await getImprovement(api, improvementId);
        found = p.status === 'ready' && p.taskId === id && p.proposedGoal ? p : null;
      } catch {
        found = null;
      }
    }
    try {
      const t = await getTask(api, id);
      setProposal(found);
      setTask(t);
    } catch (e) {
      // A task that is not the viewer's answers 404 too; a malformed id is a 400.
      if (isPlatformApiError(e) && (e.status === 404 || e.status === 400)) setMissing(true);
      else setError(e instanceof Error && e.message ? e.message : 'Could not load the task');
    }
  }, [api, id, improvementId]);

  useEffect(() => {
    void load();
  }, [load]);

  /** After the form saved the task: record the proposal applied, with the goal as the API now has it, then add the ticked facts. */
  const onSaved = useCallback(
    async (taskId: string) => {
      if (!proposal) return;
      try {
        const saved = await getTask(api, taskId);
        await markApplied(api, proposal.id, saved.goal);
      } catch {
        return;
      }
      const facts = (proposal.siteFacts ?? []).filter((_, i) => tickedFacts.includes(i));
      let failed = 0;
      for (const f of facts) {
        try {
          await createSiteFact(api, f.site, { kind: f.kind, text: f.text });
        } catch {
          failed += 1;
        }
      }
      if (failed) toast(`The goal was saved, but ${failed} of the site facts could not be added. Add them on the Knowledge Graph page.`, 'error');
    },
    [api, proposal, tickedFacts.join(',')],
  );

  if (missing) {
    return (
      <PageContainer width="default">
        <EmptyState title="This task does not exist" body="It may have been deleted." action={{ key: 'tasks', label: 'Back to Tasks', to: '/tasks' }} />
      </PageContainer>
    );
  }
  const initial = task ? { ...valuesFromTask(task), ...(proposal?.proposedGoal ? { goal: proposal.proposedGoal } : {}) } : null;
  return (
    <PageContainer width="default">
      <PageHeader title="Edit task" back={{ to: taskPath(id), label: task?.name ?? 'Task' }} />
      <ErrorBanner error={error} onRetry={() => void load()} />
      {/* The Knowledge Graph (E46.20, #1031): first, above the form, since it saves on its own through /api/tasks/{id}/kgraph; nothing without `kgraph:read`. */}
      {task !== null && <TaskKgraphControl taskId={task.id} mb={3} />}
      {proposal && (
        <Alert severity="info" sx={{ mb: 2 }}>
          The goal below is the one proposed from your last {proposal.runIds.length} {proposal.runIds.length === 1 ? 'run' : 'runs'}. Nothing changes until you save.
        </Alert>
      )}
      {task === null && !error && <CardSkeleton />}
      {task !== null && initial !== null && (
        <TaskForm key={proposal?.id ?? 'task'} mode="edit" taskId={task.id} initial={initial} savedSchedules={task.summary?.schedules} cancelTo={taskPath(id)} onSaved={proposal ? onSaved : undefined} />
      )}
    </PageContainer>
  );
}
