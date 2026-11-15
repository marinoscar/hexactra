import { Body, Controller, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Auth, CurrentUser } from '@marinoscar/platform-api/identity';
import { JobsService } from '@marinoscar/platform-api/jobs';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import { profileNameSchema } from '../fleet/fleet.schemas';
import { PrismaService } from '../prisma/prisma.service';
import { TasksService } from '../tasks/tasks.service';
import { enqueueGoalRun } from './goal-runner.jobs';

const startRunSchema = z.object({
  goal: z.string().trim().min(1).max(4000),
  profile: profileNameSchema.default('default'),
  hostId: z.uuid().nullable().optional(),
});
class StartRunDto extends createZodDto(startRunSchema) {}

interface Principal {
  id: string;
  activeOrgId?: string | null;
}

/** Starting runs: from a task, or an ad-hoc goal. */
@ApiTags('Runs')
@Controller()
export class RunsStartController {
  constructor(
    private readonly tasks: TasksService,
    private readonly prisma: PrismaService,
    private readonly jobs: JobsService,
  ) {}

  /** Run a saved task now. */
  @Post('tasks/:id/runs')
  @Auth({ permissions: ['runs:write'] })
  async runTask(@CurrentUser() user: Principal, @Param('id', ParseUUIDPipe) id: string) {
    const task = await this.tasks.getTask(user.id, id);
    const run = await this.prisma.forUser({ userId: user.id }).run.create({
      data: { userId: user.id, taskId: task.id, goal: task.goal, profile: task.profile, hostId: task.hostId, trigger: 'manual' },
      omit: { transcript: true },
    });
    await enqueueGoalRun(this.jobs, { runId: run.id, userId: user.id, orgId: user.activeOrgId ?? null }, 'started');
    return run;
  }

  /** Run an ad-hoc goal (default policy: any http(s) site, 40 steps, 15 minutes). */
  @Post('runs')
  @Auth({ permissions: ['runs:write'] })
  async start(@CurrentUser() user: Principal, @Body() body: StartRunDto) {
    const run = await this.prisma.forUser({ userId: user.id }).run.create({
      data: { userId: user.id, goal: body.goal, profile: body.profile, hostId: body.hostId ?? null, trigger: 'api' },
      omit: { transcript: true },
    });
    await enqueueGoalRun(this.jobs, { runId: run.id, userId: user.id, orgId: user.activeOrgId ?? null }, 'started');
    return run;
  }
}
