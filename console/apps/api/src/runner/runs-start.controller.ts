import { BadRequestException, Body, Controller, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ApiDataResponse } from '@marinoscar/platform-api/core';
import { ApiTags } from '@nestjs/swagger';
import { Auth, CurrentUser } from '@marinoscar/platform-api/identity';
import { JobsService } from '@marinoscar/platform-api/jobs';
import { ApiBody } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import { profileNameSchema } from '../fleet/fleet.schemas';
import { PoliciesService } from '../policies/policies.service';
import { policyRefSchema } from '../policies/policies.schemas';
import { runView } from '../policies/policy-snapshot';
import { PrismaService } from '../prisma/prisma.service';
import { TasksService } from '../tasks/tasks.service';
import { withCost } from '../tasks/run-cost';
import { enqueueGoalRun } from './goal-runner.jobs';
import { RunResponseDto } from '../openapi/console.responses';

const startRunSchema = z.object({
  goal: z.string().trim().min(1).max(4000),
  profile: profileNameSchema.default('default'),
  hostId: z.uuid().nullable().optional(),
  /** When the chosen host cannot take the run, run on another available one (#384). */
  hostFallback: z.boolean().default(true),
  policyId: policyRefSchema.optional().describe("Run under this agent policy instead of the task's or the user's default."),
});
class StartRunDto extends createZodDto(startRunSchema) {}

const runTaskSchema = z.object({
  policyId: policyRefSchema.optional().describe("Run under this agent policy for this run only (\"Run with...\"), instead of the schedule's, the task's or the user's default."),
});
class RunTaskDto extends createZodDto(runTaskSchema) {}

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
    private readonly policies: PoliciesService,
  ) {}

  /** Run a saved task now. */
  @Post('tasks/:id/runs')
  @ApiDataResponse(RunResponseDto, { status: 201 })
  @Auth({ permissions: ['runs:write'] })
  @ApiBody({ type: RunTaskDto, required: false })
  async runTask(@CurrentUser() user: Principal, @Param('id', ParseUUIDPipe) id: string, @Body() rawBody?: unknown) {
    // The body is optional (it was empty before policies): parsed here, not by the global pipe.
    const parsed = runTaskSchema.safeParse(rawBody ?? {});
    if (!parsed.success) throw new BadRequestException({ code: 'VALIDATION_ERROR', message: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') });
    const task = await this.tasks.getTask(user.id, id);
    await this.policies.assertAssignable(user.id, parsed.data.policyId);
    const run = await this.prisma.forUser({ userId: user.id }).run.create({
      data: {
        userId: user.id,
        taskId: task.id,
        goal: task.goal,
        profile: task.profile,
        hostId: task.hostId,
        hostFallback: task.hostFallback,
        trigger: 'manual',
        ...(parsed.data.policyId ? { policyRef: parsed.data.policyId, policySource: 'run' as const } : {}),
      },
      omit: { transcript: true },
    });
    await enqueueGoalRun(this.jobs, { runId: run.id, userId: user.id, orgId: user.activeOrgId ?? null }, 'run_started');
    return runView(withCost(run));
  }

  /** Run an ad-hoc goal (under the user's default agent policy unless `policyId` names one). */
  @Post('runs')
  @ApiDataResponse(RunResponseDto, { status: 201 })
  @Auth({ permissions: ['runs:write'] })
  async start(@CurrentUser() user: Principal, @Body() body: StartRunDto) {
    await this.policies.assertAssignable(user.id, body.policyId);
    const run = await this.prisma.forUser({ userId: user.id }).run.create({
      data: {
        userId: user.id,
        goal: body.goal,
        profile: body.profile,
        hostId: body.hostId ?? null,
        hostFallback: body.hostFallback,
        trigger: 'api',
        ...(body.policyId ? { policyRef: body.policyId, policySource: 'run' as const } : {}),
      },
      omit: { transcript: true },
    });
    await enqueueGoalRun(this.jobs, { runId: run.id, userId: user.id, orgId: user.activeOrgId ?? null }, 'run_started');
    return runView(withCost(run));
  }
}
