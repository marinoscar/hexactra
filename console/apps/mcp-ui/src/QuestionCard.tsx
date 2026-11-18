// The question card (#467): what the user's agents are waiting for, each as
// the typed form the console inbox shows, answered with one tap in the chat.
// Opened by inbox_list (the list, each question expandable), ask_human and
// question_status (one question). Answers go through question_card_answer
// (channel `mcp-app`); a code, a password, a high-risk approval or a takeover
// opens Hexactra instead. The list refreshes through inbox_list every 15 s
// while it is visible and something is pending. Text only: no prompt or
// label is ever rendered as HTML.
import type { RuleAnswer } from '@app/shared/question-rules';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { KIND_LABEL, QUESTION_CARD_TOOLS, REFRESH_MS, questionResultOf, type QuestionCardTool, type QuestionResult } from './question-model';
import { sendAnswer, settledOf, tellConversation } from './shared/answer';
import type { HostBridge, HostContextLike } from './shared/bridge';
import { IntervalPoller, pageVisible, type IntervalOptions, type IntervalStatus } from './shared/interval';
import { COUNTDOWN_BELOW_S, askerText, secondsLeft, type CardQuestion } from './shared/question';
import { QuestionForm } from './shared/QuestionForm';
import { holds } from './shared/scopes';
import { Supersession, type ChannelFactory } from './shared/supersede';
import { consolePage, formatDuration, safeUrl, structured, type ToolResultLike } from './shared/text';
import { frameOf } from './shared/theme';

export { QUESTION_CARD_TOOLS };

type ItemState =
  | { kind: 'pending'; error?: string | null }
  | { kind: 'sending' }
  | { kind: 'sent'; label: string; declined: boolean; told: boolean }
  | { kind: 'already'; label: string }
  | { kind: 'declined' }
  | { kind: 'expired' }
  | { kind: 'gone' };

interface Item {
  q: CardQuestion;
  state: ItemState;
}

export interface QuestionCardProps {
  host: HostBridge<QuestionCardTool>;
  /** Test seams: timers, the clock, the BroadcastChannel and Page Visibility. */
  pollOptions?: Partial<IntervalOptions>;
  now?: () => number;
  channelFactory?: ChannelFactory;
  isVisible?: () => boolean;
}

function settledText(s: ItemState): string | null {
  switch (s.kind) {
    case 'sent':
      return s.declined ? 'Sent: you declined.' : `Sent: ${s.label}`;
    case 'already':
      return `Answered on another device: ${s.label}`;
    case 'declined':
      return 'Declined on another device.';
    case 'expired':
      return 'This question expired.';
    case 'gone':
      return 'No longer waiting: it was answered elsewhere or expired.';
    default:
      return null;
  }
}

const isOpen = (s: ItemState) => s.kind === 'pending' || s.kind === 'sending';

export function QuestionCard({ host, pollOptions, now: nowFn, channelFactory, isVisible }: QuestionCardProps) {
  const clock = nowFn ?? Date.now;
  const [items, setItems] = useState<Item[] | null>(null);
  const [meta, setMeta] = useState<Pick<QuestionResult, 'appUrl' | 'scopes' | 'source'>>({ scopes: null, source: 'list' });
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [status, setStatus] = useState<IntervalStatus>('live');
  const [superseded, setSuperseded] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [ctx, setCtx] = useState<HostContextLike | undefined>(() => host.hostContext());
  const [now, setNow] = useState(() => clock());
  const itemsRef = useRef<Item[]>([]);
  const metaRef = useRef(meta);
  const poller = useRef<IntervalPoller | null>(null);
  const election = useRef<Supersession | null>(null);
  const visible = useCallback(() => (isVisible ? isVisible() : pageVisible()), [isVisible]);
  const instanceId = useMemo(() => String(host.hostContext()?.toolInfo?.id ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`), [host]);

  const commit = useCallback((next: Item[]) => {
    itemsRef.current = next;
    setItems(next);
  }, []);

  const patch = useCallback(
    (id: string, state: ItemState) => {
      commit(itemsRef.current.map((it) => (it.q.id === id ? { ...it, state } : it)));
    },
    [commit],
  );

  /** One refresh: inbox_list, then question_status for a question that left the list. Answers whether anything is still pending. */
  const refresh = useCallback(async (): Promise<boolean> => {
    const r = questionResultOf(await host.callTool('inbox_list', {}));
    if (!r) throw new Error('inbox_list answered nothing');
    const listed = new Map(r.questions.map((q) => [q.id, q]));
    let next = itemsRef.current.map((it) => (isOpen(it.state) && listed.has(it.q.id) ? { ...it, q: { ...it.q, ...listed.get(it.q.id)! } } : it));
    // Questions that left the inbox while open here: their final state (at most three per refresh).
    const left = next.filter((it) => it.state.kind === 'pending' && !listed.has(it.q.id)).slice(0, 3);
    for (const it of left) {
      let state: ItemState = { kind: 'gone' };
      try {
        const s = await host.callTool('question_status', { question_id: it.q.id });
        state = (!s.isError && settledOf(it.q, structured(s))) || state;
      } catch {
        // keep "No longer waiting"
      }
      next = next.map((x) => (x.q.id === it.q.id ? { ...x, state } : x));
    }
    if (metaRef.current.source === 'list') {
      const known = new Set(next.map((it) => it.q.id));
      next = [...next, ...r.questions.filter((q) => !known.has(q.id)).map((q) => ({ q, state: { kind: 'pending' } as ItemState }))];
    }
    commit(next);
    if (r.scopes) {
      metaRef.current = { ...metaRef.current, scopes: r.scopes };
      setMeta(metaRef.current);
    }
    return next.some((it) => it.state.kind === 'pending');
  }, [host, commit]);

  useEffect(() => {
    host.onToolInput(() => undefined);
    host.onHostContextChanged((c) => setCtx((prev) => ({ ...prev, ...c })));
    host.onToolResult((raw: ToolResultLike) => {
      const r = questionResultOf(raw);
      if (!r) return;
      metaRef.current = { appUrl: r.appUrl ?? metaRef.current.appUrl, scopes: r.scopes ?? metaRef.current.scopes, source: r.source };
      setMeta(metaRef.current);
      const single = r.source === 'single' ? r : null;
      const settled = single && single.status && single.status !== 'pending' ? settledOf(single.questions[0]!, single.raw) : null;
      commit(r.questions.map((q) => ({ q, state: settled ?? { kind: 'pending' } })));
      // One question, or one in the list: open it at once.
      if (r.questions.length === 1) setExpanded(new Set([r.questions[0]!.id]));
      poller.current ??= new IntervalPoller(refresh, setStatus, { everyMs: REFRESH_MS, ...pollOptions });
      poller.current.setVisible(visible());
      if (r.key) {
        election.current ??= new Supersession(
          (v) => {
            setSuperseded(v);
            poller.current?.setSuperseded(v);
          },
          channelFactory,
          'hexactra-question-card',
        );
        election.current.join('inbox', instanceId, r.key);
      }
      if (itemsRef.current.some((it) => it.state.kind === 'pending')) poller.current.start();
    });
    return () => {
      poller.current?.dispose();
      election.current?.leave();
    };
    // Registered once: the bridge delivers every later result to the same handler.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [host]);

  useEffect(() => {
    if (typeof document === 'undefined') return;
    const on = () => poller.current?.setVisible(visible());
    document.addEventListener('visibilitychange', on);
    return () => document.removeEventListener('visibilitychange', on);
  }, [visible]);

  // The countdown: once a second while a pending question has less than 10 minutes left.
  const counting = (items ?? []).some((it) => it.state.kind === 'pending' && (secondsLeft(it.q.expiresAt, now) ?? Infinity) < COUNTDOWN_BELOW_S + 1);
  useEffect(() => {
    if (!counting) return;
    const t = setInterval(() => setNow(clock()), 1000);
    return () => clearInterval(t);
  }, [counting, clock]);
  useEffect(() => {
    const due = itemsRef.current.filter((it) => it.state.kind === 'pending' && (secondsLeft(it.q.expiresAt, now) ?? 1) <= 0);
    for (const it of due) patch(it.q.id, { kind: 'expired' });
  }, [now, patch]);

  const answer = async (q: CardQuestion, a: RuleAnswer) => {
    patch(q.id, { kind: 'sending' });
    const o = await sendAnswer(host, 'question_card_answer', q, a);
    switch (o.kind) {
      case 'sent': {
        patch(q.id, { kind: 'sent', label: o.label, declined: o.declined, told: true });
        const told = await tellConversation(host, o);
        patch(q.id, { kind: 'sent', label: o.label, declined: o.declined, told });
        break;
      }
      case 'already':
        patch(q.id, { kind: 'already', label: o.label });
        break;
      case 'expired':
        patch(q.id, { kind: 'expired' });
        break;
      case 'refused':
        patch(q.id, { kind: 'pending', error: o.message });
        break;
      default:
        patch(q.id, { kind: 'pending', error: 'Not sent: the answer did not reach Hexactra. Try again.' });
    }
  };

  const open = async (q: CardQuestion, where: 'inbox' | 'viewer') => {
    const viewer = where === 'viewer' && q.viewerUrl ? (safeUrl(q.viewerUrl) ?? consolePage(meta.appUrl, q.viewerUrl)) : null;
    const url = viewer ?? consolePage(meta.appUrl, `/inbox/q/${encodeURIComponent(q.id)}`);
    if (!url) {
      setNotice('Open your Hexactra inbox to answer it.');
      return;
    }
    try {
      await host.openLink(url);
    } catch {
      setNotice(`Open it yourself: ${url}`);
    }
  };

  const frame = frameOf(ctx);

  if (!items) {
    return (
      <main className="card" data-theme={frame.theme} style={frame.style} aria-busy="true">
        <div className="skeleton line wide" />
        <div className="skeleton line" />
        <p className="sr-only" aria-live="polite">
          Loading the questions
        </p>
      </main>
    );
  }

  const pending = items.filter((it) => isOpen(it.state)).length;
  const canAnswer = holds(meta.scopes, 'inbox:write');
  const toggle = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <main className={`card${superseded ? ' superseded' : ''}`} data-theme={frame.theme} style={frame.style}>
      <header className="head">
        <p className="goal">{meta.source === 'list' ? (pending ? `Waiting for you (${pending})` : 'Nothing is waiting for you') : 'Your agent asks'}</p>
      </header>
      {superseded ? <p className="banner info">Newer list below</p> : null}
      {status === 'reconnecting' ? <p className="banner warn">Reconnecting…</p> : null}
      {items.length === 0 ? <p className="muted">When an agent needs a choice, a confirmation or a code, it shows here.</p> : null}
      <ul className="qlist">
        {items.map(({ q, state }) => {
          const left = state.kind === 'pending' ? secondsLeft(q.expiresAt, now) : null;
          const open_ = expanded.has(q.id) || items.length === 1;
          const done = settledText(state);
          return (
            <li key={q.id} className={`qitem${done ? ' settled' : ''}`}>
              <div className="qmeta">
                <span className="chip">{KIND_LABEL[q.kind ?? 'other'] ?? 'Question'}</span>
                <span className="muted">from {askerText(q.askedBy)}</span>
                {left !== null && left < COUNTDOWN_BELOW_S ? <span className="countdown">{left > 0 ? `Expires in ${formatDuration(left)}` : 'Expiring'}</span> : null}
              </div>
              <p className="q-prompt">{q.prompt}</p>
              {q.goal ? <p className="muted q-goal">Run: {q.goal}</p> : null}
              {done ? (
                <p className={`q-done${state.kind === 'sent' ? ' ok' : ''}`} role="status">
                  {done}
                </p>
              ) : items.length > 1 && !open_ ? (
                <button type="button" className="btn" aria-expanded={false} onClick={() => toggle(q.id)}>
                  Answer
                </button>
              ) : canAnswer ? (
                <QuestionForm
                  question={q}
                  disabled={state.kind === 'sending' || superseded}
                  error={state.kind === 'pending' ? (state.error ?? null) : null}
                  onSubmit={(a) => answer(q, a)}
                  onOpen={(where) => void open(q, where)}
                />
              ) : (
                <div className="row">
                  <p className="muted">This connection cannot answer questions.</p>
                  <button type="button" className="btn primary" onClick={() => void open(q, 'inbox')}>
                    Open inbox
                  </button>
                </div>
              )}
              {state.kind === 'sent' && !state.told ? <p className="muted notice">Tell the assistant in the chat to carry on.</p> : null}
            </li>
          );
        })}
      </ul>
      {notice ? <p className="muted notice">{notice}</p> : null}
      <p className="sr-only" aria-live="polite">
        {pending ? `${pending} question${pending === 1 ? '' : 's'} waiting.` : 'Nothing waiting.'}
        {status === 'reconnecting' ? ' Reconnecting.' : ''}
      </p>
    </main>
  );
}
