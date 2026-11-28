import AddCommentIcon from '@mui/icons-material/AddCommentOutlined';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import InboxOutlinedIcon from '@mui/icons-material/InboxOutlined';
import ChatBubbleOutlineIcon from '@mui/icons-material/ChatBubbleOutlineOutlined';
import KeyboardArrowDownIcon from '@mui/icons-material/KeyboardArrowDown';
import MenuIcon from '@mui/icons-material/Menu';
import MoreVertIcon from '@mui/icons-material/MoreVert';
import { Alert, Box, Button, Chip, CircularProgress, Dialog, DialogActions, DialogContent, DialogTitle, Drawer, Fab, IconButton, Menu, MenuItem, Stack, TextField, Typography, useMediaQuery } from '@mui/material';
import { useTheme } from '@mui/material/styles';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link as RouterLink, useLocation, useMatch, useNavigate, useParams } from 'react-router-dom';
import { usePlatformHost } from '@marinoscar/platform-web/core';
import { useShellMainVariant } from '@marinoscar/platform-web/shell/headless';
import { useOptionalAuth } from '@marinoscar/platform-web/identity/headless';

import { BrowserPane, confirmedPromptOf } from '../components/ChatBrowser';
import { runAgainQuestion } from '../components/runRow';
import { ChatComposer } from '../components/ChatComposer';
import { ChatOptions, type ChatRunChoice } from '../components/ChatOptions';
import { useInboxCount } from '../components/InboxCountProvider';
import { firstName, greeting } from '../components/home/homeText';
import { ChatRequestCard, RequestSettled, settledText, type RequestResult } from '../components/ChatRequest';
import { ChatList, type ChatRowAction } from '../components/ChatList';
import { ThreadRows, TypingIndicator, type ThreadCards } from '../components/ChatMessages';
import { ChatSettingsDialog } from '../components/ChatSettingsDialog';
import { EXAMPLE_PROMPTS, chatPaths, chatSubtitle, chatTitle, lastSeq, threadRows } from '../components/chatThread';
import { useChat } from '../components/useChat';
import { useChatList } from '../components/useChatList';
import { isSettledError, type AnswerBody, type Question } from '../components/questions';
import { ShellBanners } from '../components/ShellBanners';
import { useOpenViewer } from '../components/useOpenViewer';
import { useNow } from '../components/RunActivity';
import { useRunFrame } from '../components/useRunFrame';
import type { Chat, ChatDraftState, ChatMessage, ChatSettings, ChatStatus, ChatTaskDraft } from '../types/chat';
import { BOTTOM_BAR_HEIGHT, EmptyState, ErrorBanner, SAFE_AREA_BOTTOM, isLive, toast, useConfirm, useKeyboardInset, useProfileTimeZone } from '../ui';

/** How close to the end of the thread counts as "reading the latest" (new messages then keep the view at the end). */
const NEAR_END_PX = 120;
const RAIL_WIDTH = 320;
/** How often the browser's picture is refreshed: in the pane, and in the thread's card. */
const PANE_FRAME_MS = 2_000;
const CARD_FRAME_MS = 5_000;

/** Where a person can take over a run's browser (`GET /runs/:id/viewer`). */
interface RunViewer {
  hostId: string | null;
  hostName: string | null;
  desktop: boolean;
}

/** What `/chat/:id` is opened with when "All chat settings" was chosen on a new chat: the chat is created first, then its settings open. */
interface OpenSettingsState {
  openSettings: true;
}

interface RenameState {
  chat: Pick<Chat, 'id' | 'title'>;
  value: string;
}

/**
 * `/chat`, `/chat/new` and `/chat/:id` (#486): the user's chats and one open
 * thread. From `md` up the list is a rail beside the thread; between `sm` and
 * `md` it is a drawer; on a phone the list and the thread are two screens.
 *
 * A message is sent with `POST /chats/:id/messages`; the answer arrives over
 * the chat's event stream (`useChat`). A new chat is created by its first
 * message.
 */
export function ChatPage() {
  const { api, viewer } = usePlatformHost();
  const navigate = useNavigate();
  const confirm = useConfirm();
  const theme = useTheme();
  const isPhone = useMediaQuery(theme.breakpoints.down('sm'));
  const hasRail = useMediaQuery(theme.breakpoints.up('md'));
  /** From `lg` (1200 px) the browser has a pane of its own beside the thread. */
  const hasSidePane = useMediaQuery(theme.breakpoints.up('lg'));
  const timeZone = useProfileTimeZone();
  // The chat fills <main>: no padding and no frame around it, and the shell (the one owner of the window's height) sizes it.
  useShellMainVariant('full-bleed');
  const keyboardInset = useKeyboardInset();
  const canWrite = viewer.hasPermission('chat:write');

  const params = useParams<{ id?: string }>();
  const chatId = params.id ?? null;
  // `/chat/new` is its own route (no `:id`), and `/` (the home, #713) is the same new-chat screen.
  // `/chat` on a phone is the list alone; elsewhere it shows the new-chat screen beside (or behind) the list.
  const onHome = useMatch({ path: chatPaths.home, end: true }) !== null;
  const onNewRoute = useMatch(chatPaths.new) !== null || onHome;
  const isNew = chatId === null && (onNewRoute || !isPhone);
  const showThread = chatId !== null || isNew;
  const showListScreen = isPhone && !showThread;

  const [status, setStatus] = useState<ChatStatus>('active');
  const list = useChatList(status);
  const state = useChat(chatId);
  const { chat, messages } = state;

  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [drawer, setDrawer] = useState(false);
  const [menu, setMenu] = useState<HTMLElement | null>(null);
  const [rename, setRename] = useState<RenameState | null>(null);
  const [settings, setSettings] = useState(false);
  /** A new chat's policy and machine (#713), chosen in the composer before the chat exists: sent with `POST /chats`. Only what was chosen. */
  const [pending, setPending] = useState<Partial<ChatRunChoice>>({});
  const location = useLocation();
  const inbox = useInboxCount();
  const name = firstName(useOptionalAuth()?.user?.displayName);

  // ---- The browser of the chat's live run (#487) ----
  const run = state.run;
  const liveRun = run && isLive(run.status) ? run : null;
  const guidance = useMemo(() => new Map(state.guidance.map((g) => [g.seq, g.state])), [state.guidance]);
  const liveRunId = liveRun?.id ?? null;
  // Stop was pressed on this run (E38.1): shown at once, before the run's own `cancelRequested` arrives.
  const [stoppingRunId, setStoppingRunId] = useState<string | null>(null);
  // Pause and Resume were pressed on this run (E38.2): "Pausing…" and "Resuming…" at once, until the stream says so.
  const [pausingRunId, setPausingRunId] = useState<string | null>(null);
  const [resumingRunId, setResumingRunId] = useState<string | null>(null);
  const [browserOpen, setBrowserOpen] = useState(false);
  const [cardVisible, setCardVisible] = useState(false);
  const [viewerOf, setViewerOf] = useState<{ runId: string; viewer: RunViewer } | null>(null);
  const paneOpen = browserOpen && liveRun !== null;
  /** The request the live run waits on (#488); answered here, in the thread. */
  const request = liveRun && state.question ? (state.question as Question) : null;
  const requestId = request?.id ?? null;
  /** A secret is being asked for: what is on the screen may show it, so there is no picture. */
  const frameHidden = request?.input === 'secret' || request?.input === 'credentials';
  /** A confirmation shows the page it is about, so its picture is wanted while the request is. */
  const requestWantsFrame = request !== null && (request.input === 'confirm' || request.kind === 'confirmation');
  // One fetch feeds the card and the pane, and only while one of them is on screen.
  const frame = useRunFrame(liveRunId, !frameHidden && (paneOpen || cardVisible || requestWantsFrame), paneOpen ? PANE_FRAME_MS : CARD_FRAME_MS);
  const now = useNow(liveRun !== null);
  // The pane belongs to a live run: it closes when the run ends, and with the chat.
  useEffect(() => {
    if (liveRunId === null) setBrowserOpen(false);
  }, [liveRunId]);
  useEffect(() => {
    setBrowserOpen(false);
    setCardVisible(false);
  }, [chatId]);
  // Where the run's browser can be taken over, asked once the pane is open.
  useEffect(() => {
    if (!paneOpen || !liveRunId || !viewer.hasPermission('fleet:desktop')) return;
    let stale = false;
    api
      .get<RunViewer>(`/runs/${liveRunId}/viewer`)
      .then((v) => {
        if (!stale) setViewerOf({ runId: liveRunId, viewer: v });
      })
      .catch(() => undefined);
    return () => {
      stale = true;
    };
  }, [api, viewer, paneOpen, liveRunId]);
  const where = viewerOf && viewerOf.runId === liveRunId ? viewerOf.viewer : null;
  const takeOver = where?.desktop && where.hostId ? { to: `/fleet/hosts/${where.hostId}/desktop`, label: `Take over${where.hostName ? ` on ${where.hostName}` : ''}` } : null;
  const stopRun = async () => {
    if (!liveRun) return;
    const ok = await confirm({ title: 'Stop this run?', body: 'The agent stops within a few seconds and does nothing more. What it already did is not undone.', confirmLabel: 'Stop', destructive: true });
    if (!ok) return;
    // At once, before the server answers (E38.1): the button says "Stopping…" and cannot be pressed twice.
    setStoppingRunId(liveRun.id);
    try {
      await api.post(`/runs/${liveRun.id}/cancel`, {});
      toast('Stopping the run');
    } catch (e) {
      setStoppingRunId(null);
      toast(e instanceof Error ? e.message : 'Could not stop the run', 'error');
    }
  };
  // The pause took effect (or the run went on some other way): the page's own "Pausing…" is over.
  const liveStatus = liveRun?.status ?? null;
  useEffect(() => {
    if (liveStatus === 'paused' || liveStatus === null) setPausingRunId(null);
  }, [liveStatus]);
  const pauseRun = async () => {
    if (!liveRun) return;
    setPausingRunId(liveRun.id);
    try {
      await api.post(`/runs/${liveRun.id}/pause`, {});
    } catch (e) {
      setPausingRunId(null);
      toast(e instanceof Error ? e.message : 'Could not pause the run', 'error');
    }
  };
  const resumeRun = async () => {
    if (!liveRun) return;
    setResumingRunId(liveRun.id);
    setPausingRunId(null);
    try {
      await api.post(`/runs/${liveRun.id}/resume`, {});
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not resume the run', 'error');
    } finally {
      setResumingRunId(null);
    }
  };
  // ---- The run's request, answered in the thread (#488) ----
  /** What became of the last request seen here: answered in this chat, or closed some other way. */
  const [settled, setSettled] = useState<{ id: string; text: string; tone: 'success' | 'info'; ruleId?: string | null } | null>(null);
  const lastRequest = useRef<string | null>(null);
  useEffect(() => {
    const before = lastRequest.current;
    lastRequest.current = requestId;
    if (requestId !== null) {
      // A new request: what is said about an earlier one makes way for it.
      setSettled((s) => (s && s.id !== requestId ? null : s));
    } else if (before !== null) {
      // It went away without an answer from this page: another device, the Inbox, a cancel or its expiry.
      setSettled((s) => (s && s.id === before ? s : { id: before, text: 'This request was answered elsewhere, cancelled or expired.', tone: 'info' }));
    }
  }, [requestId]);
  useEffect(() => {
    lastRequest.current = null;
    setSettled(null);
  }, [chatId]);
  const [viewerError, setViewerError] = useState<string | null>(null);
  const openViewer = useOpenViewer(setViewerError);
  const answerRequest = async (answer: AnswerBody): Promise<RequestResult> => {
    if (!request) return;
    const q = request;
    let ruleId: string | null = null;
    try {
      if (answer.outcome === 'cancelled') await api.post(`/questions/${q.id}/cancel`, { channel: 'web' });
      else ruleId = (await api.post<Question | undefined>(`/questions/${q.id}/answer`, { ...answer, channel: 'web' }))?.response?.ruleId ?? null;
    } catch (e) {
      // Answered on another device, or expired, in the meantime: that is its final state, not an error.
      if (!isSettledError(e)) throw e;
      setSettled({ id: q.id, text: 'This request was already answered or expired.', tone: 'info' });
      return 'gone';
    }
    // Only what kind of answer it was is kept; never the answer of a secret.
    setSettled({ id: q.id, text: settledText(q, answer), tone: 'success', ruleId });
  };
  const onCardVisible = useCallback((visible: boolean) => setCardVisible(visible), []);
  const openBrowser = useCallback(() => setBrowserOpen(true), []);

  // A different chat: what was typed for the other one does not follow.
  useEffect(() => {
    setDraft('');
    setSendError(null);
    setMenu(null);
  }, [chatId, isNew]);

  // ---- The thread's scroll position: stay at the end while the reader is there. ----
  const scroller = useRef<HTMLDivElement | null>(null);
  const atEnd = useRef(true);
  const [showJump, setShowJump] = useState(false);
  const toEnd = useCallback((smooth = false) => {
    const el = scroller.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
    atEnd.current = true;
    setShowJump(false);
  }, []);
  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    atEnd.current = el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_END_PX;
    if (atEnd.current) setShowJump(false);
  };
  const newest = lastSeq(messages);
  useLayoutEffect(() => {
    // The new-chat screen has no latest message to follow: it starts at its top, so the greeting is never under the header.
    if (isNew) {
      scroller.current?.scrollTo({ top: 0 });
      return;
    }
    if (atEnd.current) toEnd();
    else if (newest > 0) setShowJump(true);
  }, [isNew, newest, state.thinking, requestId, toEnd]);
  // Opening a chat always starts at its end.
  useLayoutEffect(() => {
    atEnd.current = true;
    setShowJump(false);
  }, [chatId]);

  const rows = useMemo(() => threadRows(messages, timeZone), [messages, timeZone]);
  const settledRecorded = settled ? messages.some((m) => m.kind === 'request' && (m.meta as { questionId?: unknown } | null)?.questionId === settled.id) : false;
  const readOnly = chat?.status === 'archived';
  const mayType = canWrite && !readOnly;
  /** The suggested answers of the newest message can be tapped, while nothing is being sent. */
  const answerableSeq = mayType && !sending && messages.length > 0 ? newest : null;

  const send = async (text: string) => {
    const body = text.trim();
    if (!body || sending) return;
    setSending(true);
    setSendError(null);
    try {
      if (chatId === null) {
        // A new chat is created by its first message; its title comes from it.
        const created = await api.post<Chat>('/chats', pending);
        await api.post(`/chats/${created.id}/messages`, { text: body });
        setDraft('');
        setPending({});
        void list.reload();
        navigate(chatPaths.chat(created.id));
      } else {
        atEnd.current = true;
        await state.send(body);
        setDraft('');
        void list.reload();
      }
    } catch (e) {
      setSendError(e instanceof Error ? e.message : 'Could not send the message');
    } finally {
      setSending(false);
    }
  };

  // ---- Rename, archive, delete: the same actions from the list's menu and the header's. ----
  const changed = (next: Chat) => {
    if (next.id === chatId) state.patch(next);
    void list.reload();
  };
  const setArchived = async (target: Pick<Chat, 'id'>, archived: boolean) => {
    try {
      changed(await api.patch<Chat>(`/chats/${target.id}`, { status: archived ? 'archived' : 'active' }));
      toast(archived ? 'Chat archived' : 'Chat unarchived');
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not change the chat', 'error');
    }
  };
  const remove = async (target: Pick<Chat, 'id' | 'title'>) => {
    const ok = await confirm({ title: 'Delete this chat?', body: `"${chatTitle(target)}", its messages and its runs are deleted. This cannot be undone.`, confirmLabel: 'Delete', destructive: true });
    if (!ok) return;
    try {
      await api.delete(`/chats/${target.id}`);
      toast('Chat deleted');
      void list.reload();
      if (target.id === chatId) navigate(isPhone ? chatPaths.list : chatPaths.new, { replace: true });
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not delete the chat', 'error');
    }
  };
  const saveRename = async () => {
    if (!rename) return;
    const title = rename.value.trim();
    if (!title) return;
    try {
      changed(await api.patch<Chat>(`/chats/${rename.chat.id}`, { title }));
      setRename(null);
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not rename the chat', 'error');
    }
  };
  const onAction = (action: ChatRowAction, target: Pick<Chat, 'id' | 'title'>) => {
    if (action === 'rename') setRename({ chat: target, value: target.title });
    else if (action === 'archive') void setArchived(target, true);
    else if (action === 'unarchive') void setArchived(target, false);
    else void remove(target);
  };
  // ---- The composer's options (#713): the policy and the machine, and the way to every setting. ----
  const choice: ChatRunChoice = chat && chatId !== null ? { policyId: chat.policyId, hostId: chat.hostId, hostFallback: chat.hostFallback } : { policyId: pending.policyId ?? null, hostId: pending.hostId ?? null, hostFallback: pending.hostFallback ?? true };
  const changeChoice = async (change: Partial<ChatRunChoice>) => {
    if (chatId === null || !chat) {
      // Not saved anywhere yet: it goes with the request that creates the chat.
      setPending((p) => ({ ...p, ...change }));
      return;
    }
    try {
      changed(await api.patch<Chat>(`/chats/${chat.id}`, change));
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not change the chat', 'error');
    }
  };
  /** Every setting: a new chat is created first (with what was chosen), then its settings open. */
  const openSettings = async () => {
    if (chatId !== null) {
      setSettings(true);
      return;
    }
    try {
      const created = await api.post<Chat>('/chats', pending);
      setPending({});
      void list.reload();
      navigate(chatPaths.chat(created.id), { state: { openSettings: true } satisfies OpenSettingsState });
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not open the settings', 'error');
    }
  };
  // Arrived from a new chat's "All chat settings": open them once the chat is here, and only once.
  const wantsSettings = (location.state as Partial<OpenSettingsState> | null)?.openSettings === true;
  useEffect(() => {
    if (!wantsSettings || !chat || chat.id !== chatId) return;
    setSettings(true);
    navigate(location.pathname, { replace: true, state: null });
  }, [wantsSettings, chat, chatId, navigate, location.pathname]);

  const saveSettings = async (next: ChatSettings) => {
    if (!chat) return;
    changed(await api.patch<Chat>(`/chats/${chat.id}`, next));
    toast('Chat settings saved');
  };

  /** "Run again" on a result: ask for the same job once more, in words the assistant acts on. */
  const runAgain = async (result: ChatMessage) => {
    const started = [...messages].reverse().find((m) => m.kind === 'run' && m.seq < result.seq && (result.runId === null || m.runId === result.runId || m.runId === null));
    // A run that carried out a step the owner confirmed asks first (#540); the words then tell the assistant the owner knows.
    const count = Number((result.meta as { confirmedActions?: unknown } | null)?.confirmedActions ?? 0);
    const question = runAgainQuestion(count, confirmedPromptOf(result.text));
    if (question) {
      if (!(await confirm(question))) return;
      void send(started ? `Run this again, knowing the step I confirmed was already carried out: ${started.text}` : 'Run that again, knowing the step I confirmed was already carried out.');
      return;
    }
    void send(started ? `Run this again: ${started.text}` : 'Run that again.');
  };
  // ---- Save the chat as a task (#489): the AI drafts it, the owner reviews it in the task form. ----
  const canSaveTask = viewer.hasPermission('tasks:write') && chatId !== null;
  const [savingTask, setSavingTask] = useState(false);
  /** The draft travels in the router's state, never in the URL. */
  const reviewDraft = (draft: ChatTaskDraft) => {
    if (chatId) navigate('/tasks/new', { state: { chatDraft: draft, chatId } satisfies ChatDraftState });
  };
  const saveAsTask = async () => {
    if (!chatId || savingTask) return;
    setSavingTask(true);
    try {
      reviewDraft(await api.post<ChatTaskDraft>(`/chats/${chatId}/task-draft`, {}));
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not draft the task', 'error');
    } finally {
      setSavingTask(false);
    }
  };
  const cards: ThreadCards = {
    run,
    guidance,
    frame,
    frameHidden,
    now,
    paneOpen,
    onOpenBrowser: openBrowser,
    onCardVisible,
    onResumeRun: viewer.hasPermission('runs:write') ? () => void resumeRun() : undefined,
    onRunAgain: mayType && !sending && liveRun === null ? runAgain : undefined,
    onSaveAsTask: canSaveTask ? () => void saveAsTask() : undefined,
    savingTask,
    onReviewDraft: canSaveTask ? reviewDraft : undefined,
  };

  const listPanel = <ChatList list={list} status={status} onStatus={setStatus} selectedId={chatId} canWrite={canWrite} onAction={onAction} onNavigate={() => setDrawer(false)} />;

  // ---- The thread column ----
  const subtitle = chatSubtitle({ chat, thinking: state.thinking, run: state.run });
  let body: ReactNode;
  if (isNew) {
    body = canWrite ? (
      // `my: auto` centres it while there is room and starts it at the top when there is not: nothing is ever cut off.
      <Stack spacing={1.5} sx={{ alignItems: 'center', textAlign: 'center', my: 'auto', py: { xs: 2, sm: 3 } }}>
        <Typography color="text.secondary" component="p" data-testid="chat-greeting">
          {greeting(new Date(), timeZone)}
          {name ? `, ${name}` : ''}
        </Typography>
        <Typography variant="h4" component="h1" sx={{ fontWeight: 600, mt: '4px !important', fontSize: { xs: '1.6rem', sm: '2rem' } }}>
          What should I do?
        </Typography>
        <Typography color="text.secondary" sx={{ maxWidth: 480 }}>
          Say what you want done on the web. I ask if something is unclear, then do it in a real browser and show you the result here.
        </Typography>
        <Stack spacing={1} sx={{ width: '100%', maxWidth: 560, pt: 1 }} role="group" aria-label="Examples">
          {EXAMPLE_PROMPTS.map((prompt) => (
            <Chip key={prompt} label={prompt} variant="outlined" onClick={() => setDraft(prompt)} sx={{ height: 'auto', minHeight: 44, justifyContent: 'flex-start', borderRadius: '12px', borderColor: 'divider', bgcolor: 'background.paper', color: 'text.secondary', '&:hover': { color: 'text.primary' }, '& .MuiChip-label': { whiteSpace: 'normal', textAlign: 'left', py: 1, px: 1.5 } }} />
          ))}
        </Stack>
        {inbox.count > 0 && (
          <Button component={RouterLink} to="/inbox" startIcon={<InboxOutlinedIcon />} color="warning" sx={{ minHeight: 44 }} data-testid="chat-needs-you">
            {inbox.count === 1 ? '1 request needs you' : `${inbox.count} requests need you`}
          </Button>
        )}
      </Stack>
    ) : (
      <EmptyState Icon={ChatBubbleOutlineIcon} title="Choose a chat" body="You can read your chats. Starting one needs the permission to write chats." />
    );
  } else if (state.notFound) {
    body = <EmptyState Icon={ChatBubbleOutlineIcon} title="This chat does not exist" body="It may have been deleted." action={{ key: 'new', label: 'Start a new chat', to: chatPaths.new }} />;
  } else if (state.loading) {
    body = (
      <Box sx={{ display: 'flex', justifyContent: 'center', py: 6 }}>
        <CircularProgress aria-label="Loading the chat" />
      </Box>
    );
  } else {
    body = (
      <>
        {messages.length === 0 && !state.thinking && <EmptyState title="No messages yet" body={mayType ? 'Say what you want done.' : undefined} />}
        <ThreadRows rows={rows} answerableSeq={answerableSeq} onAnswer={(text) => void send(text)} cards={cards} />
        {viewerError && (
          <Alert severity="error" onClose={() => setViewerError(null)} sx={{ my: 1 }}>
            {viewerError}
          </Alert>
        )}
        {request && settled?.id !== request.id ? (
          <ChatRequestCard
            key={request.id}
            question={request}
            now={now}
            canAnswer={viewer.hasPermission('runs:write')}
            onAnswer={answerRequest}
            frame={requestWantsFrame ? frame : undefined}
            onReview={paneOpen ? undefined : openBrowser}
            onOpenBrowser={request.viewerUrl ? () => void openViewer(request.viewerUrl!) : undefined}
          />
        ) : (
          // The thread keeps a record of the request (E40.1); this line stays only when it adds something: a saved approval to see, or no record.
          settled && (settledRecorded === false || settled.ruleId) && <RequestSettled text={settled.text} tone={settled.tone} ruleId={settled.ruleId} />
        )}
        {state.thinking && <TypingIndicator />}
      </>
    );
  }

  const browserPane = paneOpen && liveRun && (
    <BrowserPane run={stoppingRunId === liveRun.id && !liveRun.cancelRequested ? { ...liveRun, cancelRequested: true } : liveRun} frame={frame} frameHidden={frameHidden} now={now} canStop={viewer.hasPermission('runs:write')} onStop={() => void stopRun()} onPause={() => void pauseRun()} onResume={() => void resumeRun()} pausing={pausingRunId === liveRun.id} resuming={resumingRunId === liveRun.id} takeOver={takeOver} onClose={() => setBrowserOpen(false)} />
  );

  const thread = (
    <Box component="section" aria-label={isNew ? 'New chat' : chatTitle(chat)} sx={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <Stack direction="row" spacing={0.5} sx={{ alignItems: 'center', px: { xs: 0.5, sm: 1 }, py: 0.25, minHeight: 52, borderBottom: isNew ? 0 : 1, borderColor: 'divider', flex: 'none' }}>
        {isPhone ? (
          isNew ? (
            // The new-chat screen is the home on a phone (#713): its chats are one tap away, as in a chat app.
            <IconButton component={RouterLink} to={chatPaths.list} aria-label="Your chats" sx={{ width: 44, height: 44 }}>
              <MenuIcon />
            </IconButton>
          ) : (
            <IconButton component={RouterLink} to={chatPaths.list} aria-label="Back to chats" sx={{ width: 44, height: 44 }}>
              <ArrowBackIcon />
            </IconButton>
          )
        ) : (
          !hasRail && (
            <IconButton aria-label="Show chats" onClick={() => setDrawer(true)} sx={{ width: 44, height: 44 }}>
              <MenuIcon />
            </IconButton>
          )
        )}
        <Box sx={{ flex: 1, minWidth: 0, px: 1 }}>
          <Typography variant="subtitle1" component={isNew ? 'p' : 'h1'} noWrap sx={{ fontWeight: 600, lineHeight: 1.3 }}>
            {isNew ? 'New chat' : state.notFound ? 'Chat' : chatTitle(chat)}
          </Typography>
          {subtitle && (
            <Typography variant="caption" color="text.secondary" noWrap component="p" aria-live="polite">
              {subtitle}
            </Typography>
          )}
        </Box>
        {!isNew && !hasRail && canWrite && (
          <IconButton component={RouterLink} to={chatPaths.new} aria-label="New chat" sx={{ width: 44, height: 44 }}>
            <AddCommentIcon />
          </IconButton>
        )}
        {chat && canWrite && (
          <IconButton aria-label="Chat actions" aria-haspopup="menu" onClick={(e) => setMenu(e.currentTarget)} sx={{ width: 44, height: 44 }}>
            <MoreVertIcon />
          </IconButton>
        )}
      </Stack>

      {/* A tablet: the browser is a panel above the thread, which keeps the rest of the height. */}
      {browserPane && !hasSidePane && !isPhone && <Box sx={{ flex: 'none', height: '48%', minHeight: 260, borderBottom: 1, borderColor: 'divider' }}>{browserPane}</Box>}

      <Box sx={{ position: 'relative', flex: 1, minHeight: 0 }}>
        <Box ref={scroller} onScroll={onScroll} role="log" aria-label="Messages" aria-live="polite" sx={{ position: 'absolute', inset: 0, overflowY: 'auto', overscrollBehavior: 'contain', scrollbarWidth: 'thin', px: { xs: 1.5, sm: 3 }, py: 1.5 }}>
          <Box sx={{ maxWidth: 820, mx: 'auto', minHeight: '100%', display: 'flex', flexDirection: 'column' }}>
            {state.error && <ErrorBanner error={state.error} />}
            {body}
          </Box>
        </Box>
        {showJump && (
          <Fab size="small" color="primary" aria-label="Jump to latest" onClick={() => toEnd(true)} sx={{ position: 'absolute', right: 16, bottom: 12 }}>
            <KeyboardArrowDownIcon />
          </Fab>
        )}
      </Box>

      {(isNew || (chat && !state.notFound)) && (
        <Box sx={{ flex: 'none', px: { xs: 1.5, sm: 3 }, pt: 1, pb: { xs: 1, sm: 2 } }}>
          <Box sx={{ maxWidth: 820, mx: 'auto' }}>
            {sendError && (
              <Alert severity="error" onClose={() => setSendError(null)} sx={{ mb: 1 }}>
                {sendError}
              </Alert>
            )}
            {readOnly ? (
              <Alert severity="info" action={canWrite && chat ? <Button color="inherit" size="small" onClick={() => void setArchived(chat, false)}>Unarchive</Button> : undefined}>
                This chat is archived. It is read-only.
              </Alert>
            ) : (
              canWrite && (
                <>
                  <ChatComposer value={draft} onChange={setDraft} onSend={() => void send(draft)} busy={sending} enterSends={!isPhone} autoFocus={!isPhone} placeholder={isNew ? 'Ask Hexactra to do something' : liveRun ? 'Add something for the agent' : 'Message'}
                    options={<ChatOptions {...choice} profile={chat && chatId !== null ? chat.profile : undefined} onChange={(change) => void changeChoice(change)} onOpenSettings={() => void openSettings()} />}
                  />
                </>
              )
            )}
          </Box>
        </Box>
      )}
    </Box>
  );

  // What a keyboard that overlays the page covers (0 when the browser resizes the page for it); on a phone the bottom bar already holds 56 px of it.
  const keyboardPad = Math.max(0, keyboardInset - (isPhone ? BOTTOM_BAR_HEIGHT : 0));
  return (
    <Box
      sx={{
        display: 'flex',
        flexDirection: 'column',
        // Fills <main> and never grows it: the shell's height is the window's (`100dvh`), so the window never scrolls and only the thread does.
        flex: '1 1 0',
        minHeight: 0,
        minWidth: 0,
        overflow: 'hidden',
        // <main> keeps 24 px of padding under a full-bleed page; the chat takes it back. On a phone the rest of that padding clears the bottom bar.
        mb: -3,
        pb: keyboardPad > 0 ? `${keyboardPad}px` : { xs: SAFE_AREA_BOTTOM, sm: 0 },
        bgcolor: 'background.default',
      }}
    >
      <Box sx={{ flex: 'none', px: { xs: 2, sm: 3 }, pt: 2, '&:empty': { display: 'none' } }}>
        <ShellBanners />
      </Box>
      <Box sx={{ display: 'flex', flex: '1 1 0', minHeight: 0, minWidth: 0 }}>
      {hasRail && <Box sx={{ width: RAIL_WIDTH, flex: 'none', borderRight: 1, borderColor: 'divider', minHeight: 0 }}>{listPanel}</Box>}
      {showListScreen ? <Box sx={{ flex: 1, minWidth: 0, minHeight: 0 }}>{listPanel}</Box> : thread}
      {/* A wide window: the browser beside the thread. */}
      {browserPane && hasSidePane && !showListScreen && <Box sx={{ flex: '0 0 46%', minWidth: 0, maxWidth: 760, borderLeft: 1, borderColor: 'divider', minHeight: 0 }}>{browserPane}</Box>}
      </Box>
      {/* A phone: the browser takes the screen. */}
      <Dialog fullScreen open={Boolean(browserPane) && isPhone} onClose={() => setBrowserOpen(false)} slotProps={{ paper: { 'aria-label': 'Browser' } }}>
        {isPhone && browserPane}
      </Dialog>

      {!hasRail && !isPhone && (
        <Drawer open={drawer} onClose={() => setDrawer(false)} slotProps={{ paper: { sx: { width: RAIL_WIDTH, maxWidth: '85vw' } } }}>
          {listPanel}
        </Drawer>
      )}

      <Menu anchorEl={menu} open={menu !== null} onClose={() => setMenu(null)}>
        <MenuItem
          onClick={() => {
            setMenu(null);
            if (chat) setRename({ chat, value: chat.title });
          }}
        >
          Rename
        </MenuItem>
        <MenuItem
          onClick={() => {
            setMenu(null);
            setSettings(true);
          }}
        >
          Chat settings
        </MenuItem>
        <MenuItem
          onClick={() => {
            setMenu(null);
            if (chat) void setArchived(chat, !readOnly);
          }}
        >
          {readOnly ? 'Unarchive' : 'Archive'}
        </MenuItem>
        <MenuItem
          sx={{ color: 'error.main' }}
          onClick={() => {
            setMenu(null);
            if (chat) void remove(chat);
          }}
        >
          Delete
        </MenuItem>
      </Menu>

      <Dialog open={rename !== null} onClose={() => setRename(null)} fullWidth maxWidth="xs" aria-labelledby="chat-rename-title">
        <DialogTitle id="chat-rename-title">Rename chat</DialogTitle>
        <DialogContent>
          <TextField
            autoFocus
            fullWidth
            label="Name"
            margin="dense"
            value={rename?.value ?? ''}
            onChange={(e) => setRename((r) => (r ? { ...r, value: e.target.value } : r))}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void saveRename();
            }}
            slotProps={{ htmlInput: { maxLength: 200 } }}
          />
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2 }}>
          <Button onClick={() => setRename(null)} sx={{ minHeight: { xs: 44, sm: 'auto' } }}>
            Cancel
          </Button>
          <Button variant="contained" onClick={() => void saveRename()} disabled={!rename?.value.trim()} sx={{ minHeight: { xs: 44, sm: 'auto' } }}>
            Save
          </Button>
        </DialogActions>
      </Dialog>

      {chat && <ChatSettingsDialog open={settings} chat={chat} onClose={() => setSettings(false)} onSave={saveSettings} />}
    </Box>
  );
}
