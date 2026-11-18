import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import ChatBubbleOutlineIcon from '@mui/icons-material/ChatBubbleOutlineOutlined';
import KeyboardArrowDownIcon from '@mui/icons-material/KeyboardArrowDown';
import MenuIcon from '@mui/icons-material/Menu';
import MoreVertIcon from '@mui/icons-material/MoreVert';
import { Alert, Box, Button, Chip, CircularProgress, Dialog, DialogActions, DialogContent, DialogTitle, Drawer, Fab, IconButton, Menu, MenuItem, Stack, TextField, Typography, useMediaQuery } from '@mui/material';
import { useTheme } from '@mui/material/styles';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link as RouterLink, useMatch, useNavigate, useParams } from 'react-router-dom';
import { usePlatformHost } from '@marinoscar/platform-web/core';

import { BrowserPane, confirmedPromptOf } from '../components/ChatBrowser';
import { runAgainQuestion } from '../components/runRow';
import { ChatComposer } from '../components/ChatComposer';
import { ChatRequestCard, RequestSettled, settledText, type RequestResult } from '../components/ChatRequest';
import { ChatList, type ChatRowAction } from '../components/ChatList';
import { ThreadRows, TypingIndicator, type ThreadCards } from '../components/ChatMessages';
import { ChatSettingsDialog } from '../components/ChatSettingsDialog';
import { EXAMPLE_PROMPTS, chatPaths, chatSubtitle, chatTitle, lastSeq, threadRows } from '../components/chatThread';
import { useChat } from '../components/useChat';
import { useChatList } from '../components/useChatList';
import { isSettledError, type AnswerBody, type Question } from '../components/questions';
import { useOpenViewer } from '../components/useOpenViewer';
import { useNow } from '../components/RunActivity';
import { useRunFrame } from '../components/useRunFrame';
import type { Chat, ChatDraftState, ChatMessage, ChatSettings, ChatStatus, ChatTaskDraft } from '../types/chat';
import { EmptyState, ErrorBanner, SAFE_AREA_BOTTOM, isLive, toast, useConfirm, useProfileTimeZone } from '../ui';

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

/** How far into the shell's own padding the chat reaches on a phone, top and bottom, so it does not float in a frame. */
const PHONE_BLEED = 16;

/**
 * Where the chat sits in the window, measured: the page's top edge (the
 * shell's bar and any banner above the page vary) and the padding the shell
 * keeps under every page (on a phone that padding is also what clears the
 * bottom navigation bar). The chat fills what is between them, so the window
 * itself never scrolls and only the thread does.
 */
function useFillHeight(): { ref: (el: HTMLDivElement | null) => void; top: number; bottom: number } {
  const [box, setBox] = useState({ top: 64, bottom: 24 });
  const node = useRef<HTMLDivElement | null>(null);
  const measure = useCallback(() => {
    const el = node.current;
    if (!el) return;
    // Rounded up: a fraction of a pixel too tall would make the window scroll.
    const top = Math.max(0, Math.ceil(el.getBoundingClientRect().top + window.scrollY));
    const main = el.closest('main');
    const bottom = main ? Math.ceil(parseFloat(getComputedStyle(main).paddingBottom) || 0) : 0;
    setBox((prev) => (prev.top === top && prev.bottom === bottom ? prev : { top, bottom }));
  }, []);
  useLayoutEffect(() => {
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  });
  const ref = useCallback(
    (el: HTMLDivElement | null) => {
      node.current = el;
      measure();
    },
    [measure],
  );
  return { ref, ...box };
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
  const canWrite = viewer.hasPermission('chat:write');

  const params = useParams<{ id?: string }>();
  const chatId = params.id ?? null;
  // `/chat/new` is its own route (no `:id`). `/chat` on a phone is the list alone; elsewhere it shows the new-chat screen beside (or behind) the list.
  const onNewRoute = useMatch(chatPaths.new) !== null;
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

  // ---- The browser of the chat's live run (#487) ----
  const run = state.run;
  const liveRun = run && isLive(run.status) ? run : null;
  const guidance = useMemo(() => new Map(state.guidance.map((g) => [g.seq, g.state])), [state.guidance]);
  const liveRunId = liveRun?.id ?? null;
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
    const ok = await confirm({ title: 'Stop this run?', body: 'The agent stops after its current step. What it already did is not undone.', confirmLabel: 'Stop', destructive: true });
    if (!ok) return;
    try {
      await api.post(`/runs/${liveRun.id}/cancel`, {});
      toast('Stopping the run');
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not stop the run', 'error');
    }
  };
  // ---- The run's request, answered in the thread (#488) ----
  /** What became of the last request seen here: answered in this chat, or closed some other way. */
  const [settled, setSettled] = useState<{ id: string; text: string; tone: 'success' | 'info' } | null>(null);
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
    try {
      if (answer.outcome === 'cancelled') await api.post(`/questions/${q.id}/cancel`, { channel: 'web' });
      else await api.post(`/questions/${q.id}/answer`, { ...answer, channel: 'web' });
    } catch (e) {
      // Answered on another device, or expired, in the meantime: that is its final state, not an error.
      if (!isSettledError(e)) throw e;
      setSettled({ id: q.id, text: 'This request was already answered or expired.', tone: 'info' });
      return 'gone';
    }
    // Only what kind of answer it was is kept; never the answer of a secret.
    setSettled({ id: q.id, text: settledText(q, answer), tone: 'success' });
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
    if (atEnd.current) toEnd();
    else if (newest > 0) setShowJump(true);
  }, [newest, state.thinking, requestId, toEnd]);
  // Opening a chat always starts at its end.
  useLayoutEffect(() => {
    atEnd.current = true;
    setShowJump(false);
  }, [chatId]);

  const rows = useMemo(() => threadRows(messages, timeZone), [messages, timeZone]);
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
        const created = await api.post<Chat>('/chats', {});
        await api.post(`/chats/${created.id}/messages`, { text: body });
        setDraft('');
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
    onRunAgain: mayType && !sending && liveRun === null ? runAgain : undefined,
    onSaveAsTask: canSaveTask ? () => void saveAsTask() : undefined,
    savingTask,
    onReviewDraft: canSaveTask ? reviewDraft : undefined,
  };

  const fill = useFillHeight();
  const listPanel = <ChatList list={list} status={status} onStatus={setStatus} selectedId={chatId} canWrite={canWrite} onAction={onAction} onNavigate={() => setDrawer(false)} />;

  // ---- The thread column ----
  const subtitle = chatSubtitle({ chat, thinking: state.thinking, run: state.run });
  let body: ReactNode;
  if (isNew) {
    body = canWrite ? (
      <Stack spacing={2} sx={{ alignItems: 'center', justifyContent: 'center', minHeight: '100%', textAlign: 'center', py: 3 }}>
        <ChatBubbleOutlineIcon aria-hidden sx={{ fontSize: 48, color: 'text.secondary', opacity: 0.7 }} />
        <Typography variant="h5" component="h1">
          What should I do?
        </Typography>
        <Typography color="text.secondary" sx={{ maxWidth: 480 }}>
          Say what you want done on the web. I ask if something is unclear, then do it in a real browser and show you the result here.
        </Typography>
        <Stack spacing={1} sx={{ width: '100%', maxWidth: 560, pt: 1 }} role="group" aria-label="Examples">
          {EXAMPLE_PROMPTS.map((prompt) => (
            <Chip key={prompt} label={prompt} variant="outlined" onClick={() => setDraft(prompt)} sx={{ height: 'auto', minHeight: 44, justifyContent: 'flex-start', borderRadius: 3, '& .MuiChip-label': { whiteSpace: 'normal', textAlign: 'left', py: 1 } }} />
          ))}
        </Stack>
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
          settled && <RequestSettled text={settled.text} tone={settled.tone} />
        )}
        {state.thinking && <TypingIndicator />}
      </>
    );
  }

  const browserPane = paneOpen && liveRun && (
    <BrowserPane run={liveRun} frame={frame} frameHidden={frameHidden} now={now} canStop={viewer.hasPermission('runs:write')} onStop={() => void stopRun()} takeOver={takeOver} onClose={() => setBrowserOpen(false)} />
  );

  const thread = (
    <Box component="section" aria-label={isNew ? 'New chat' : chatTitle(chat)} sx={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <Stack direction="row" spacing={0.5} sx={{ alignItems: 'center', px: { xs: 0.5, sm: 1 }, py: 0.5, minHeight: 56, borderBottom: 1, borderColor: 'divider', flex: 'none' }}>
        {isPhone ? (
          <IconButton component={RouterLink} to={chatPaths.list} aria-label="Back to chats" sx={{ width: 44, height: 44 }}>
            <ArrowBackIcon />
          </IconButton>
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
        {chat && canWrite && (
          <IconButton aria-label="Chat actions" aria-haspopup="menu" onClick={(e) => setMenu(e.currentTarget)} sx={{ width: 44, height: 44 }}>
            <MoreVertIcon />
          </IconButton>
        )}
      </Stack>

      {/* A tablet: the browser is a panel above the thread, which keeps the rest of the height. */}
      {browserPane && !hasSidePane && !isPhone && <Box sx={{ flex: 'none', height: '48%', minHeight: 260, borderBottom: 1, borderColor: 'divider' }}>{browserPane}</Box>}

      <Box sx={{ position: 'relative', flex: 1, minHeight: 0 }}>
        <Box ref={scroller} onScroll={onScroll} role="log" aria-label="Messages" aria-live="polite" sx={{ position: 'absolute', inset: 0, overflowY: 'auto', overscrollBehavior: 'contain', px: { xs: 1.5, sm: 3 }, py: 1.5 }}>
          <Box sx={{ maxWidth: 820, mx: 'auto', minHeight: '100%' }}>
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
              canWrite && <ChatComposer value={draft} onChange={setDraft} onSend={() => void send(draft)} busy={sending} enterSends={!isPhone} autoFocus={!isPhone} placeholder={isNew ? 'What should I do?' : liveRun ? 'Add something for the agent' : 'Message'} />
            )}
          </Box>
        </Box>
      )}
    </Box>
  );

  return (
    <Box
      ref={fill.ref}
      sx={{
        display: 'flex',
        // The shell pads every page 24 px on each side; on a phone the chat goes edge to edge and reaches into the top and bottom padding.
        mx: { xs: -3, sm: 0 },
        mt: { xs: `-${PHONE_BLEED}px`, sm: 0 },
        mb: { xs: `-${PHONE_BLEED}px`, sm: 0 },
        // `dvh` follows the visible viewport, so the composer stays above an Android or iOS keyboard.
        height: { xs: `calc(100dvh - ${fill.top}px - ${Math.max(0, fill.bottom - PHONE_BLEED)}px - ${SAFE_AREA_BOTTOM})`, sm: `calc(100dvh - ${fill.top}px - ${fill.bottom}px)` },
        minHeight: 320,
        bgcolor: 'background.default',
        border: { xs: 0, sm: 1 },
        borderColor: { sm: 'divider' },
        borderRadius: { xs: 0, sm: 2 },
        overflow: 'hidden',
      }}
    >
      {hasRail && <Box sx={{ width: RAIL_WIDTH, flex: 'none', borderRight: 1, borderColor: 'divider', minHeight: 0 }}>{listPanel}</Box>}
      {showListScreen ? <Box sx={{ flex: 1, minWidth: 0, minHeight: 0 }}>{listPanel}</Box> : thread}
      {/* A wide window: the browser beside the thread. */}
      {browserPane && hasSidePane && !showListScreen && <Box sx={{ flex: '0 0 46%', minWidth: 0, maxWidth: 760, borderLeft: 1, borderColor: 'divider', minHeight: 0 }}>{browserPane}</Box>}
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
