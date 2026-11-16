import { createHash, randomBytes } from 'node:crypto';

import { ConflictException, Injectable, Logger, NotFoundException, ServiceUnavailableException, UnauthorizedException, ForbiddenException } from '@nestjs/common';

import { FabricClient, FabricError } from '../fabric/fabric.client';
import { PrismaService } from '../prisma/prisma.service';
import { FleetService } from './fleet.service';

/** How long a viewer session (its cookie) lasts. */
export const VIEWER_SESSION_TTL_S = 60 * 60;
export const DESKTOP_COOKIE = 'hx_desktop';
export const DESKTOP_PERMISSION = 'fleet:desktop';
/** Desktop connects allowed per session per minute (reconnects included). */
export const CONNECTS_PER_MINUTE = 10;

const HOST_PATH = /^\/viewer\/([0-9a-fA-F-]{36})\/websockify$/;
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

/** The path a host's desktop is reached at, and the cookie is scoped to. */
export const viewerPath = (hostId: string) => `/viewer/${hostId}/`;

export interface DesktopTunnelGrant {
  tunnelId: string;
  /** `Bearer hxd_…`: nginx sends it to the fabric; it never reaches the browser. */
  authorization: string;
}

/**
 * Remote desktop viewer sessions (#339, docs/nodes.md).
 *
 * 1. A person with `fleet:desktop` opens a host's desktop: the API stores a
 *    session (hash only) bound to that host, user and organization, and sets
 *    an HttpOnly cookie scoped to `/viewer/<hostId>/`.
 * 2. The browser opens `wss://<console>/viewer/<hostId>/websockify`. nginx's
 *    `auth_request` asks {@link authorize}, which checks the session, the
 *    host and the user's permission again, then asks the fabric for a tunnel
 *    and hands nginx the tunnel id and its single-use token.
 * 3. nginx proxies the WebSocket to the fabric's viewer leg with that token.
 */
@Injectable()
export class DesktopViewerService {
  private readonly logger = new Logger(DesktopViewerService.name);
  private readonly connects = new Map<string, number[]>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly fleet: FleetService,
    private readonly fabric: FabricClient,
  ) {}

  /** A new session for `hostId`; returns the cookie value (shown once) and when it expires. */
  async open(input: { userId: string; orgId: string | null; hostId: string }): Promise<{ token: string; expiresAt: Date }> {
    const host = await this.fleet.host(input.hostId);
    if (!host.desktop) {
      throw new ConflictException({ code: 'DESKTOP_UNAVAILABLE', message: `${host.name} has no desktop to share` });
    }
    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + VIEWER_SESSION_TTL_S * 1000);
    await this.prisma.viewerSession.create({
      data: { tokenHash: sha256(token), hostId: input.hostId, userId: input.userId, organizationId: input.orgId, expiresAt },
    });
    this.logger.log(`desktop session opened: host ${input.hostId} by user ${input.userId}`);
    return { token, expiresAt };
  }

  /** Ends this user's open sessions for a host. */
  async revoke(userId: string, hostId: string): Promise<number> {
    const { count } = await this.prisma.viewerSession.updateMany({
      where: { userId, hostId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    if (count) this.logger.log(`desktop session revoked: host ${hostId} by user ${userId}`);
    return count;
  }

  /**
   * nginx's check before a desktop WebSocket: the path names a host, the
   * cookie is a live session for that host, the user still holds
   * `fleet:desktop` (in the session's organization), and the session is under
   * its connect rate. Then a fabric tunnel for it.
   */
  async authorize(originalUri: string | undefined, cookie: string | undefined, now = Date.now()): Promise<DesktopTunnelGrant> {
    const deny = (why: string) => new UnauthorizedException({ code: 'DESKTOP_UNAUTHORIZED', message: why });
    const path = (originalUri ?? '').split('?')[0] ?? '';
    const hostId = HOST_PATH.exec(path)?.[1]?.toLowerCase();
    if (!hostId) throw deny('Not a desktop path');
    if (!cookie || cookie.length > 200) throw deny('Open the desktop from the console');
    const session = await this.prisma.viewerSession.findUnique({ where: { tokenHash: sha256(cookie) } });
    if (!session || session.revokedAt || session.expiresAt.getTime() <= now || session.hostId !== hostId) {
      throw deny('This desktop session is not valid for this host; open it again from the console');
    }
    if (!(await this.holdsPermission(session.userId, session.organizationId))) {
      throw new ForbiddenException({ code: 'DESKTOP_FORBIDDEN', message: 'You no longer have access to remote desktops' });
    }
    const recent = (this.connects.get(session.id) ?? []).filter((t) => t > now - 60_000);
    if (recent.length >= CONNECTS_PER_MINUTE) {
      throw new ConflictException({ code: 'DESKTOP_RATE_LIMITED', message: 'Too many reconnects; wait a minute' });
    }
    this.connects.set(session.id, [...recent, now]);

    const user = await this.prisma.user.findUnique({ where: { id: session.userId }, select: { displayName: true, email: true } });
    let grant: { tunnel_id: string; connect_token: string };
    try {
      grant = await this.fabric.request('POST', `/v1/hosts/${hostId}/desktop-sessions`, {
        body: { actor: { user_id: session.userId, org_id: session.organizationId ?? undefined, display_name: user?.displayName ?? user?.email ?? undefined } },
      });
    } catch (e) {
      throw fabricError(e);
    }
    await this.prisma.viewerSession.update({ where: { id: session.id }, data: { lastConnectAt: new Date(now) } });
    return { tunnelId: grant.tunnel_id, authorization: `Bearer ${grant.connect_token}` };
  }

  /** The user is active and holds `fleet:desktop` through a system role or their role in the session's organization. */
  async holdsPermission(userId: string, orgId: string | null): Promise<boolean> {
    const perm = { rolePermissions: { some: { permission: { name: DESKTOP_PERMISSION } } } };
    const n = await this.prisma.user.count({
      where: {
        id: userId,
        isActive: true,
        OR: [
          { userRoles: { some: { role: perm } } },
          { memberships: { some: { status: 'active', ...(orgId ? { orgId } : {}), role: perm } } },
        ],
      },
    });
    return n > 0;
  }

  /** Deletes sessions that expired (or were revoked) before `before`. */
  async purge(before: Date): Promise<number> {
    const { count } = await this.prisma.viewerSession.deleteMany({
      where: { OR: [{ expiresAt: { lt: before } }, { revokedAt: { lt: before } }] },
    });
    return count;
  }

  cookieHeader(hostId: string, token: string, secure: boolean): string {
    return `${DESKTOP_COOKIE}=${token}; Path=${viewerPath(hostId)}; Max-Age=${VIEWER_SESSION_TTL_S}; HttpOnly; SameSite=Strict${secure ? '; Secure' : ''}`;
  }

  clearCookieHeader(hostId: string, secure: boolean): string {
    return `${DESKTOP_COOKIE}=; Path=${viewerPath(hostId)}; Max-Age=0; HttpOnly; SameSite=Strict${secure ? '; Secure' : ''}`;
  }
}

/** The fabric's refusal as the console's error (409 codes keep their meaning). */
export function fabricError(e: unknown): Error {
  if (e instanceof FabricError) {
    const code = (e as FabricError & { code?: string }).code;
    if (e.status === 404) return new NotFoundException({ code: 'HOST_NOT_FOUND', message: 'Host not found' });
    if (e.status === 409) {
      const c = code === 'host_offline' ? 'HOST_OFFLINE' : code === 'desktop_unavailable' ? 'DESKTOP_UNAVAILABLE' : 'DESKTOP_CONFLICT';
      return new ConflictException({ code: c, message: e.message });
    }
    if (e.status === 429) return new ConflictException({ code: 'DESKTOP_BUSY', message: e.message });
  }
  return new ServiceUnavailableException({ code: 'FABRIC_UNAVAILABLE', message: 'The fabric is not reachable' });
}
