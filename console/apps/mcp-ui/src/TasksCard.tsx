// The tasks card (#467): the user's saved tasks with their schedule, next
// run and last result, opened by tasks_list and by the schedules list. Run, Pause
// and Resume are shown only when the connection holds their scope
// (`runs:write`, `tasks:write`); the server checks every call anyway. No
// create or edit form: a task is created by asking the assistant and edited
// in the console (a link per row). Text only.
import { useEffect, useState } from 'react';

import { PAGE_ROWS, RUN_STATUS_LABEL, TASKS_CARD_TOOLS, rowOf, startedRun, tasksResultOf, whenText, type TaskRow, type TasksCardTool, type TasksResult } from './tasks-model';
import type { HostBridge, HostContextLike } from './shared/bridge';
import { holds } from './shared/scopes';
import { consolePage, firstText, structured, type ToolResultLike } from './shared/text';
import { frameOf } from './shared/theme';

export { TASKS_CARD_TOOLS };

type RowBusy = 'run' | 'pause' | 'resume' | null;

interface RowState {
  busy: RowBusy;
  confirmPause: boolean;
  notice: string | null;
  /** A run started from this card. */
  run: { id: string; status: string } | null;
}

const IDLE: RowState = { busy: null, confirmPause: false, notice: null, run: null };

export interface TasksCardProps {
  host: HostBridge<TasksCardTool>;
}

export function TasksCard({ host }: TasksCardProps) {
  const [data, setData] = useState<TasksResult | null>(null);
  const [shown, setShown] = useState(PAGE_ROWS);
  const [rowState, setRowState] = useState<Record<string, RowState>>({});
  const [loadingMore, setLoadingMore] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [ctx, setCtx] = useState<HostContextLike | undefined>(() => host.hostContext());

  const stateOf = (id: string) => rowState[id] ?? IDLE;
  const setRow = (id: string, p: Partial<RowState>) => setRowState((prev) => ({ ...prev, [id]: { ...(prev[id] ?? IDLE), ...p } }));
  const replaceRow = (row: TaskRow) => setData((d) => (d ? { ...d, rows: d.rows.map((r) => (r.id === row.id ? row : r)) } : d));

  useEffect(() => {
    host.onToolInput(() => undefined);
    host.onHostContextChanged((c) => setCtx((prev) => ({ ...prev, ...c })));
    host.onToolResult((raw: ToolResultLike) => {
      const r = tasksResultOf(raw);
      if (!r) return;
      if (!r.fromSchedules) {
        setData(r);
        return;
      }
      // Opened by schedules_list: the schedules name tasks; load the tasks and keep the scheduled ones.
      setData(null);
      void host
        .callTool('tasks_list', { limit: 100 })
        .then((t) => {
          const tr = tasksResultOf(t);
          if (!tr) throw new Error('no tasks');
          setData({ ...tr, rows: tr.rows.filter((x) => x.scheduleState !== 'none'), scopes: tr.scopes ?? r.scopes, fromSchedules: true });
        })
        .catch(() => {
          setData({ ...r, rows: [], fromSchedules: true });
          setNotice('Could not load the tasks of these schedules.');
        });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [host]);

  const run = async (row: TaskRow) => {
    setRow(row.id, { busy: 'run', notice: null });
    try {
      const r = await host.callTool('task_run', { task_id: row.id });
      const started = startedRun(r);
      if (!started) setRow(row.id, { busy: null, notice: firstText(r) || 'The task did not start.' });
      else {
        setRow(row.id, { busy: null, run: started });
        replaceRow({ ...row, liveRunId: started.id });
      }
    } catch {
      setRow(row.id, { busy: null, notice: 'Not started: the host did not send it.' });
    }
  };

  const schedules = async (row: TaskRow, what: 'pause' | 'resume') => {
    setRow(row.id, { busy: what, confirmPause: false, notice: null });
    try {
      const r = await host.callTool(what === 'pause' ? 'task_pause' : 'task_resume', { task_id: row.id });
      const next = r.isError ? undefined : rowOf(structured(r));
      if (!next) setRow(row.id, { busy: null, notice: firstText(r) || `Could not ${what} it.` });
      else {
        replaceRow({ ...next, lastRun: next.lastRun ?? row.lastRun, liveRunId: next.liveRunId ?? row.liveRunId });
        setRow(row.id, { busy: null, notice: what === 'pause' ? 'Paused: it no longer starts by itself.' : 'Resumed.' });
      }
    } catch {
      setRow(row.id, { busy: null, notice: 'Not sent: the host did not send it.' });
    }
  };

  const watch = async (runId: string) => {
    try {
      await host.sendMessage(`Show me how my Hexactra run ${runId} is going.`);
    } catch {
      setNotice('Ask in the chat to follow the run.');
    }
  };

  const open = async (row: TaskRow) => {
    const url = consolePage(data?.appUrl, `/tasks/${encodeURIComponent(row.id)}`);
    if (!url) return setNotice('Open the task in Hexactra.');
    try {
      await host.openLink(url);
    } catch {
      setNotice(`Open it yourself: ${url}`);
    }
  };

  const more = async () => {
    if (!data) return;
    if (shown < data.rows.length) return setShown((n) => n + PAGE_ROWS);
    if (!data.nextCursor) return;
    setLoadingMore(true);
    try {
      const r = tasksResultOf(await host.callTool('tasks_list', { cursor: data.nextCursor }));
      if (!r) throw new Error('no page');
      setData((d) => (d ? { ...d, rows: [...d.rows, ...r.rows.filter((x) => !d.fromSchedules || x.scheduleState !== 'none')], nextCursor: r.nextCursor } : d));
      setShown((n) => n + PAGE_ROWS);
    } catch {
      setNotice('Could not load more tasks.');
    } finally {
      setLoadingMore(false);
    }
  };

  const frame = frameOf(ctx);
  if (!data) {
    return (
      <main className="card" data-theme={frame.theme} style={frame.style} aria-busy="true">
        <div className="skeleton line wide" />
        <div className="skeleton line" />
        <p className="sr-only" aria-live="polite">
          Loading your tasks
        </p>
      </main>
    );
  }

  const canRun = holds(data.scopes, 'runs:write');
  const canPause = holds(data.scopes, 'tasks:write');
  const rows = data.rows.slice(0, shown);
  const hasMore = shown < data.rows.length || data.nextCursor !== null;

  return (
    <main className="card" data-theme={frame.theme} style={frame.style}>
      <header className="head">
        <p className="goal">{data.fromSchedules ? 'Scheduled tasks' : 'Your tasks'}</p>
        {data.total !== null && !data.fromSchedules ? <p className="muted">{`${data.total} task${data.total === 1 ? '' : 's'}`}</p> : null}
      </header>
      {data.rows.length === 0 ? <p className="muted">{data.fromSchedules ? 'No task has a schedule.' : 'No saved tasks yet. Ask the assistant to create one.'}</p> : null}
      <ul className="tlist">
        {rows.map((row) => {
          const st = stateOf(row.id);
          const live = st.run?.id ?? row.liveRunId;
          const last = row.lastRun ? (RUN_STATUS_LABEL[row.lastRun.status] ?? row.lastRun.status) : null;
          const next = whenText(row.nextRunAt);
          return (
            <li key={row.id} className="trow">
              <div className="tmain">
                <p className="tname">{row.name || 'Untitled task'}</p>
                <p className="muted tsched">
                  {row.scheduleState === 'paused' ? 'Schedules paused' : (row.scheduleText ?? 'No schedule')}
                  {next && row.scheduleState !== 'paused' ? ` · Next: ${next}` : ''}
                </p>
                <div className="meta">
                  {live ? <span className="chip chip-running">Running</span> : null}
                  {last && !live ? <span className={`chip chip-${row.lastRun!.status}`}>Last run: {last}</span> : null}
                  {!last && !live ? <span className="muted">Never run</span> : null}
                </div>
              </div>
              {st.confirmPause ? (
                <div className="confirm" role="group" aria-label={`Confirm pausing ${row.name}`}>
                  <span>Pause its schedules?</span>
                  <button type="button" className="btn danger" disabled={st.busy !== null} onClick={() => void schedules(row, 'pause')}>
                    Pause
                  </button>
                  <button type="button" className="btn" onClick={() => setRow(row.id, { confirmPause: false })}>
                    Keep
                  </button>
                </div>
              ) : (
                <div className="row">
                  {live ? (
                    <button type="button" className="btn" onClick={() => void watch(live)}>
                      Watch
                    </button>
                  ) : canRun ? (
                    <button type="button" className="btn primary" disabled={st.busy !== null} aria-label={`Run ${row.name}`} onClick={() => void run(row)}>
                      {st.busy === 'run' ? 'Starting…' : 'Run'}
                    </button>
                  ) : null}
                  {canPause && (row.scheduleState === 'active' || row.scheduleState === 'partial') ? (
                    <button type="button" className="btn" disabled={st.busy !== null} aria-label={`Pause ${row.name}`} onClick={() => setRow(row.id, { confirmPause: true })}>
                      Pause
                    </button>
                  ) : null}
                  {canPause && row.scheduleState === 'paused' ? (
                    <button type="button" className="btn" disabled={st.busy !== null} aria-label={`Resume ${row.name}`} onClick={() => void schedules(row, 'resume')}>
                      {st.busy === 'resume' ? 'Resuming…' : 'Resume'}
                    </button>
                  ) : null}
                  <button type="button" className="link" aria-label={`Open ${row.name} in Hexactra`} onClick={() => void open(row)}>
                    Open
                  </button>
                </div>
              )}
              {st.notice ? (
                <p className="muted notice" role="status">
                  {st.notice}
                </p>
              ) : null}
            </li>
          );
        })}
      </ul>
      {hasMore ? (
        <button type="button" className="btn" disabled={loadingMore} onClick={() => void more()}>
          {loadingMore ? 'Loading…' : 'Show more'}
        </button>
      ) : null}
      {notice ? <p className="muted notice">{notice}</p> : null}
    </main>
  );
}
