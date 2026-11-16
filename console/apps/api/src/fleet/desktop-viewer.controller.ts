import { Controller, Delete, ForbiddenException, Get, Headers, HttpCode, HttpException, Param, ParseUUIDPipe, Post, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Auth, CurrentOrg, CurrentUser, Public } from '@marinoscar/platform-api/identity';
import type { FastifyReply } from 'fastify';

import { DESKTOP_COOKIE, DesktopViewerService, viewerPath } from './desktop-viewer.service';

const secure = () => (process.env.APP_URL ?? '').startsWith('https://');

/**
 * Remote desktops of the fleet's hosts (#339). Seeing a desktop shows
 * signed-in pages and lets a person type, so it has its own permission,
 * `fleet:desktop`, checked again on every connect.
 */
@ApiTags('Fleet')
@Controller('fleet')
export class DesktopViewerController {
  constructor(private readonly viewer: DesktopViewerService) {}

  /**
   * Opens a host's desktop for this person: an HttpOnly cookie scoped to
   * `/viewer/<hostId>/`, valid for an hour. The page then opens the
   * WebSocket at `wsPath`.
   */
  @Post('hosts/:id/viewer-session')
  @HttpCode(201)
  @Auth({ permissions: ['fleet:desktop'] })
  async open(
    @CurrentUser('id') userId: string,
    @CurrentOrg() orgId: string | undefined,
    @Param('id', ParseUUIDPipe) hostId: string,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<{ hostId: string; wsPath: string; expiresAt: string }> {
    const s = await this.viewer.open({ userId, orgId: orgId ?? null, hostId });
    reply.header('set-cookie', this.viewer.cookieHeader(hostId, s.token, secure()));
    return { hostId, wsPath: `${viewerPath(hostId)}websockify`, expiresAt: s.expiresAt.toISOString() };
  }

  /** Ends this person's desktop sessions for a host (closing the page does this). */
  @Delete('hosts/:id/viewer-session')
  @HttpCode(204)
  @Auth({ permissions: ['fleet:desktop'] })
  async close(
    @CurrentUser('id') userId: string,
    @Param('id', ParseUUIDPipe) hostId: string,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<void> {
    await this.viewer.revoke(userId, hostId);
    reply.header('set-cookie', this.viewer.clearCookieHeader(hostId, secure()));
  }

  /**
   * nginx `auth_request` target for `/viewer/<hostId>/websockify`. Public on
   * purpose: it reads only the desktop cookie nginx forwards. 204 carries the
   * fabric tunnel (`X-Desktop-Tunnel`, `X-Desktop-Authorization`), which nginx
   * uses and never returns to the browser. nginx accepts only 2xx, 401 and
   * 403 here, so every other refusal is a 403 with `X-Desktop-Error`.
   */
  @Get('desktop-auth')
  @Public()
  @HttpCode(204)
  async auth(
    @Headers('x-original-uri') originalUri: string | undefined,
    @Headers('x-desktop-cookie') cookie: string | undefined,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<void> {
    try {
      const grant = await this.viewer.authorize(originalUri, cookie);
      reply.header('x-desktop-tunnel', grant.tunnelId);
      reply.header('x-desktop-authorization', grant.authorization);
    } catch (e) {
      if (e instanceof HttpException && e.getStatus() !== 401 && e.getStatus() !== 403) {
        const body = e.getResponse() as { code?: string; message?: string };
        reply.header('x-desktop-error', body.code ?? 'DESKTOP_ERROR');
        throw new ForbiddenException(body);
      }
      if (e instanceof HttpException) {
        const body = e.getResponse() as { code?: string };
        reply.header('x-desktop-error', body.code ?? 'DESKTOP_UNAUTHORIZED');
      }
      throw e;
    }
  }
}

export { DESKTOP_COOKIE };
