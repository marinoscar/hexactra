import { BadRequestException, Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Auth, CurrentOrg, CurrentUser } from '@marinoscar/platform-api/identity';
import type { FastifyReply } from 'fastify';

import { DesktopViewerService } from './desktop-viewer.service';
import { CancelProfileSigninDto, StartProfileSigninDto, profileNameSchema, type ProfileSigninView } from './fleet.schemas';
import { ProfileSigninService } from './profile-signin.service';

const secure = () => (process.env.APP_URL ?? '').startsWith('https://');

/**
 * One-click guided sign-in of a node's browser profile (E48.4, #930): the console takes the host's desktop, opens the profile at
 * Google's sign-in, notices the sign-in, closes the browser so Chrome saves it, and gives the desktop back. The person signs in
 * on the desktop; the fabric never types a password. Seeing and controlling the desktop needs `fleet:desktop`.
 */
@ApiTags('Fleet')
@Controller('fleet')
export class ProfileSigninController {
  constructor(
    private readonly signins: ProfileSigninService,
    private readonly viewer: DesktopViewerService,
  ) {}

  /**
   * Starts a guided sign-in: takes over the desktop, opens the profile at Google's sign-in, and sets the desktop cookie. 409
   * `PROFILE_IN_USE` (with `runUrl`) while a run uses the profile, `TAKEOVER_HELD` while someone else controls the desktop,
   * `SIGNIN_UNAVAILABLE` on a host that is not an unattended node with a desktop. Open the desktop page with `?signin=<id>`.
   */
  @Post('hosts/:id/profiles/:name/signin')
  @HttpCode(201)
  @Auth({ permissions: ['fleet:desktop'] })
  async start(
    @CurrentUser('id') userId: string,
    @CurrentOrg() orgId: string | undefined,
    @Param('id', ParseUUIDPipe) hostId: string,
    @Param('name') name: string,
    @Body() body: StartProfileSigninDto,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<ProfileSigninView> {
    const parsed = profileNameSchema.safeParse(name);
    if (!parsed.success) throw new BadRequestException({ code: 'INVALID_PROFILE', message: parsed.error.issues[0]?.message ?? 'Invalid profile name' });
    const { view, viewerToken } = await this.signins.start({ userId, orgId: orgId ?? null, hostId, profile: parsed.data, keepLease: body?.keepLease });
    if (viewerToken) reply.header('set-cookie', this.viewer.cookieHeader(hostId, viewerToken, secure()));
    return view;
  }

  /** The sign-in as the desktop page polls it; each poll moves it on (signed in → saving → completed). */
  @Get('signin-sessions/:id')
  @Auth({ permissions: ['fleet:desktop'] })
  get(@CurrentUser('id') userId: string, @Param('id', ParseUUIDPipe) id: string): Promise<ProfileSigninView> {
    return this.signins.get(userId, id);
  }

  /** Ends an unfinished sign-in as abandoned: the desktop is given back and the browser is left open. */
  @Post('signin-sessions/:id/cancel')
  @HttpCode(200)
  @Auth({ permissions: ['fleet:desktop'] })
  cancel(@CurrentUser('id') userId: string, @Param('id', ParseUUIDPipe) id: string, @Body() body: CancelProfileSigninDto): Promise<ProfileSigninView> {
    return this.signins.cancel(userId, id, body?.keepLease);
  }
}
