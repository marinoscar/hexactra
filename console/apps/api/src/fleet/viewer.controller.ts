import { Controller, Get, Headers, HttpCode, Post, Res, UnauthorizedException } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Auth, Public } from '@marinoscar/platform-api/identity';
import type { FastifyReply } from 'fastify';

import { ViewerTicketService } from './viewer-ticket.service';

/** The bundled host's viewer, proxied by the console's nginx. */
export const LOCAL_VIEWER_PATH = '/viewer/local/';

/**
 * Viewer links for the browser host that runs inside this stack. Seeing the
 * remote browser shows signed-in pages, so a link needs `fleet:write`.
 */
@ApiTags('Fleet')
@Controller('fleet')
export class ViewerController {
  constructor(private readonly tickets: ViewerTicketService) {}

  /** A one-time link to the bundled host's viewer (valid 60 s). */
  @Post('viewer-ticket')
  @HttpCode(200)
  @Auth({ permissions: ['fleet:write'] })
  ticket(): { url: string; expiresInSeconds: number } {
    const ticket = this.tickets.issueTicket();
    const query = new URLSearchParams({ ticket, path: `${LOCAL_VIEWER_PATH.slice(1)}websockify`, autoconnect: '1', resize: 'scale' });
    return { url: `${LOCAL_VIEWER_PATH}vnc.html?${query.toString()}`, expiresInSeconds: 60 };
  }

  /**
   * nginx `auth_request` target for `/viewer/…`. Public on purpose: it holds
   * no data and only says yes (204) to a valid viewer cookie, or to an unused
   * ticket, which it exchanges for a cookie (`X-Viewer-Set-Cookie`).
   */
  @Get('viewer-auth')
  @Public()
  @HttpCode(204)
  auth(
    @Headers('x-original-uri') originalUri: string | undefined,
    @Headers('x-viewer-cookie') cookie: string | undefined,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): void {
    if (this.tickets.validSession(cookie)) return;
    const session = this.tickets.exchange(ticketFrom(originalUri));
    if (!session) throw new UnauthorizedException({ code: 'VIEWER_UNAUTHORIZED', message: 'Open the viewer from the Fleet page' });
    reply.header('x-viewer-set-cookie', this.tickets.cookieHeader(session, (process.env.APP_URL ?? '').startsWith('https://')));
  }
}

/** The `ticket` query parameter of the viewer URL nginx forwards, if any. */
export function ticketFrom(originalUri: string | undefined): string | undefined {
  if (!originalUri || originalUri.length > 4096) return undefined;
  try {
    return new URL(originalUri, 'http://viewer.invalid').searchParams.get('ticket') ?? undefined;
  } catch {
    return undefined;
  }
}
