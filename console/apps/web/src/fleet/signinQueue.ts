// "Fix sign-ins" (E48.6, #932): every profile of the fleet that needs a Google sign-in, fixed one at a time with the guided
// sign-in of E48.4. The queue runs one desktop at a time (Google flags simultaneous new-device sign-ins). On one host the
// takeover lease is kept between profiles (`keepLease`), so the person is not asked to take over again; it is released when
// the queue moves to another host, stops or ends.
import { isPlatformApiError, type PlatformApiClient } from '@marinoscar/platform-web/core';

import { signinAction } from '../components/fleet/ProfileSigninStatus';
import { needsSignin, type FleetHost, type FleetSigninState } from '../types/fleet';
import { cancelProfileSignin, profileInUseRun, startProfileSignin, type ProfileSignin } from './signin';

export type QueueItemStatus = 'pending' | 'signed_in' | 'skipped' | 'failed';

/** One profile the person can sign in from the console. */
export interface QueueItem {
  /** `<hostId>/<profile>`. */
  key: string;
  hostId: string;
  hostName: string;
  profile: string;
  /** The profile's state, and when the node checked it, when the queue was built. */
  state: FleetSigninState;
  checkedAt: string | null;
  status: QueueItemStatus;
  /** Why it was skipped or failed, in words. */
  reason: string | null;
  /** The run using the profile, when it was skipped as busy. */
  runUrl: string | null;
}

/** A profile that needs sign-in but cannot be signed in from the console: the hint of E48.3. */
export interface OnNodeItem {
  key: string;
  hostName: string;
  profile: string;
  hint: string;
}

export interface SigninQueue {
  items: QueueItem[];
  onNode: OnNodeItem[];
  /** A takeover lease the queue kept for the next profile on that host. */
  held: { hostId: string; leaseId: string } | null;
  /** The sign-in running now. */
  active: { key: string; sessionId: string } | null;
  /** The queue has been started at least once (the page then says Continue). */
  ran: boolean;
}

export const OFFLINE_REASON = 'The node is offline';
export const SKIPPED_REASON = 'You skipped it';
export const BUSY_REASON = 'Busy with a run; sign it in when the run ends';

const byName = (a: string, b: string) => a.localeCompare(b, undefined, { sensitivity: 'base' }) || (a < b ? -1 : a > b ? 1 : 0);

/** The hosts in a stable order: by name, then id. */
function sortedHosts(hosts: FleetHost[]): FleetHost[] {
  return [...hosts].sort((a, b) => byName(a.name, b.name) || byName(a.id, b.id));
}

/** How many profiles the person can sign in from the console: the "Fix sign-ins (N)" count. */
export function fixableCount(hosts: FleetHost[], canDesktop: boolean): number {
  return hosts.reduce((n, h) => n + (signinAction(h, canDesktop).kind === 'button' ? h.profiles.filter(needsSignin).length : 0), 0);
}

/** The queue, grouped by host (host name, then profile name). An offline host's profiles start skipped. */
export function buildSigninQueue(hosts: FleetHost[], canDesktop: boolean): SigninQueue {
  const items: QueueItem[] = [];
  const onNode: OnNodeItem[] = [];
  for (const h of sortedHosts(hosts)) {
    const action = signinAction(h, canDesktop);
    for (const p of [...h.profiles].filter(needsSignin).sort((a, b) => byName(a.name, b.name))) {
      const key = `${h.id}/${p.name}`;
      if (action.kind === 'hint') {
        onNode.push({ key, hostName: h.name, profile: p.name, hint: action.text });
        continue;
      }
      items.push({
        key,
        hostId: h.id,
        hostName: h.name,
        profile: p.name,
        state: p.signin,
        checkedAt: p.checkedAt,
        status: h.online ? 'pending' : 'skipped',
        reason: h.online ? null : OFFLINE_REASON,
        runUrl: null,
      });
    }
  }
  return { items, onNode, held: null, active: null, ran: false };
}

/** The items grouped by host, in queue order. */
export function groupByHost(items: QueueItem[]): { hostId: string; hostName: string; items: QueueItem[] }[] {
  const groups: { hostId: string; hostName: string; items: QueueItem[] }[] = [];
  for (const it of items) {
    const last = groups.at(-1);
    if (last?.hostId === it.hostId) last.items.push(it);
    else groups.push({ hostId: it.hostId, hostName: it.hostName, items: [it] });
  }
  return groups;
}

export function summaryOf(q: SigninQueue): Record<QueueItemStatus, number> {
  const n: Record<QueueItemStatus, number> = { pending: 0, signed_in: 0, skipped: 0, failed: 0 };
  for (const it of q.items) n[it.status] += 1;
  return n;
}

const update = (q: SigninQueue, key: string, change: Partial<QueueItem>): SigninQueue => ({
  ...q,
  items: q.items.map((it) => (it.key === key ? { ...it, ...change } : it)),
});

/** Puts items back in the queue (a retry). */
export function retryItems(q: SigninQueue, keys: string[]): SigninQueue {
  const set = new Set(keys);
  return { ...q, items: q.items.map((it) => (set.has(it.key) ? { ...it, status: 'pending', reason: null, runUrl: null } : it)) };
}

/** Whether another pending item after `key` is on the same host: then the sign-in of `key` keeps the lease for it. */
export function nextOnSameHost(q: SigninQueue, key: string): boolean {
  const i = q.items.findIndex((it) => it.key === key);
  const next = q.items.slice(i + 1).find((it) => it.status === 'pending');
  return Boolean(next && next.hostId === q.items[i]?.hostId);
}

/** Gives back a lease the queue kept; one that already expired or was released is fine. */
export async function releaseHeld(api: PlatformApiClient, q: SigninQueue): Promise<SigninQueue> {
  if (!q.held) return q;
  const { hostId, leaseId } = q.held;
  await api.delete(`/fleet/hosts/${hostId}/takeover/${leaseId}`).catch(() => undefined);
  return { ...q, held: null };
}

/** Why a start was refused, as the item's outcome: offline, someone else's takeover and a busy profile are skips. */
function refusal(e: unknown): Pick<QueueItem, 'status' | 'reason' | 'runUrl'> {
  const run = profileInUseRun(e);
  if (run) return { status: 'skipped', reason: BUSY_REASON, runUrl: run.runUrl };
  const code = isPlatformApiError(e) ? e.code : null;
  const msg = e instanceof Error && e.message ? e.message : 'Could not start the sign-in';
  if (code === 'SIGNIN_HOST_OFFLINE') return { status: 'skipped', reason: OFFLINE_REASON, runUrl: null };
  if (code === 'TAKEOVER_HELD') return { status: 'skipped', reason: msg, runUrl: null };
  if (code === 'PROFILE_IN_USE') return { status: 'skipped', reason: BUSY_REASON, runUrl: null };
  return { status: 'failed', reason: msg, runUrl: null };
}

/**
 * Starts the next pending item. A kept lease on another host is released first. A refused start marks its item skipped
 * (offline, taken over by someone else, busy with a run) or failed, and the queue moves on. Returns the started sign-in, or
 * null when nothing is left (the kept lease is then released).
 */
export async function startNext(api: PlatformApiClient, queue: SigninQueue): Promise<{ queue: SigninQueue; session: ProfileSignin | null }> {
  let q: SigninQueue = { ...queue, active: null, ran: true };
  for (;;) {
    const item = q.items.find((it) => it.status === 'pending');
    if (!item) return { queue: await releaseHeld(api, q), session: null };
    if (q.held && q.held.hostId !== item.hostId) q = await releaseHeld(api, q);
    const keepLease = nextOnSameHost(q, item.key);
    try {
      const s = await startProfileSignin(api, item.hostId, item.profile, { keepLease });
      // A sign-in that keeps its lease leaves it to the queue to release; one that does not gives it back itself.
      const held = s.keepLease && s.leaseId ? { hostId: item.hostId, leaseId: s.leaseId } : null;
      return { queue: { ...q, held, active: { key: item.key, sessionId: s.id } }, session: s };
    } catch (e) {
      q = update(q, item.key, refusal(e));
    }
  }
}

const END_REASON: Record<NonNullable<ProfileSignin['endReason']>, string> = {
  cancelled: SKIPPED_REASON,
  replaced: SKIPPED_REASON,
  timeout: 'Not finished within 15 minutes',
  profile_gone: 'The profile is no longer on the node',
};

/** The active item's outcome from its ended sign-in. A sign-in still running counts as skipped. */
export function recordResult(queue: SigninQueue, session: ProfileSignin | null): SigninQueue {
  const key = queue.active?.key;
  if (!key) return queue;
  const q = { ...queue, active: null };
  if (!session || session.status === 'started') return update(q, key, { status: 'skipped', reason: SKIPPED_REASON });
  if (session.status === 'completed') {
    return session.resultState === 'signed_in'
      ? update(q, key, { status: 'signed_in', reason: null })
      : update(q, key, { status: 'failed', reason: `Chrome closed, but the profile reads ${session.resultState ?? 'unknown'}` });
  }
  const reason = END_REASON[session.endReason ?? 'cancelled'];
  return update(q, key, { status: reason === SKIPPED_REASON ? 'skipped' : 'failed', reason });
}

/** Skip: ends the running sign-in, keeping the lease only when the next profile is on the same host. */
export function skipSignin(api: PlatformApiClient, s: Pick<ProfileSignin, 'id' | 'keepLease'>): Promise<ProfileSignin> {
  return cancelProfileSignin(api, s.id, { keepLease: s.keepLease });
}

// The queue lives in this tab while the person moves between it and the desktop page (a reload keeps it).
const STORAGE_KEY = 'hexactra.fleet.signinQueue';
let memory: SigninQueue | null = null;

export function loadQueue(): SigninQueue | null {
  if (memory) return memory;
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY);
    memory = raw ? (JSON.parse(raw) as SigninQueue) : null;
  } catch {
    memory = null;
  }
  return memory;
}

export function saveQueue(q: SigninQueue | null): void {
  memory = q;
  try {
    if (q) window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(q));
    else window.sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // Storage blocked: the in-memory copy still carries the queue through the tab's navigation.
  }
}

/** The queue page, back from the desktop page after a sign-in (`next`: move on, `stop`: stay on the list). */
export function queuePath(sessionId?: string, then: 'next' | 'stop' = 'next'): string {
  return sessionId ? `/fleet/signin-queue?from=${encodeURIComponent(sessionId)}${then === 'stop' ? '&stop=1' : ''}` : '/fleet/signin-queue';
}

/** The desktop page in sign-in mode, inside the queue. */
export function queueDesktopPath(s: Pick<ProfileSignin, 'hostId' | 'id'>): string {
  return `/fleet/hosts/${s.hostId}/desktop?signin=${encodeURIComponent(s.id)}&queue=1`;
}
