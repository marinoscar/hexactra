// `/api/tasks/{id}/mail-triggers` and `/api/mail-triggers/{id}` (E39.8, #605): start a task when a matching email arrives. Every
// route is the caller's own (another user's id is a 404). There is NO MCP tool that creates or changes a trigger: a hosted AI app
// must not be able to make the owner's mailbox start tasks (docs/parity.md).
import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { ApiDataResponse } from '@marinoscar/platform-api/core';
import { Auth, CurrentUser } from '@marinoscar/platform-api/identity';

import { MailTriggersService } from './mail-triggers.service';
import {
  CreateMailTriggerDto,
  MailTriggerEventResponseDto,
  MailTriggerEventsQueryDto,
  MailTriggerResponseDto,
  MailTriggerTestResponseDto,
  UpdateMailTriggerDto,
} from './mail-triggers.schemas';

@ApiTags('Mail triggers')
@Controller()
export class MailTriggersController {
  constructor(private readonly triggers: MailTriggersService) {}

  @Get('tasks/:id/mail-triggers')
  @ApiOperation({ summary: "A task's email triggers", description: 'The rules, the account, the status and how many runs each started today. Never a message.' })
  @ApiDataResponse(MailTriggerResponseDto, { isArray: true })
  @Auth({ permissions: ['runs:read'] })
  list(@CurrentUser('id') userId: string, @Param('id', ParseUUIDPipe) taskId: string) {
    return this.triggers.list(userId, taskId);
  }

  @Post('tasks/:id/mail-triggers')
  @ApiOperation({
    summary: 'Start this task when a matching email arrives',
    description:
      "The trigger watches one of your connected accounts (`mail_read` on) and starts one run per matching message that arrives after the trigger was created. `match.from` is required: an exact address or one domain (a domain anybody can have an address at is refused). A message that fails the provider's sender check starts nothing. The run has the task's own settings; the message text is never part of its goal. 400 `MAIL_TRIGGER_CONNECTION_INVALID`, `MAIL_TRIGGER_INPUTS_INVALID`, `MAIL_TRIGGER_POLL_TOO_FAST`; 409 `MAIL_TRIGGER_LIMIT`.",
  })
  @ApiDataResponse(MailTriggerResponseDto, { status: 201 })
  @Auth({ permissions: ['runs:write'] })
  create(@CurrentUser('id') userId: string, @Param('id', ParseUUIDPipe) taskId: string, @Body() body: CreateMailTriggerDto) {
    return this.triggers.create(userId, taskId, body);
  }

  @Patch('mail-triggers/:id')
  @ApiOperation({ summary: 'Change or switch an email trigger on or off', description: 'A field left out is unchanged. Enabling again starts from now: mail that arrived while it was off never fires. Changing the account starts from now too.' })
  @ApiDataResponse(MailTriggerResponseDto)
  @Auth({ permissions: ['runs:write'] })
  update(@CurrentUser('id') userId: string, @Param('id', ParseUUIDPipe) id: string, @Body() body: UpdateMailTriggerDto) {
    return this.triggers.update(userId, id, body);
  }

  @Delete('mail-triggers/:id')
  @HttpCode(204)
  @ApiOperation({ summary: 'Delete an email trigger', description: 'Its event history goes with it; runs it started are kept.' })
  @Auth({ permissions: ['runs:write'] })
  async remove(@CurrentUser('id') userId: string, @Param('id', ParseUUIDPipe) id: string): Promise<void> {
    await this.triggers.remove(userId, id);
  }

  @Post('mail-triggers/:id/test')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Show what would match, without starting anything',
    description: 'Reads the last 5 messages of the account that match the rules and says for each whether it would start a run. Subjects are cut to 60 characters. 409 `MAIL_TRIGGER_CONNECTION_UNAVAILABLE` (with `details.reason`) when the mailbox cannot be read.',
  })
  @ApiDataResponse(MailTriggerTestResponseDto)
  @Auth({ permissions: ['runs:write'] })
  test(@CurrentUser('id') userId: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.triggers.test(userId, id);
  }

  @Get('mail-triggers/:id/events')
  @ApiOperation({ summary: 'What a trigger did with the messages it saw', description: 'Newest first: `started` (with the run), or skipped (`skipped_unverified`, `skipped_limit`, `skipped_loop`) or `failed`, each with a reason code. No subject or sender is stored.' })
  @ApiDataResponse(MailTriggerEventResponseDto, { isArray: true })
  @Auth({ permissions: ['runs:read'] })
  events(@CurrentUser('id') userId: string, @Param('id', ParseUUIDPipe) id: string, @Query() q: MailTriggerEventsQueryDto) {
    return this.triggers.eventsOf(userId, id, q);
  }
}
