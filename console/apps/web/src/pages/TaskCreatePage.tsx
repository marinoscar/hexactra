import { usePlatformHost } from '@marinoscar/platform-web/core';
import { useEffect, useState } from 'react';
import { useLocation, useSearchParams } from 'react-router-dom';

import { getTask } from '../taskForm/api';
import { TaskForm } from '../components/TaskForm';
import { GOAL_MAX, copyValues, emptyValues, type TaskFormValues } from '../taskForm/values';
import type { ChatDraftState, ChatTaskDraft } from '../types/chat';
import type { BuilderDraftState, TaskBuilderDraft } from '../types/taskBuilder';
import type { ScheduleDraft } from '../schedule/draft';
import { MAX_SCHEDULES } from '../taskForm/values';
import AutoAwesomeIcon from '@mui/icons-material/AutoAwesome';
import { Alert } from '@mui/material';
import { TASK_BUILDER_ENABLED, useStartTaskBuilder } from '../components/useStartTaskBuilder';

import { CardSkeleton, ErrorBanner, PageContainer, PageHeader } from '../ui';

/** The form values of a task drafted from a chat (#489): every field the draft carries, no schedule. */
export function valuesFromDraft(draft: ChatTaskDraft): TaskFormValues {
  return {
    ...emptyValues(),
    name: String(draft.name ?? '').slice(0, 200),
    goal: String(draft.goal ?? '').slice(0, GOAL_MAX),
    profile: draft.profile || emptyValues().profile,
    hostId: draft.hostId ?? null,
    hostFallback: draft.hostFallback !== false,
    policyId: draft.policyId ?? null,
    allowedDomains: Array.isArray(draft.allowedDomains) ? draft.allowedDomains.filter((d) => typeof d === 'string') : [],
    confirmRiskyActions: draft.confirmRiskyActions === true,
    // The chat's saved-logins switch carries over (E37.3); a draft from before has none: off.
    useSavedLogins: draft.useSavedLogins === true,
    useSavedIdentity: draft.useSavedIdentity === true,
    useSavedCards: draft.useSavedCards === true,
    // The parameters the draft proposes (#556): the owner reviews each in the form; nothing is saved by the draft.
    parameters: Array.isArray(draft.parameters) ? draft.parameters.filter((p) => p && typeof p.key === 'string').map((p) => ({ ...p })) : [],
    // The outputs the draft proposes from what the finished run reported (E39.5): the owner reviews each row in the form.
    outputs: Array.isArray(draft.outputs) ? draft.outputs.filter((o) => o && typeof o.label === 'string').map((o) => ({ ...o, key: typeof o.key === 'string' ? o.key : '' })) : [],
    // A drafted task has no account list (E50.17): every run uses what the owner switched on in Connections and tools.
  };
}

/** The form values of a task drafted by the task builder (E42.2): the chat draft's fields, plus its schedules and run options. */
export function valuesFromBuilderDraft(draft: TaskBuilderDraft): TaskFormValues {
  const base = valuesFromDraft(draft);
  const schedules: ScheduleDraft[] = (Array.isArray(draft.schedules) ? draft.schedules : [])
    .filter((s) => s && typeof s.cron === 'string' && typeof s.timezone === 'string')
    .slice(0, MAX_SCHEDULES)
    .map((s) => ({ cron: s.cron, timezone: s.timezone, enabled: s.enabled !== false, concurrency: s.concurrency === 'queue' ? 'queue' : 'skip', policyId: null, ...(s.inputs && Object.keys(s.inputs).length ? { inputs: { ...s.inputs } } : {}) }));
  return {
    ...base,
    unattendedPayments: draft.unattendedPayments === 'allow' ? 'allow' : 'ask',
    recordVideo: draft.recordVideo === true,
    schedules,
  };
}

/** The builder's draft in the router's state, when the page was opened from the task builder. */
function builderDraftOf(state: unknown): BuilderDraftState | null {
  const s = state as Partial<BuilderDraftState> | null;
  return s && typeof s.builderId === 'string' && s.builderDraft && typeof s.builderDraft.goal === 'string' ? (s as BuilderDraftState) : null;
}

/** The chat's draft in the router's state, when the page was opened from a chat. */
function chatDraftOf(state: unknown): ChatDraftState | null {
  const s = state as Partial<ChatDraftState> | null;
  return s && typeof s.chatId === 'string' && s.chatDraft && typeof s.chatDraft.goal === 'string' ? (s as ChatDraftState) : null;
}

/**
 * `/tasks/new`: a new task. `?goal=` prefills the goal; `?from=<taskId>`
 * starts from a copy of that task ("Copy of ...", the same policy, its
 * schedules paused). Opened from a chat (#489) it starts from the task the
 * chat drafted, handed over in the router's state (never in the URL), and
 * tells the chat once the task is saved. Opened from the task builder (E42.2)
 * it starts from the builder's draft, with its schedules and the warnings the
 * owner should check, and links the builder once the task is saved.
 */
export function TaskCreatePage() {
  const { api } = usePlatformHost();
  const [params] = useSearchParams();
  const from = params.get('from');
  const goal = params.get('goal');
  const state = useLocation().state;
  const fromChat = chatDraftOf(state);
  const fromBuilder = fromChat ? null : builderDraftOf(state);
  const [initial, setInitial] = useState<TaskFormValues | null>(() => (fromChat ? valuesFromDraft(fromChat.chatDraft) : fromBuilder ? valuesFromBuilderDraft(fromBuilder.builderDraft) : from ? null : { ...emptyValues(), goal: (goal ?? '').slice(0, GOAL_MAX) }));
  const builder = useStartTaskBuilder();
  const warnings = (fromBuilder?.builderDraft.warnings ?? []).filter((w) => typeof w === 'string');
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

  const subtitle = fromChat ? 'Drafted from your chat. Check it, change what you like, then save.' : fromBuilder ? 'Drafted with the task builder. Check it, change what you like, then save.' : undefined;
  const back = fromChat ? { to: `/chat/${fromChat.chatId}`, label: 'Chat' } : fromBuilder ? { to: `/tasks/builder/${fromBuilder.builderId}`, label: 'Task builder' } : { to: '/tasks', label: 'Tasks' };
  const onCreated = fromChat
    ? (taskId: string) => api.post(`/chats/${fromChat.chatId}/task-link`, { taskId }).then(() => undefined)
    : fromBuilder
      ? (taskId: string) => api.post(`/task-builder/${fromBuilder.builderId}/task-link`, { taskId }).then(() => undefined)
      : undefined;

  return (
    <PageContainer width="default">
      <PageHeader
        title="New task"
        subtitle={subtitle}
        back={back}
        // A plain new task can be built with AI instead (E42.4); `?goal=` becomes the builder's first message.
        actions={[{ key: 'builder', label: builder.starting ? 'Starting…' : 'Build with AI', Icon: AutoAwesomeIcon, onClick: () => void builder.start(goal ?? undefined), disabled: builder.starting, hidden: !TASK_BUILDER_ENABLED || Boolean(fromChat || fromBuilder || from) }]}
      />
      <ErrorBanner error={error} onClose={() => setError(null)} />
      {warnings.map((w) => (
        <Alert key={w} severity="warning" sx={{ mb: 2 }}>
          {w}
        </Alert>
      ))}
      {initial === null ? <CardSkeleton /> : <TaskForm mode="create" initial={initial} useOwnerSavedLoginsDefault={!fromChat && !fromBuilder && !from} cancelTo={back.to} onCreated={onCreated} />}
    </PageContainer>
  );
}
