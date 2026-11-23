import { isPlatformApiError, usePlatformHost } from '@marinoscar/platform-web/core';
import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';

import { getTask } from '../taskForm/api';
import { TaskForm, taskPath } from '../components/TaskForm';
import { valuesFromTask, type TaskWithSchedules } from '../taskForm/values';
import { TaskKgraphControl } from '../kgraph/TaskKgraphControl';
import { CardSkeleton, EmptyState, ErrorBanner, PageContainer, PageHeader } from '../ui';

/** `/tasks/:id/edit`: change a task and its schedules in one form. */
export function TaskEditPage() {
  const { api } = usePlatformHost();
  const { id = '' } = useParams();
  const [task, setTask] = useState<TaskWithSchedules | null>(null);
  const [missing, setMissing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setTask(await getTask(api, id));
    } catch (e) {
      // A task that is not the viewer's answers 404 too; a malformed id is a 400.
      if (isPlatformApiError(e) && (e.status === 404 || e.status === 400)) setMissing(true);
      else setError(e instanceof Error && e.message ? e.message : 'Could not load the task');
    }
  }, [api, id]);

  useEffect(() => {
    void load();
  }, [load]);

  if (missing) {
    return (
      <PageContainer width="default">
        <EmptyState title="This task does not exist" body="It may have been deleted." action={{ key: 'tasks', label: 'Back to Tasks', to: '/tasks' }} />
      </PageContainer>
    );
  }
  return (
    <PageContainer width="default">
      <PageHeader title="Edit task" back={{ to: taskPath(id), label: task?.name ?? 'Task' }} />
      <ErrorBanner error={error} onRetry={() => void load()} />
      {task === null ? !error && <CardSkeleton /> : <TaskForm mode="edit" taskId={task.id} initial={valuesFromTask(task)} savedSchedules={task.summary?.schedules} cancelTo={taskPath(id)} />}
      {/* The Knowledge Graph (E46.20): saved on its own through /api/tasks/{id}/kgraph; nothing without `kgraph:read`. */}
      {task !== null && <TaskKgraphControl taskId={task.id} mt={3} />}
    </PageContainer>
  );
}
