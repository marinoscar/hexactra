import { BadRequestException, Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Auth } from '@marinoscar/platform-api/identity';

import { CreateEnrollmentDto, CreateProfileDto, DrainDto, profileNameSchema, type FleetCommandResult, type FleetEnrollment, type FleetHost } from './fleet.schemas';
import { FleetService } from './fleet.service';

/** A profile name from the path, validated like the fabric does. */
function profile(name: string): string {
  const parsed = profileNameSchema.safeParse(name);
  if (!parsed.success) throw new BadRequestException({ code: 'INVALID_PROFILE', message: parsed.error.issues[0]?.message ?? 'Invalid profile name' });
  return parsed.data;
}

/**
 * `/api/fleet`: the fabric's browser hosts and their profiles. Read with
 * `fleet:read`; every change needs `fleet:write`.
 */
@ApiTags('Fleet')
@Controller('fleet')
export class FleetController {
  constructor(private readonly fleet: FleetService) {}

  @Get('hosts')
  @Auth({ permissions: ['fleet:read'] })
  hosts(): Promise<FleetHost[]> {
    return this.fleet.hosts();
  }

  @Get('hosts/:id')
  @Auth({ permissions: ['fleet:read'] })
  host(@Param('id', ParseUUIDPipe) id: string): Promise<FleetHost> {
    return this.fleet.host(id);
  }

  @Get('hosts/:id/commands')
  @Auth({ permissions: ['fleet:read'] })
  commands(@Param('id', ParseUUIDPipe) id: string): Promise<FleetCommandResult[]> {
    return this.fleet.commands(id);
  }

  /** A single-use enrollment token plus the agent command line (shown once). */
  @Post('enrollments')
  @Auth({ permissions: ['fleet:write'] })
  enroll(@Body() body: CreateEnrollmentDto): Promise<FleetEnrollment> {
    return this.fleet.enroll(body);
  }

  @Delete('hosts/:id')
  @HttpCode(204)
  @Auth({ permissions: ['fleet:write'] })
  revoke(@Param('id', ParseUUIDPipe) id: string): Promise<void> {
    return this.fleet.revoke(id);
  }

  @Post('hosts/:id/drain')
  @HttpCode(200)
  @Auth({ permissions: ['fleet:write'] })
  drain(@Param('id', ParseUUIDPipe) id: string, @Body() body: DrainDto): Promise<FleetCommandResult> {
    return this.fleet.command(id, { type: 'drain', enabled: body.enabled });
  }

  @Post('hosts/:id/profiles')
  @Auth({ permissions: ['fleet:write'] })
  createProfile(@Param('id', ParseUUIDPipe) id: string, @Body() body: CreateProfileDto): Promise<FleetCommandResult> {
    return this.fleet.command(id, { type: 'create_profile', profile: body.name });
  }

  @Delete('hosts/:id/profiles/:name')
  @Auth({ permissions: ['fleet:write'] })
  deleteProfile(@Param('id', ParseUUIDPipe) id: string, @Param('name') name: string): Promise<FleetCommandResult> {
    return this.fleet.command(id, { type: 'delete_profile', profile: profile(name) });
  }

  @Post('hosts/:id/profiles/:name/restart')
  @HttpCode(200)
  @Auth({ permissions: ['fleet:write'] })
  restart(@Param('id', ParseUUIDPipe) id: string, @Param('name') name: string): Promise<FleetCommandResult> {
    return this.fleet.command(id, { type: 'restart_browser', profile: profile(name) });
  }

  @Post('hosts/:id/profiles/:name/close')
  @HttpCode(200)
  @Auth({ permissions: ['fleet:write'] })
  close(@Param('id', ParseUUIDPipe) id: string, @Param('name') name: string): Promise<FleetCommandResult> {
    return this.fleet.command(id, { type: 'close_browser', profile: profile(name) });
  }
}
