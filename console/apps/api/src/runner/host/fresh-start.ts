// A fresh browser for each new chat and each task (E40.5, #689): the host binding of the package's rules. Before a run uses a newly
// opened session, the profile's browser is restarted on its host (the fleet's `restart_browser` command; the profile and its sign-ins
// stay) and the tabs Chrome restored are closed, leaving one blank tab. Never when another session uses the same profile on that host.
// Never fails the run: a failure is logged and the run goes on with the browser as it is.
import { freshStartDecision, freshStartSummary, profileShared, tabsToClose, type ListedSession } from '@marinoscar/hexactra-browser-agent';

import type { FabricSession } from '../fabric-session';
import type { HostDeps } from './deps';

/** How long the host may take to close and start the browser again. */
const RESTART_TIMEOUT_MS = 90_000;

export interface FreshStartRun {
  id: string;
  profile: string;
  trigger?: string | null;
  conversationId?: string | null;
  createdAt?: Date;
}

interface CommandView {
  state: string;
  error?: string;
}

/** Records the outcome as a step of the run (not an action). Never throws. */
async function recordStep(d: HostDeps, runId: string, summary: string, ok: boolean): Promise<void> {
  try {
    const last = await d.prisma.runStep.aggregate({ where: { runId }, _max: { seq: true } });
    await d.prisma.runStep.create({ data: { runId, seq: (last._max.seq ?? 0) + 1, kind: 'browser', action: 'fresh_start', ok, summary, durationMs: 0 } });
  } catch (e) {
    d.log.warn(`run ${runId}: could not record the fresh start: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/**
 * Restart the profile's browser for a new chat or task, then close the restored tabs. Returns the line the agent reads (null when
 * nothing was done). `resumed`: the run had a browser before (a paused run whose session ended keeps its place, it is not a new start).
 */
export async function freshStart(d: HostDeps, session: FabricSession, run: FreshStartRun, sessionId: string, opts: { resumed: boolean }): Promise<string | null> {
  try {
    const earlierChatRuns = run.trigger === 'chat' && run.conversationId ? await d.prisma.run.count({ where: { conversationId: run.conversationId, id: { not: run.id }, ...(run.createdAt ? { createdAt: { lt: run.createdAt } } : {}) } }) : 0;
    const decision = freshStartDecision({ trigger: run.trigger ?? 'manual', earlierChatRuns, resumed: opts.resumed });
    if (!decision.restart) return null;

    const listed = await d.fabric.request<{ sessions: ListedSession[] }>('GET', '/v1/sessions');
    const own = listed.sessions.find((s) => s.id === sessionId);
    if (!own) throw new Error('the new session is not listed');
    if (profileShared(listed.sessions, { id: sessionId, hostId: own.host_id, profile: run.profile })) {
      await recordStep(d, run.id, freshStartSummary({ restarted: false, why: 'shared' }), true);
      d.log.log(`run ${run.id}: profile ${run.profile} is in use by another session; browser not restarted`);
      return null;
    }

    const cmd = await d.fabric.request<CommandView>('POST', `/v1/hosts/${encodeURIComponent(own.host_id)}/commands`, {
      body: { command: { type: 'restart_browser', profile: run.profile }, timeout_ms: RESTART_TIMEOUT_MS },
      timeoutMs: RESTART_TIMEOUT_MS + 10_000,
    });
    if (cmd.state !== 'succeeded') throw new Error(cmd.error ?? `the restart ${cmd.state}`);

    // Chrome restores the tabs it had: open one blank tab and close the rest.
    const opened = await session.act(sessionId, { type: 'new_tab' });
    const keep = Number(opened.result?.tab_id);
    let closed = 0;
    if (opened.state === 'succeeded' && Number.isInteger(keep)) {
      const listing = await session.act(sessionId, { type: 'tabs' });
      for (const tabId of tabsToClose((listing.result?.tabs as { id?: unknown }[] | undefined) ?? [], keep)) {
        const r = await session.act(sessionId, { type: 'close_tab', tab_id: tabId }).catch(() => null);
        if (r?.state === 'succeeded') closed += 1;
      }
    }
    const summary = freshStartSummary({ restarted: true, closedTabs: closed });
    await recordStep(d, run.id, summary, true);
    d.log.log(`run ${run.id}: ${summary}`);
    return 'The browser was restarted for this run and is on a blank tab; sign-ins of the profile are kept.';
  } catch (e) {
    d.log.warn(`run ${run.id}: fresh browser start skipped: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}
