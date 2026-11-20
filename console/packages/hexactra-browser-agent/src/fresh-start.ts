// A fresh browser for each new chat and each task (E40.5, #689). Pure rules:
// when a run restarts its profile's browser before it starts, and which tabs
// are closed afterwards. The host binds them to its fabric (the profile's
// restart command, the `tabs`, `new_tab` and `close_tab` actions).

/** What the decision reads about the run. */
export interface FreshStartInput {
  /** How the run started: `chat`, `manual`, `schedule`, `api`, `mcp`, `external`, … */
  trigger: string;
  /** A chat run: how many earlier runs the same chat has. */
  earlierChatRuns: number;
  /** The run already had a browser session (resumed after a pause or an answer, or a later job of the same run). */
  resumed: boolean;
}

export type FreshStartDecision = { restart: true } | { restart: false; reason: 'chat_follow_up' | 'resumed' | 'external' };

/**
 * Restart for a task run's browser and for a chat's first run; keep it for a
 * follow-up in the same chat (continuity is the point of a chat), for a run
 * that already had its browser, and for an external agent's session (it
 * manages its own browser).
 */
export function freshStartDecision(input: FreshStartInput): FreshStartDecision {
  if (input.resumed) return { restart: false, reason: 'resumed' };
  if (input.trigger === 'external') return { restart: false, reason: 'external' };
  if (input.trigger === 'chat' && input.earlierChatRuns > 0) return { restart: false, reason: 'chat_follow_up' };
  return { restart: true };
}

/** A session the fabric lists (`GET /v1/sessions`). */
export interface ListedSession {
  id: string;
  host_id: string;
  profile?: string;
  status: string;
}

/** Whether another live session drives the same profile on the same host: a restart would break it. */
export function profileShared(sessions: readonly ListedSession[], own: { id: string; hostId: string; profile: string }): boolean {
  return sessions.some((s) => s.id !== own.id && s.host_id === own.hostId && (s.profile ?? 'default') === own.profile && s.status !== 'ended');
}

/** The tabs to close after a restart: every tab but the one the run starts in (Chrome restores the tabs it had before). */
export function tabsToClose(tabs: readonly { id?: unknown }[], keepId: number): number[] {
  return tabs.map((t) => t.id).filter((id): id is number => typeof id === 'number' && id !== keepId);
}

/** The step a run records about its fresh start, in the owner's words. */
export function freshStartSummary(outcome: { restarted: true; closedTabs: number } | { restarted: false; why: 'shared' | 'failed' }): string {
  if (outcome.restarted) return outcome.closedTabs > 0 ? `Started with a fresh browser (restarted it and closed ${outcome.closedTabs} old tab${outcome.closedTabs === 1 ? '' : 's'})` : 'Started with a fresh browser';
  return outcome.why === 'shared' ? 'Kept the browser as it was: another session is using the same profile' : 'Could not restart the browser; continued with it as it was';
}
