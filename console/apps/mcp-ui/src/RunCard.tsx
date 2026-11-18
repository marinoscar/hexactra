// The live run card (#466). Every string from a tool result is rendered as a
// React text node: never as HTML, never as an attribute that runs code.
// Its only inputs are the "Needs you" banner's typed form (#467: a choice, a
// number, some text or a low-risk confirm, sent with question_card_answer);
// a code, a password, a high-risk approval or a takeover is never collected
// here, only linked to the console.
import { chatAnswerMode, type RuleAnswer } from '@app/shared/question-rules';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { HostBridge, HostContextLike } from './bridge';
import {
  STATE_LABEL,
  budgetMeter,
  cardState,
  formatCost,
  formatDuration,
  inboxUrl,
  isTerminal,
  safeUrl,
  shortGoal,
  snapshotOf,
  type CardState,
  type Snapshot,
  type ToolResultLike,
} from './model';
import { Poller, type PollStatus, type PollerOptions } from './poller';
import { sendAnswer, tellConversation } from './shared/answer';
import { QuestionForm } from './shared/QuestionForm';
import { Supersession, type ChannelFactory } from './supersede';

export interface RunCardProps {
  host: HostBridge;
  /** Test seams: timers and the BroadcastChannel. */
  pollerOptions?: PollerOptions;
  channelFactory?: ChannelFactory;
  /** Whether the page is visible now (default: the Page Visibility API). */
  isVisible?: () => boolean;
}

/** Merge a newer snapshot over the last one: a bare progress block keeps the run and the last picture. */
function merge(prev: Snapshot | null, next: Snapshot): Snapshot {
  if (!prev || prev.progress.run_id !== next.progress.run_id) return next;
  const hidden = next.progress.screenshot === 'hidden' || next.progress.question?.input === 'secret';
  return {
    progress: next.progress,
    run: next.run ?? prev.run,
    ...(hidden ? {} : next.image ? { image: next.image } : prev.image ? { image: prev.image } : {}),
    ...(next.key ?? prev.key ? { key: next.key ?? prev.key } : {}),
  };
}

function StateIcon({ state }: { state: CardState }) {
  // Monochrome outlined glyphs; the label next to them carries the meaning.
  const paths: Record<CardState, string> = {
    queued: 'M12 7v5l3 2M12 3a9 9 0 1 0 0 18a9 9 0 0 0 0-18Z',
    running: 'M8 5v14l11-7Z',
    waiting: 'M12 8v5M12 16.5v.5M12 3a9 9 0 1 0 0 18a9 9 0 0 0 0-18Z',
    succeeded: 'M5 12.5l4.5 4.5L19 7.5',
    failed: 'M7 7l10 10M17 7L7 17',
    cancelled: 'M7 7h10v10H7Z',
    budget: 'M4 18h16M6 18V9M11 18V6M16 18v-5',
    stalled: 'M9 6v12M15 6v12',
  };
  return (
    <svg className="icon" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" focusable="false">
      <path d={paths[state]} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function RunCard({ host, pollerOptions, channelFactory, isVisible }: RunCardProps) {
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [pollStatus, setPollStatus] = useState<PollStatus>('live');
  const [superseded, setSuperseded] = useState(false);
  const [ctx, setCtx] = useState<HostContextLike | undefined>(() => host.hostContext());
  const [toolName, setToolName] = useState<string | undefined>(() => host.hostContext()?.toolInfo?.tool?.name);
  const [confirmStop, setConfirmStop] = useState(false);
  const [busy, setBusy] = useState<'stop' | 'again' | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [goalOpen, setGoalOpen] = useState(false);
  const [shotOpen, setShotOpen] = useState(false);
  const [shotAt, setShotAt] = useState<number | null>(null);
  const [snapAt, setSnapAt] = useState(0);
  const [now, setNow] = useState(() => (pollerOptions?.now ?? Date.now)());
  /** The inline answer of the question in the banner (#467). */
  const [answered, setAnswered] = useState<{ id: string; kind: 'sending' | 'done' | 'error'; text: string } | null>(null);

  const poller = useRef<Poller | null>(null);
  const election = useRef<Supersession | null>(null);
  const clock = pollerOptions?.now ?? Date.now;
  const visible = useCallback(() => (isVisible ? isVisible() : typeof document === 'undefined' || document.visibilityState !== 'hidden'), [isVisible]);
  const instanceId = useMemo(() => String(host.hostContext()?.toolInfo?.id ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`), [host]);

  const apply = useCallback(
    (s: Snapshot) => {
      setSnap((prev) => merge(prev, s));
      setSnapAt(clock());
      if (s.image) setShotAt(clock());
      if (s.progress.screenshot === 'hidden') setShotOpen(false);
    },
    [clock],
  );

  const elect = useCallback(
    (s: Snapshot) => {
      if (!s.key) return;
      election.current ??= new Supersession((v) => {
        setSuperseded(v);
        poller.current?.setSuperseded(v);
      }, channelFactory);
      election.current.join(s.progress.run_id, instanceId, s.key);
    },
    [channelFactory, instanceId],
  );

  // The opening tool result (and any the host pushes later), the tool input and the host context.
  useEffect(() => {
    host.onToolInput(() => undefined);
    host.onHostContextChanged((c) => {
      setCtx((prev) => ({ ...prev, ...c }));
      if (c.toolInfo?.tool?.name) setToolName(c.toolInfo.tool.name);
    });
    host.onToolResult((r: ToolResultLike) => {
      const s = snapshotOf(r);
      if (!s) return;
      apply(s);
      if (!poller.current) {
        poller.current = new Poller(host, s, { snapshot: apply, status: setPollStatus }, pollerOptions);
        poller.current.setVisible(visible());
        elect(s);
        poller.current.start();
      } else {
        poller.current.observe(s);
      }
    });
    return () => {
      poller.current?.dispose();
      election.current?.leave();
    };
    // Registered once: the bridge delivers every later result to the same handler.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [host]);

  // Pause while the card is not visible; resume when it is.
  useEffect(() => {
    if (typeof document === 'undefined') return;
    const onChange = () => poller.current?.setVisible(visible());
    document.addEventListener('visibilitychange', onChange);
    return () => document.removeEventListener('visibilitychange', onChange);
  }, [visible]);

  // "Updated N s ago" and the elapsed time tick once a second while the run is live.
  const state: CardState | null = snap ? cardState(snap.progress, snap.run) : null;
  const terminal = state !== null && isTerminal(state);
  useEffect(() => {
    if (terminal) return;
    const t = setInterval(() => setNow(clock()), 1000);
    return () => clearInterval(t);
  }, [terminal, clock]);

  const stop = async () => {
    if (!snap || superseded) return;
    setBusy('stop');
    setNotice(null);
    try {
      const s = snapshotOf(await host.callTool('run_cancel', { run_id: snap.progress.run_id }));
      if (s) {
        apply(s);
        poller.current?.observe(s);
      }
      setNotice('Stopping after the current step.');
    } catch {
      setNotice('Could not stop the run from here. Open it in Hexactra to stop it.');
    } finally {
      setBusy(null);
      setConfirmStop(false);
    }
  };

  const runAgain = async () => {
    if (!snap || superseded) return;
    const taskId = snap.run?.taskId;
    setNotice(null);
    if (!taskId) {
      try {
        await host.sendMessage('Run this again');
      } catch {
        setNotice('Ask in the chat to run it again.');
      }
      return;
    }
    setBusy('again');
    try {
      const s = snapshotOf(await host.callTool('task_run', { task_id: taskId }));
      if (!s) throw new Error('no run');
      setSnap(s);
      setSnapAt(clock());
      setShotAt(s.image ? clock() : null);
      setToolName('task_run');
      elect(s);
      poller.current?.follow(s);
    } catch {
      setNotice('Could not start the task again from here.');
    } finally {
      setBusy(null);
    }
  };

  const answerInline = async (a: RuleAnswer) => {
    const q = snap?.progress.question;
    if (!q || superseded) return;
    setAnswered({ id: q.id, kind: 'sending', text: '' });
    const o = await sendAnswer(host, 'question_card_answer', q, a);
    if (o.kind === 'sent') {
      setAnswered({ id: q.id, kind: 'done', text: o.declined ? 'Sent: you declined.' : `Sent: ${o.label}` });
      await tellConversation(host, o);
      // The run resumes: the next refresh shows it.
    } else if (o.kind === 'already') setAnswered({ id: q.id, kind: 'done', text: `Answered on another device: ${o.label}` });
    else if (o.kind === 'expired') setAnswered({ id: q.id, kind: 'done', text: 'This question expired.' });
    else setAnswered({ id: q.id, kind: 'error', text: o.kind === 'refused' ? o.message : 'Not sent: the answer did not reach Hexactra. Try again.' });
  };

  const open = async (url: string | null) => {
    if (!url) return;
    try {
      await host.openLink(url);
    } catch {
      setNotice(`Open it yourself: ${url}`);
    }
  };

  const theme = ctx?.theme === 'dark' ? 'dark' : 'light';
  const insets = ctx?.safeAreaInsets;
  const style = insets ? { paddingTop: insets.top, paddingRight: insets.right, paddingBottom: insets.bottom, paddingLeft: insets.left } : undefined;

  if (!snap || !state) {
    return (
      <main className="card" data-theme={theme} style={style} aria-busy="true">
        <div className="skeleton line wide" />
        <div className="skeleton shot" />
        <div className="skeleton line" />
        <p className="sr-only" aria-live="polite">
          Loading the run
        </p>
      </main>
    );
  }

  const p = snap.progress;
  const goal = shortGoal(snap.run?.goal ?? '');
  const meter = budgetMeter(p.budget);
  const tier = [snap.run?.policy?.name, snap.run?.currentTier].filter(Boolean).join(' · ');
  const cost = formatCost(snap.run);
  const consoleUrl = safeUrl(p.console_url);
  const elapsed = terminal || state === 'queued' ? p.elapsed_s : p.elapsed_s + Math.max(0, Math.floor((now - snapAt) / 1000));
  const ago = shotAt !== null ? Math.max(0, Math.round((now - shotAt) / 1000)) : null;
  const hideShot = p.screenshot === 'hidden' || p.question?.input === 'secret';
  // Opened by the call that started the run (not by a call that only follows one).
  const startedHere = toolName !== undefined && toolName !== 'run_status' && toolName !== 'run_wait' && toolName !== 'run_card_poll';
  const question = p.needs_human ? p.question : undefined;
  const inbox = question ? inboxUrl(p.console_url, question.id) : null;
  const inlineForm = question !== undefined && chatAnswerMode(question) === 'form';
  const inline = question && answered?.id === question.id ? answered : null;
  const pageDerived = state === 'running' || p.activity.startsWith('Last step') || state === 'waiting';

  return (
    <main className={`card state-${state}${superseded ? ' superseded' : ''}`} data-theme={theme} style={style}>
      <header className="head">
        <div className="title">
          <p className="goal" title={goalOpen ? undefined : snap.run?.goal}>
            {goalOpen ? (snap.run?.goal ?? '') : goal.text || 'Hexactra run'}
          </p>
          {goal.more ? (
            <button type="button" className="link" aria-expanded={goalOpen} onClick={() => setGoalOpen((v) => !v)}>
              {goalOpen ? 'Less' : 'More'}
            </button>
          ) : null}
        </div>
        <div className="meta">
          <span className={`chip chip-${state}`}>
            <StateIcon state={state} />
            <span>{STATE_LABEL[state]}</span>
          </span>
          <span className="muted">{formatDuration(elapsed)}</span>
          {startedHere ? <span className="muted">Started by this chat</span> : null}
        </div>
      </header>

      {superseded ? <p className="banner info">Newer update below</p> : null}
      {pollStatus === 'reconnecting' ? <p className="banner warn">Reconnecting…</p> : null}
      {pollStatus === 'paused' ? (
        <p className="banner info">
          Paused updating.{' '}
          <button type="button" className="link" onClick={() => poller.current?.start()}>
            Refresh
          </button>
        </p>
      ) : null}

      {question ? (
        <section className="banner needs" aria-label="The run needs you">
          <p className="q-label">Needs you</p>
          <p className="q-prompt">{question.prompt}</p>
          {inline?.kind === 'done' ? (
            <p className="q-done ok" role="status">
              {inline.text}
            </p>
          ) : inlineForm ? (
            <QuestionForm
              key={question.id}
              question={question}
              disabled={superseded || inline?.kind === 'sending'}
              error={inline?.kind === 'error' ? inline.text : null}
              onSubmit={(a) => answerInline(a)}
              onOpen={() => void open(inbox)}
            />
          ) : null}
          <div className="row">
            {question.answerable_here && !inlineForm && question.input !== 'secret' ? (
              <button type="button" className="btn" disabled={superseded} onClick={() => void host.sendMessage('Ask me the question my Hexactra run is waiting on, so I can answer it here.').catch(() => setNotice('Answer it in the chat.'))}>
                Answer in the chat
              </button>
            ) : null}
            {inbox ? (
              <button type="button" className="btn" onClick={() => void open(inbox)}>
                Open inbox
              </button>
            ) : null}
          </div>
        </section>
      ) : null}

      <figure className="shot">
        {snap.image && !hideShot ? (
          <button type="button" className={`shot-btn${shotOpen ? ' open' : ''}`} aria-expanded={shotOpen} aria-label={shotOpen ? 'Show the screenshot smaller' : 'Show the screenshot larger'} onClick={() => setShotOpen((v) => !v)}>
            <img src={`data:${snap.image.mimeType};base64,${snap.image.data}`} alt={`Screenshot of the run's browser. ${p.activity}`} />
          </button>
        ) : (
          <div className="shot-empty">{hideShot ? 'Screenshot hidden while a code or password is entered' : (p.screenshot_note ?? (terminal ? 'No screenshot' : 'Waiting for a screenshot'))}</div>
        )}
        {snap.image && !hideShot && ago !== null ? <figcaption className="muted">{terminal ? 'Last screenshot' : `Updated ${ago} s ago`}</figcaption> : null}
      </figure>

      {!terminal ? (
        <p className="now">
          <span className="now-label">Now</span> <span>{p.activity}</span>
          {pageDerived ? <span className="tag">from the page</span> : null}
        </p>
      ) : (
        <section className="result">
          {p.result ? <p className="result-text">{p.result}</p> : null}
          {p.stop_reason ? <p className="muted">{p.stop_reason}</p> : null}
          <p className="muted">
            Took {formatDuration(p.elapsed_s)}, {p.steps_done} step{p.steps_done === 1 ? '' : 's'}
            {cost ? `, ${cost}` : ''}
          </p>
        </section>
      )}

      {meter && !terminal ? (
        <div className="budget">
          <div className="budget-text muted">
            <span>{tier || 'Budget'}</span>
            <span>
              {meter.label} {Math.round(meter.percent)}%
            </span>
          </div>
          <div className="meter" role="meter" aria-label={`${meter.label} budget used`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(meter.percent)}>
            <div className="meter-fill" style={{ width: `${meter.percent}%` }} />
          </div>
        </div>
      ) : null}

      {notice ? <p className="muted notice">{notice}</p> : null}

      <footer className="actions">
        {!terminal ? (
          confirmStop ? (
            <div className="confirm" role="group" aria-label="Confirm stop">
              <span>Stop this run?</span>
              <button type="button" className="btn danger" disabled={busy !== null} onClick={() => void stop()}>
                Stop run
              </button>
              <button type="button" className="btn" onClick={() => setConfirmStop(false)}>
                Keep running
              </button>
            </div>
          ) : (
            <button type="button" className="btn danger" disabled={superseded || busy !== null} onClick={() => setConfirmStop(true)}>
              Stop
            </button>
          )
        ) : (
          <button type="button" className="btn" disabled={superseded || busy !== null} onClick={() => void runAgain()}>
            Run again
          </button>
        )}
        {consoleUrl ? (
          <button type="button" className="btn primary" onClick={() => void open(consoleUrl)}>
            Open in Hexactra
          </button>
        ) : null}
      </footer>

      <p className="sr-only" aria-live="polite">
        {`Run ${STATE_LABEL[state].toLowerCase()}.`}
        {pollStatus === 'reconnecting' ? ' Reconnecting.' : ''}
        {pollStatus === 'paused' ? ' Paused updating.' : ''}
        {superseded ? ' A newer update is below.' : ''}
      </p>
    </main>
  );
}
