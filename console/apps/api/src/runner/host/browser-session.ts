// Opening the run's browser session (E38.3; lazily since E39.7): the choice of machine, the allowed sites the browser enforces, and the
// session on the fabric. A run opens it at its start (a browser job), or at the first browser tool call (a run that also has connections:
// a job that needs only mail, a calendar or documents never allocates a node).
import { readAppLimits } from '../../policies/policy-snapshot';
import { fabricAllowedSites } from '@marinoscar/hexactra-browser-agent/policy';
import type { FabricSession } from '../fabric-session';
import { chooseHost } from '../host-choice';
import type { HostDeps } from './deps';

/** What opening a session needs of the run row. */
export interface SessionRun {
  id: string;
  profile: string;
  hostId: string | null;
  hostFallback: boolean;
  appLimits?: unknown;
  task?: { allowedDomains: string[] } | null;
  conversation?: { allowedDomains: string[] } | null;
}

export type OpenedSession = { kind: 'ok'; sessionId: string; note: string | null } | { kind: 'fail'; error: string };

/** Creates the run's browser session. A failure is a message the run reports (`error`); nothing is thrown. */
export async function openFabricSession(d: HostDeps, session: FabricSession, run: SessionRun, opts: { ownerId?: string }): Promise<OpenedSession> {
  try {
    const hosts = run.hostId ? await d.fabric.hosts() : [];
    const choice = chooseHost(hosts, run.hostId, run.hostFallback);
    if (choice.kind === 'fail') return { kind: 'fail', error: choice.error };
    if (choice.note) d.log.log(`run ${run.id}: ${choice.note}`);
    // The browser enforces the run's allowed sites too (#508), so a page cannot leave them on its own.
    const sites = fabricAllowedSites(run.task?.allowedDomains ?? run.conversation?.allowedDomains ?? [], readAppLimits(run.appLimits)?.allowedDomains ?? []);
    const sessionId = await session.create({ profile: run.profile, hostId: choice.hostId, label: `run ${run.id}`, allowedDomains: sites, ...(opts.ownerId ? { ownerId: opts.ownerId } : {}) });
    return { kind: 'ok', sessionId, note: choice.note ?? null };
  } catch (e) {
    return { kind: 'fail', error: `No browser available: ${e instanceof Error ? e.message : String(e)}` };
  }
}
