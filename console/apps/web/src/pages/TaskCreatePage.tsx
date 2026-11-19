import { usePlatformHost } from '@marinoscar/platform-web/core';
import { useEffect, useState } from 'react';
import { useLocation, useSearchParams } from 'react-router-dom';

import { getTask } from '../taskForm/api';
import { TaskForm } from '../components/TaskForm';
import { GOAL_MAX, copyValues, emptyValues, type TaskFormValues } from '../taskForm/values';
import type { ChatDraftState, ChatTaskDraft } from '../types/chat';
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
  };
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
 * tells the chat once the task is saved.
 */
export function TaskCreatePage() {
  const { api } = usePlatformHost();
  const [params] = useSearchParams();
  const from = params.get('from');
  const goal = params.get('goal');
  const fromChat = chatDraftOf(useLocation().state);
  const [initial, setInitial] = useState<TaskFormValues | null>(() => (fromChat ? valuesFromDraft(fromChat.chatDraft) : from ? null : { ...emptyValues(), goal: (goal ?? '').slice(0, GOAL_MAX) }));
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
      <PageHeader title="New task" subtitle={fromChat ? 'Drafted from your chat. Check it, change what you like, then save.' : undefined} back={fromChat ? { to: `/chat/${fromChat.chatId}`, label: 'Chat' } : { to: '/tasks', label: 'Tasks' }} />
      <ErrorBanner error={error} onClose={() => setError(null)} />
      {initial === null ? <CardSkeleton /> : <TaskForm mode="create" initial={initial} useOwnerSavedLoginsDefault={!fromChat && !from} cancelTo={fromChat ? `/chat/${fromChat.chatId}` : '/tasks'} onCreated={fromChat ? (taskId) => api.post(`/chats/${fromChat.chatId}/task-link`, { taskId }).then(() => undefined) : undefined} />}
    </PageContainer>
  );
}
