import { usePlatformHost } from '@marinoscar/platform-web/core';
import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';

import { getTask } from '../taskForm/api';
import { TaskForm } from '../components/TaskForm';
import { GOAL_MAX, copyValues, emptyValues, type TaskFormValues } from '../taskForm/values';
import { CardSkeleton, ErrorBanner, PageContainer, PageHeader } from '../ui';

/**
 * `/tasks/new`: a new task. `?goal=` prefills the goal; `?from=<taskId>`
 * starts from a copy of that task ("Copy of ...", the same policy, its
 * schedules paused).
 */
export function TaskCreatePage() {
  const { api } = usePlatformHost();
  const [params] = useSearchParams();
  const from = params.get('from');
  const goal = params.get('goal');
  const [initial, setInitial] = useState<TaskFormValues | null>(() => (from ? null : { ...emptyValues(), goal: (goal ?? '').slice(0, GOAL_MAX) }));
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!from) return;
    let live = true;
    getTask(api, from)
      .then((task) => live && setInitial(copyValues(task)))
      .catch(() => {
        if (!live) return;
        setError('The task to copy could not be loaded. You can still create a new one.');
        setInitial({ ...emptyValues(), goal: (goal ?? '').slice(0, GOAL_MAX) });
      });
    return () => {
      live = false;
    };
  }, [api, from, goal]);

  return (
    <PageContainer width="default">
      <PageHeader title="New task" back={{ to: '/tasks', label: 'Tasks' }} />
      <ErrorBanner error={error} onClose={() => setError(null)} />
      {initial === null ? <CardSkeleton /> : <TaskForm mode="create" initial={initial} cancelTo="/tasks" />}
    </PageContainer>
  );
}
