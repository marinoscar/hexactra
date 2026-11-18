import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { ApiDataResponse } from '@marinoscar/platform-api/core';
import { Auth, CurrentUser } from '@marinoscar/platform-api/identity';

import { ChatDetailResponseDto, ChatMessageResponseDto, ChatPageResponseDto, ChatResponseDto, ChatTaskDraftResponseDto } from '../openapi/chat.responses';
import { ChatTaskDraftService } from './chat-task-draft.service';
import { CreateChatDto, GetChatDto, LinkTaskDto, ListChatsDto, PostMessageDto, UpdateChatDto } from './chat.schemas';
import { ChatService } from './chat.service';
import { ChatTurnQueue } from './chat-turn.job';

interface Principal {
  id: string;
  activeOrgId?: string | null;
}

/**
 * `/api/chats`: the signed-in user's own chats (#483). A chat is a thread; a
 * job it starts is an ordinary run (`runs.conversationId`). Every route
 * declares `@Auth()` with the exact permission the web declares.
 */
@ApiTags('Chats')
@Controller('chats')
export class ChatController {
  constructor(
    private readonly chats: ChatService,
    private readonly turns: ChatTurnQueue,
    private readonly drafts: ChatTaskDraftService,
  ) {}

  /** One page of chats, most recently active first: `{ items, nextCursor }`. Rows carry a preview, never the messages. */
  @Get()
  @ApiDataResponse(ChatPageResponseDto)
  @Auth({ permissions: ['chat:read'] })
  list(@CurrentUser('id') userId: string, @Query() q: ListChatsDto) {
    return this.chats.list(userId, q);
  }

  @Post()
  @ApiDataResponse(ChatResponseDto)
  @Auth({ permissions: ['chat:write'] })
  create(@CurrentUser('id') userId: string, @Body() body: CreateChatDto) {
    return this.chats.create(userId, body);
  }

  /** The chat with its messages, oldest first. `afterSeq` returns only what is newer. */
  @Get(':id')
  @ApiDataResponse(ChatDetailResponseDto)
  @Auth({ permissions: ['chat:read'] })
  get(@CurrentUser('id') userId: string, @Param('id', ParseUUIDPipe) id: string, @Query() q: GetChatDto) {
    return this.chats.get(userId, id, q.afterSeq);
  }

  /** Rename, archive or unarchive (`status`), or change the run settings. */
  @Patch(':id')
  @ApiDataResponse(ChatResponseDto)
  @Auth({ permissions: ['chat:write'] })
  update(@CurrentUser('id') userId: string, @Param('id', ParseUUIDPipe) id: string, @Body() body: UpdateChatDto) {
    return this.chats.update(userId, id, body);
  }

  /** Delete the chat, its messages and its runs. 409 `CHAT_RUN_LIVE` while a run of it is live. */
  @Delete(':id')
  @HttpCode(204)
  @Auth({ permissions: ['chat:write'] })
  async remove(@CurrentUser() user: Principal, @Param('id', ParseUUIDPipe) id: string): Promise<void> {
    await this.chats.remove(user.id, id, { orgId: user.activeOrgId ?? null });
  }

  /** Send a message. The AI's answer arrives as later messages (a `chat.turn` job). 409 `CHAT_ARCHIVED` on an archived chat. */
  @Post(':id/messages')
  @ApiDataResponse(ChatMessageResponseDto)
  @Auth({ permissions: ['chat:write'] })
  async post(@CurrentUser() user: Principal, @Param('id', ParseUUIDPipe) id: string, @Body() body: PostMessageDto) {
    const message = await this.chats.postUserMessage(user.id, id, body.text);
    await this.turns.request(id, user.id, user.activeOrgId ?? null);
    return message;
  }

  /**
   * Draft a reusable task from the chat (#489): the AI writes a name and a
   * standalone goal from the conversation; the rest is the chat's run
   * settings. Nothing is saved: the owner reviews it in the task form.
   */
  @Post(':id/task-draft')
  @HttpCode(200)
  @ApiDataResponse(ChatTaskDraftResponseDto)
  @Auth({ permissions: ['chat:read', 'tasks:write'] })
  draft(@CurrentUser() user: Principal, @Param('id', ParseUUIDPipe) id: string) {
    return this.drafts.draft(user.id, id, user.activeOrgId ?? null);
  }

  /** Note in the thread that a task was saved from the chat: a line with the task's name, linked by `meta.taskId`. */
  @Post(':id/task-link')
  @ApiDataResponse(ChatMessageResponseDto)
  @Auth({ permissions: ['chat:write', 'tasks:read'] })
  link(@CurrentUser('id') userId: string, @Param('id', ParseUUIDPipe) id: string, @Body() body: LinkTaskDto) {
    return this.chats.linkTask(userId, id, body.taskId);
  }
}
