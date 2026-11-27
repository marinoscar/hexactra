import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ApiDataResponse } from '@marinoscar/platform-api/core';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Auth, CurrentUser } from '@marinoscar/platform-api/identity';

import { ImprovementListResponseDto, ImprovementRequestedResponseDto, ImprovementResponseDto } from '../openapi/task-improver.responses';
import { AppliedDto, RequestImprovementDto } from './task-improver.schemas';
import { TaskImproverService } from './task-improver.service';

/** "Improve this task" (E52.8, #1023). No route here changes a task: only the owner's Save in the task form does. */
@ApiTags('Tasks')
@Controller()
export class TaskImproverController {
  constructor(private readonly improver: TaskImproverService) {}

  @Post('tasks/:id/improvements')
  @HttpCode(202)
  @ApiOperation({
    summary: 'Propose a better goal for a task',
    description:
      "Queues a proposal (E52.8): an AI reads the task's recent finished runs (default the 5 newest; `runIds`: 1 to 10 of its finished runs) and proposes a better goal, each change cited to steps. It never changes the task. 400 `INVALID_RUNS` / `NO_FINISHED_RUNS`; 409 `IMPROVEMENT_RUNNING` while one is being made; 429 `IMPROVEMENT_LIMIT` above 20 a day; 404 when the task is not yours or the feature is off. Permission `tasks:write`.",
  })
  @ApiDataResponse(ImprovementRequestedResponseDto)
  @Auth({ permissions: ['tasks:write'] })
  request(@CurrentUser() user: { id: string; orgId?: string | null }, @Param('id', ParseUUIDPipe) id: string, @Body() body: RequestImprovementDto) {
    return this.improver.request(user.id, user.orgId ?? null, id, body?.runIds);
  }

  @Get('tasks/:id/improvements')
  @ApiOperation({ summary: "A task's proposals", description: 'Newest first, at most 50, without their changes. Permission `tasks:read`.' })
  @ApiDataResponse(ImprovementListResponseDto)
  @Auth({ permissions: ['tasks:read'] })
  async list(@CurrentUser('id') userId: string, @Param('id', ParseUUIDPipe) id: string) {
    return { items: await this.improver.list(userId, id) };
  }

  @Get('task-improvements/:id')
  @ApiOperation({ summary: 'One proposal', description: 'With its summary, proposed goal, changes and their evidence, and site facts. Permission `tasks:read`.' })
  @ApiDataResponse(ImprovementResponseDto)
  @Auth({ permissions: ['tasks:read'] })
  get(@CurrentUser('id') userId: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.improver.get(userId, id);
  }

  @Post('task-improvements/:id/dismiss')
  @HttpCode(200)
  @ApiOperation({ summary: 'Dismiss a proposal', description: 'A `ready` proposal becomes `dismissed`. Permission `tasks:write`.' })
  @ApiDataResponse(ImprovementResponseDto)
  @Auth({ permissions: ['tasks:write'] })
  dismiss(@CurrentUser('id') userId: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.improver.dismiss(userId, id);
  }

  @Post('task-improvements/:id/applied')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Record that a proposed goal was saved',
    description:
      "Marks a `ready` proposal `applied` and stores the goal the owner saved. It does NOT change the task: the web calls it after the task form's own save, and it is refused (409 `GOAL_NOT_SAVED`) unless the task's goal is the one given. Permission `tasks:write`.",
  })
  @ApiDataResponse(ImprovementResponseDto)
  @Auth({ permissions: ['tasks:write'] })
  applied(@CurrentUser('id') userId: string, @Param('id', ParseUUIDPipe) id: string, @Body() body: AppliedDto) {
    return this.improver.applied(userId, id, body.goal);
  }
}
