import AutoAwesomeIcon from '@mui/icons-material/AutoAwesome';
import { Alert, Box, Button, Paper, Stack, Tab, Tabs, Typography } from '@mui/material';
import { usePlatformHost } from '@marinoscar/platform-web/core';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';

import { ChatComposer } from '../components/ChatComposer';
import { ThreadRows, TypingIndicator, type ThreadCards } from '../components/ChatMessages';
import { lastSeq, threadRows } from '../components/chatThread';
import { TaskSpecPanel, canCreate } from '../components/TaskSpecPanel';
import { useTaskBuilder } from '../components/useTaskBuilder';
import type { ChatMessage } from '../types/chat';
import type { BuilderDraftState, TaskBuilderDraft } from '../types/taskBuilder';
import { CardSkeleton, aboveBottomBar, EmptyState, ErrorBanner, PageContainer, PageHeader, toast, useBreakpoint, useProfileTimeZone } from '../ui';

/** The paths of the task builder (E42.4). */
export const taskBuilderPaths = { builder: (id: string) => `/tasks/builder/${id}` };

/** What a run card needs from a page that has no run: nothing is live, nothing is shown. */
const NO_RUN_CARDS: Omit<ThreadCards, 'onReviewDraft'> = { run: null, frame: { src: null, shotAt: null, failing: false }, frameHidden: true, now: 0, paneOpen: false, onOpenBrowser: () => undefined, onCardVisible: () => undefined };

const FIRST_QUESTION = 'What should this task do? Describe the outcome you want, and I will ask about the rest: where, what changes each time, what to keep, the guardrails and when it runs.';

/**
 * `/tasks/builder/:id`: the AI task builder (E42.4). The owner talks to the
 * builder; the spec it keeps fills in beside the thread (below it, as a tab,
 * on a phone or a tablet). **Create task** drafts the task and opens the task
 * form prefilled with it: the owner's Save there is the acceptance.
 */
export function TaskBuilderPage() {
  const { id = '' } = useParams();
  const { api, viewer } = usePlatformHost();
  const navigate = useNavigate();
  const { isDesktop, isPhone } = useBreakpoint();
  const timeZone = useProfileTimeZone();
  const state = useTaskBuilder(id);
  const { builder, messages } = state;
  const [draftText, setDraftText] = useState('');
  const [sending, setSending] = useState(false);
  const [creating, setCreating] = useState(false);
  const [tab, setTab] = useState<'thread' | 'spec'>('thread');
  const end = useRef<HTMLDivElement | null>(null);

  const canWrite = viewer.hasPermission('tasks:write');
  const archived = builder?.status === 'archived';
  const mayType = canWrite && !archived;
  const spec = builder?.spec ?? {};
  const rows = useMemo(() => threadRows(messages, timeZone), [messages, timeZone]);
  const newest = lastSeq(messages);

  useEffect(() => {
    end.current?.scrollIntoView?.({ block: 'end' });
  }, [newest, state.thinking]);

  const open = (draft: TaskBuilderDraft) => navigate('/tasks/new', { state: { builderId: id, builderDraft: draft } satisfies BuilderDraftState });

  const send = async (text: string) => {
    const body = text.trim();
    if (!body || sending) return;
    setSending(true);
    try {
      await state.send(body);
      setDraftText('');
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not send the message', 'error');
    } finally {
      setSending(false);
    }
  };

  const create = async () => {
    setCreating(true);
    try {
      open(await api.post<TaskBuilderDraft>(`/task-builder/${id}/draft`, {}));
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not draft the task', 'error');
    } finally {
      setCreating(false);
    }
  };

  /** A `task_draft` message's Review and save: the whole draft is the message's meta. */
  const reviewDraft = () => {
    const last = [...messages].reverse().find((m: ChatMessage) => m.kind === 'task_draft');
    const meta = last?.meta as TaskBuilderDraft | null | undefined;
    if (meta && typeof meta.goal === 'string') open(meta);
  };

  if (state.notFound) {
    return (
      <PageContainer width="default">
        <PageHeader title="Task builder" back={{ to: '/tasks', label: 'Tasks' }} />
        <EmptyState title="This task builder was not found" body="It may have been deleted, or it is not yours." action={{ key: 'tasks', label: 'Back to tasks', to: '/tasks' }} />
      </PageContainer>
    );
  }

  const ready = spec.ready === true;
  const createAction = { key: 'create', label: creating ? 'Drafting…' : 'Create task', Icon: AutoAwesomeIcon, onClick: () => void create(), disabled: !mayType || creating || !canCreate(spec), hidden: !canWrite } as const;

  const thread = (
    <Paper variant="outlined" component="section" aria-label="Conversation" sx={{ p: { xs: 1.5, sm: 2 }, borderRadius: 3, display: 'flex', flexDirection: 'column', gap: 1, minHeight: { md: 480 } }}>
      {messages.length === 0 && !state.thinking && (
        <Box sx={{ py: 1 }}>
          <Typography variant="body1" sx={{ overflowWrap: 'anywhere' }}>
            {FIRST_QUESTION}
          </Typography>
        </Box>
      )}
      <Box role="log" aria-live="polite" sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
        <ThreadRows rows={rows} answerableSeq={mayType && !sending ? newest : null} onAnswer={(t) => void send(t)} cards={{ ...NO_RUN_CARDS, onReviewDraft: canWrite ? reviewDraft : undefined }} />
        {state.thinking && <TypingIndicator />}
        <div ref={end} />
      </Box>
      {archived ? (
        <Alert severity="info">This builder's task was saved. Start a new builder to create another task.</Alert>
      ) : (
        mayType && (
          // On a phone the composer stays reachable above the bottom bar, like the kit's other sticky action bars.
          <Box sx={{ position: { xs: 'sticky', sm: 'static' }, bottom: aboveBottomBar(0), bgcolor: 'background.paper', pt: 1, zIndex: 1 }}>
            <ChatComposer value={draftText} onChange={setDraftText} onSend={() => void send(draftText)} busy={sending} enterSends={!isPhone} autoFocus={!isPhone} placeholder={messages.length ? 'Answer, or say "create" when you are happy' : 'Describe the task you want'} />
          </Box>
        )
      )}
      {ready && !archived && canWrite && (
        <Button variant="contained" startIcon={<AutoAwesomeIcon />} onClick={() => void create()} disabled={creating} sx={{ alignSelf: 'flex-start', minHeight: { xs: 44, sm: 36 }, borderRadius: 3 }}>
          {creating ? 'Drafting…' : 'Create task'}
        </Button>
      )}
    </Paper>
  );
  const panel = <TaskSpecPanel spec={spec} onPatch={mayType ? (p) => state.patchSpec(p).catch((e: unknown) => toast(e instanceof Error ? e.message : 'Could not change the task', 'error')) : undefined} />;

  return (
    <PageContainer width="wide">
      <PageHeader title={builder?.title || 'New task with AI'} subtitle="Answer a few questions. The task fills in as you go; nothing is saved until you review it." back={{ to: '/tasks', label: 'Tasks' }} primary={createAction} />
      <ErrorBanner error={state.error} onClose={() => undefined} />
      {state.loading || !builder ? (
        <CardSkeleton />
      ) : isDesktop ? (
        <Stack direction="row" spacing={2} sx={{ alignItems: 'flex-start' }}>
          <Box sx={{ flex: 1, minWidth: 0 }}>{thread}</Box>
          <Box sx={{ width: 360, flexShrink: 0, position: 'sticky', top: 80 }}>{panel}</Box>
        </Stack>
      ) : (
        <>
          <Tabs value={tab} onChange={(_, v: 'thread' | 'spec') => setTab(v)} variant="fullWidth" sx={{ mb: 1.5 }} aria-label="Task builder views">
            <Tab value="thread" label="Conversation" />
            <Tab value="spec" label="Task so far" />
          </Tabs>
          {tab === 'thread' ? thread : panel}
        </>
      )}
    </PageContainer>
  );
}
