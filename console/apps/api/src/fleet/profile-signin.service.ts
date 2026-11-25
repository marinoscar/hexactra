import { ConflictException, HttpException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { Prisma, ProfileSigninSession } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { DesktopViewerService, type TakeoverLease } from './desktop-viewer.service';
import type { FleetHost, FleetProfile, FleetSigninState, ProfileSigninView } from './fleet.schemas';
import { FleetService } from './fleet.service';
import './profile-signin.errors';

/** The page Chrome opens for a guided sign-in. */
export const GOOGLE_SIGNIN_URL = 'https://accounts.google.com/';
/** An unfinished sign-in is abandoned this long after it started (the expire job, or the next poll). */
export const SIGNIN_TIMEOUT_MS = 15 * 60_000;
/** While saving, a browser still running this long after the close is closed again. */
export const CLOSE_RETRY_MS = 30_000;

/** The audit actions; host, profile and outcome only, never an email. */
export const PROFILE_SIGNIN_AUDIT = {
  started: 'profile.signin.started',
  completed: 'profile.signin.completed',
  abandoned: 'profile.signin.abandoned',
} as const;

/** Run statuses in which a run holds its browser (queued runs have not opened one yet). */
const BUSY_RUN_STATUSES = ['running', 'waiting_human', 'paused'] as const;

type EndReason = 'cancelled' | 'timeout' | 'profile_gone' | 'replaced';

/**
 * One-click guided Google sign-in of a node's browser profile (E48.4, #930; docs/decisions/profile-signin-health.md).
 *
 * `start` takes the host's desktop for the person (a viewer session and the takeover lease, as the desktop page does), opens
 * the profile's Chrome at Google's sign-in and records a session. Each poll (`get`) moves the session on, idempotently:
 *
 *   waiting ──(the profile reads signed_in while running)──▶ saving: CloseBrowser sent, so Chrome writes the profile to disk
 *   saving ──(the browser stopped and a newer offline check came in)──▶ completed: lease released, desktop session closed
 *   started ──(Cancel, 15 minutes, the profile disappeared)──▶ abandoned: lease released, the browser is LEFT OPEN
 *
 * The 15-minute limit is also enforced by the `fleet.profile-signin.expire` job, so a closed page never leaves a lease behind.
 * Nothing here runs detached: every step is a request or that job.
 *
 * Keeping the lease across profiles ("Fix sign-ins", E48.6): a session started with `keepLease` leaves the takeover lease and
 * its desktop session in place when it ends. Starting a sign-in on a host whose lease the same person already holds adopts that
 * lease instead of taking a new one, and a still-open sign-in of that person on the same host is ended as `replaced` (the lease
 * passes to the new one). So a queue starts each profile with `keepLease: true`, and either starts the last one without it or
 * releases the lease itself (`DELETE /api/fleet/hosts/:id/takeover/:leaseId`). A kept-lease sign-in that times out still
 * gives the lease back (the person left); one the page never released ends with the lease's own five-minute renewal window.
 *
 * The account email is display data for the person who started the sign-in: it is read live from the host's profile status
 * for the response, and never stored, logged, traced or put in an audit event.
 */
@Injectable()
export class ProfileSigninService {
  private readonly log = new Logger(ProfileSigninService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly fleet: FleetService,
    private readonly viewer: DesktopViewerService,
  ) {}

  /** The person's own rows only (core's scoped data access). */
  private db(userId: string) {
    return this.prisma.forUser({ userId });
  }

  async start(input: { userId: string; orgId: string | null; hostId: string; profile: string; keepLease?: boolean }): Promise<{ view: ProfileSigninView; viewerToken: string | null }> {
    const { userId, hostId, profile } = input;
    const host = await this.fleet.host(hostId);
    if (host.mode !== 'unattended' || !host.desktop) {
      throw new ConflictException({ code: 'SIGNIN_UNAVAILABLE', message: `${host.name} is not an unattended node with a desktop: sign the profile in on that machine` });
    }
    if (!host.online) throw new ConflictException({ code: 'SIGNIN_HOST_OFFLINE', message: `${host.name} is offline` });
    const p = host.profiles.find((x) => x.name === profile);
    if (!p) throw new NotFoundException({ code: 'PROFILE_NOT_FOUND', message: `${host.name} has no profile "${profile}"` });

    // Clicking Sign in again on the same profile returns the sign-in already open.
    const open = await this.db(userId).profileSigninSession.findFirst({ where: { hostId, status: 'started' }, orderBy: { startedAt: 'desc' } });
    if (open?.profile === profile) return { view: this.view(open, host), viewerToken: null };

    await this.assertNotInRun(hostId, p);

    const current = await this.viewer.currentTakeover(hostId);
    if (current && current.userId !== userId) {
      throw new ConflictException({ code: 'TAKEOVER_HELD', message: `${current.displayName ?? 'Someone'} is controlling ${host.name}'s desktop` });
    }
    // The person's other open sign-in on this host hands its lease over.
    if (open) await this.end(open, 'abandoned', { reason: 'replaced', keepLease: true });

    const desktop = await this.viewer.open({ userId, orgId: input.orgId, hostId });
    let lease: TakeoverLease;
    try {
      lease = current ?? (await this.viewer.takeOver(userId, hostId));
    } catch (e) {
      await this.viewer.revokeSession(desktop.id);
      throw e;
    }
    try {
      await this.fleet.command(hostId, { type: 'show_profile', profile, url: GOOGLE_SIGNIN_URL });
    } catch (e) {
      if (!current) await this.releaseLease(userId, hostId, lease.leaseId);
      await this.viewer.revokeSession(desktop.id);
      throw e;
    }
    const row = await this.prisma.profileSigninSession.create({
      data: { userId, organizationId: input.orgId, hostId, profile, leaseId: lease.leaseId, viewerSessionId: desktop.id, keepLease: input.keepLease ?? false },
    });
    await this.audit(row, PROFILE_SIGNIN_AUDIT.started, { adoptedLease: Boolean(current), keepLease: row.keepLease });
    this.log.log(`profile sign-in ${row.id} started: host ${hostId}, profile ${profile}`);
    return { view: this.view(row, host), viewerToken: desktop.token };
  }

  /** The session as the page polls it, moved on by one step when its host's status allows. */
  async get(userId: string, id: string): Promise<ProfileSigninView> {
    let row = await this.own(userId, id);
    const host = await this.readHost(row.hostId);
    if (row.status === 'started') row = await this.advance(row, host);
    return this.view(row, host);
  }

  /** Cancel (or closing the page): abandoned, lease released, the browser left as it is (the person may be mid-2FA). */
  async cancel(userId: string, id: string, keepLease?: boolean): Promise<ProfileSigninView> {
    let row = await this.own(userId, id);
    if (row.status === 'started') row = await this.end(row, 'abandoned', { reason: 'cancelled', ...(keepLease !== undefined ? { keepLease } : {}) });
    return this.view(row, await this.readHost(row.hostId));
  }

  /** The expire job: ends every sign-in still open after the time limit. Returns how many it ended. */
  async expireDue(now = Date.now(), limit = 100): Promise<number> {
    const due = await this.prisma.profileSigninSession.findMany({
      where: { status: 'started', startedAt: { lt: new Date(now - SIGNIN_TIMEOUT_MS) } },
      orderBy: { startedAt: 'asc' },
      take: limit,
    });
    let n = 0;
    for (const row of due) {
      const ended = await this.end(row, 'abandoned', { reason: 'timeout' });
      if (ended.status === 'abandoned' && ended.endReason === 'timeout') n += 1;
    }
    return n;
  }

  /** How many sign-ins are past their time limit (the cron's check). */
  countDue(now = Date.now()): Promise<number> {
    return this.prisma.profileSigninSession.count({ where: { status: 'started', startedAt: { lt: new Date(now - SIGNIN_TIMEOUT_MS) } } });
  }

  private async own(userId: string, id: string): Promise<ProfileSigninSession> {
    const row = await this.db(userId).profileSigninSession.findFirst({ where: { id } });
    if (!row) throw new NotFoundException({ code: 'SIGNIN_NOT_FOUND', message: 'Sign-in session not found' });
    return row;
  }

  /** A profile's browser busy with a run: 409 with the run's link. A run never placed on a host counts when this profile is running. */
  private async assertNotInRun(hostId: string, p: FleetProfile): Promise<void> {
    const run = await this.prisma.run.findFirst({
      where: {
        status: { in: [...BUSY_RUN_STATUSES] },
        profile: p.name,
        OR: [{ hostId }, ...(p.running ? [{ hostId: null, sessionId: { not: null } }] : [])],
      },
      select: { id: true },
      orderBy: { createdAt: 'desc' },
    });
    if (run) {
      throw new ConflictException({ code: 'PROFILE_IN_USE', message: `A run is using the profile "${p.name}"; sign in when it has finished`, details: { runId: run.id, runUrl: `/runs/${run.id}` } });
    }
  }

  /** The host now, or null when the fabric cannot be read (the session then waits; it never fails on it). */
  private async readHost(hostId: string): Promise<FleetHost | null> {
    try {
      return await this.fleet.host(hostId);
    } catch (e) {
      this.log.warn(`profile sign-in: host ${hostId} could not be read: ${e instanceof HttpException ? e.getStatus() : e instanceof Error ? e.name : 'error'}`);
      return null;
    }
  }

  /** One step of the state machine (see the class comment). Safe to call again: each transition is a conditional update. */
  private async advance(row: ProfileSigninSession, host: FleetHost | null): Promise<ProfileSigninSession> {
    if (Date.now() - row.startedAt.getTime() > SIGNIN_TIMEOUT_MS) return this.end(row, 'abandoned', { reason: 'timeout' });
    if (!host) return row;
    const p = host.profiles.find((x) => x.name === row.profile);
    if (!p) return this.end(row, 'abandoned', { reason: 'profile_gone' });

    if (row.phase === 'waiting') {
      if (p.signin !== 'signed_in') return row;
      // Signed in with the browser already stopped (the person closed it): the offline check already read it.
      if (!p.running) return this.end(row, 'completed', { resultState: p.signin });
      const claimed = await this.prisma.profileSigninSession.updateMany({
        where: { id: row.id, status: 'started', phase: 'waiting' },
        data: { phase: 'saving', closeCheckedAt: p.checkedAt, closeSentAt: new Date() },
      });
      if (claimed.count === 1) await this.closeBrowser(row);
      return this.reload(row.id);
    }

    // saving: the browser stopped and the node checked the profile on disk after the close.
    const fresh = row.closeCheckedAt === null || p.checkedAt !== row.closeCheckedAt;
    if (!p.running && fresh) return this.end(row, 'completed', { resultState: p.signin });
    if (p.running && row.closeSentAt && Date.now() - row.closeSentAt.getTime() > CLOSE_RETRY_MS) {
      const claimed = await this.prisma.profileSigninSession.updateMany({ where: { id: row.id, status: 'started', closeSentAt: row.closeSentAt }, data: { closeSentAt: new Date() } });
      if (claimed.count === 1) await this.closeBrowser(row);
      return this.reload(row.id);
    }
    return row;
  }

  /** CloseBrowser, so Chrome writes the signed-in profile to disk. A failure is retried by a later poll. */
  private async closeBrowser(row: ProfileSigninSession): Promise<void> {
    try {
      await this.fleet.command(row.hostId, { type: 'close_browser', profile: row.profile });
    } catch (e) {
      this.log.warn(`profile sign-in ${row.id}: closing the browser failed: ${e instanceof HttpException ? e.getStatus() : e instanceof Error ? e.name : 'error'}`);
    }
  }

  /**
   * Ends a session once (a conditional update, so two polls or a poll and the job never both end it), then gives the desktop
   * back unless the lease is kept. An abandoned session never closes the browser.
   */
  private async end(
    row: ProfileSigninSession,
    status: 'completed' | 'abandoned',
    opts: { reason?: EndReason; resultState?: FleetSigninState; keepLease?: boolean },
  ): Promise<ProfileSigninSession> {
    // A timed-out sign-in always gives the desktop back: the person left, so no next profile will adopt the lease.
    const keep = opts.reason === 'timeout' ? false : (opts.keepLease ?? row.keepLease);
    const claimed = await this.prisma.profileSigninSession.updateMany({
      where: { id: row.id, status: 'started' },
      data: { status, endedAt: new Date(), resultState: opts.resultState ?? null, endReason: status === 'abandoned' ? (opts.reason ?? null) : null, keepLease: keep },
    });
    if (claimed.count !== 1) return this.reload(row.id);
    if (!keep) {
      if (row.leaseId) await this.releaseLease(row.userId, row.hostId, row.leaseId);
      if (row.viewerSessionId) await this.viewer.revokeSession(row.viewerSessionId);
    }
    if (status === 'completed') {
      await this.audit(row, PROFILE_SIGNIN_AUDIT.completed, { resultState: opts.resultState ?? 'unknown', leaseKept: keep });
    } else {
      await this.audit(row, PROFILE_SIGNIN_AUDIT.abandoned, { reason: opts.reason ?? 'cancelled', leaseKept: keep });
    }
    this.log.log(`profile sign-in ${row.id} ${status}${opts.reason ? ` (${opts.reason})` : ''}: host ${row.hostId}, profile ${row.profile}`);
    return this.reload(row.id);
  }

  /** Gives the desktop back; a lease that already expired or was released is fine. */
  private async releaseLease(userId: string, hostId: string, leaseId: string): Promise<void> {
    try {
      await this.viewer.release(userId, hostId, leaseId);
    } catch (e) {
      if (e instanceof NotFoundException) return;
      this.log.warn(`profile sign-in: releasing the takeover on host ${hostId} failed: ${e instanceof HttpException ? e.getStatus() : e instanceof Error ? e.name : 'error'}`);
    }
  }

  private reload(id: string): Promise<ProfileSigninSession> {
    return this.prisma.profileSigninSession.findUniqueOrThrow({ where: { id } });
  }

  /** One audit event: the user, host, profile and outcome; never an email. A failure is logged, never thrown. */
  private async audit(row: ProfileSigninSession, action: string, meta: Record<string, unknown>): Promise<void> {
    try {
      await this.prisma.auditEvent.create({
        data: {
          actorUserId: row.userId,
          action,
          targetType: 'profile_signin',
          targetId: row.id,
          orgId: row.organizationId,
          meta: { hostId: row.hostId, profile: row.profile, ...meta } as Prisma.InputJsonValue,
        },
      });
    } catch (e) {
      this.log.warn(`profile sign-in: the audit record ${action} could not be written: ${e instanceof Error ? e.name : 'error'}`);
    }
  }

  private view(row: ProfileSigninSession, host: FleetHost | null): ProfileSigninView {
    const p = host?.profiles.find((x) => x.name === row.profile);
    const signin: FleetSigninState = p?.signin ?? 'unknown';
    const started = row.status === 'started';
    return {
      id: row.id,
      hostId: row.hostId,
      profile: row.profile,
      status: row.status as ProfileSigninView['status'],
      phase: started ? (row.phase as 'waiting' | 'saving') : null,
      leaseId: started || row.keepLease ? row.leaseId : null,
      keepLease: row.keepLease,
      signin,
      email: signin === 'signed_in' ? (p?.accounts.find((a) => a.state === 'signed_in')?.email ?? null) : null,
      resultState: (row.resultState as FleetSigninState | null) ?? null,
      endReason: (row.endReason as ProfileSigninView['endReason']) ?? null,
      startedAt: row.startedAt.toISOString(),
      expiresAt: new Date(row.startedAt.getTime() + SIGNIN_TIMEOUT_MS).toISOString(),
      endedAt: row.endedAt?.toISOString() ?? null,
    };
  }
}
