import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { ApiDataResponse } from '@marinoscar/platform-api/core';
import { Auth, CurrentUser } from '@marinoscar/platform-api/identity';

import { GetChatDto, PostMessageDto } from '../chat/chat.schemas';
import { ChatMessageResponseDto } from '../openapi/chat.responses';
import { TaskBuilderDetailResponseDto, TaskBuilderResponseDto, TaskBuilderSpecResponseDto } from '../openapi/task-builder.responses';
import { CreateTaskBuilderDto, PatchTaskSpecDto } from './task-builder.schemas';
import { TaskBuilderService } from './task-builder.service';
import type { TaskBuilderSpecPatch } from './task-builder.spec.schema';

interface Principal {
  id: string;
  activeOrgId?: string | null;
}

/**
 * `/api/task-builder` (E42, #717): the AI task builder. It interviews the
 * owner and keeps a live task spec; nothing here starts a run or saves a task.
 * A builder's live updates are the chat stream (`GET /chats/:id/stream`).
 */
@ApiTags('Task builder')
@Controller('task-builder')
export class TaskBuilderController {
  constructor(private readonly builders: TaskBuilderService) {}

  /** Start a builder. With `seed`, the builder answers that first message at once. */
  @Post()
  @ApiDataResponse(TaskBuilderResponseDto)
  @Auth({ permissions: ['tasks:write'] })
  create(@CurrentUser() user: Principal, @Body() body: CreateTaskBuilderDto) {
    return this.builders.create(user, body);
  }

  /** The builder with its spec and its messages, oldest first. `afterSeq` returns only newer messages. */
  @Get(':id')
  @ApiDataResponse(TaskBuilderDetailResponseDto)
  @Auth({ permissions: ['tasks:write'] })
  get(@CurrentUser('id') userId: string, @Param('id', ParseUUIDPipe) id: string, @Query() q: GetChatDto) {
    return this.builders.get(userId, id, q.afterSeq);
  }

  /** Send the owner's message; the builder's answer arrives as later messages. 409 `TASK_BUILDER_ARCHIVED` once its task is saved. */
  @Post(':id/messages')
  @ApiDataResponse(ChatMessageResponseDto)
  @Auth({ permissions: ['tasks:write'] })
  post(@CurrentUser() user: Principal, @Param('id', ParseUUIDPipe) id: string, @Body() body: PostMessageDto) {
    return this.builders.postMessage(user, id, body.text);
  }

  /** The owner changes the spec directly: any top-level field, `null` clears one. Answers the whole spec. */
  @Patch(':id/spec')
  @ApiDataResponse(TaskBuilderSpecResponseDto)
  @Auth({ permissions: ['tasks:write'] })
  patchSpec(@CurrentUser('id') userId: string, @Param('id', ParseUUIDPipe) id: string, @Body() body: PatchTaskSpecDto) {
    return this.builders.patchSpec(userId, id, body as unknown as TaskBuilderSpecPatch);
  }
}
