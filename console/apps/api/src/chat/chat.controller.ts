import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { ApiDataResponse } from '@marinoscar/platform-api/core';
import { Auth, CurrentUser } from '@marinoscar/platform-api/identity';

import { ChatDetailResponseDto, ChatMessageResponseDto, ChatPageResponseDto, ChatResponseDto } from '../openapi/chat.responses';
import { CreateChatDto, GetChatDto, ListChatsDto, PostMessageDto, UpdateChatDto } from './chat.schemas';
import { ChatService } from './chat.service';

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
  constructor(private readonly chats: ChatService) {}

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

  /** Send a message. 409 `CHAT_ARCHIVED` on an archived chat. */
  @Post(':id/messages')
  @ApiDataResponse(ChatMessageResponseDto)
  @Auth({ permissions: ['chat:write'] })
  post(@CurrentUser('id') userId: string, @Param('id', ParseUUIDPipe) id: string, @Body() body: PostMessageDto) {
    return this.chats.postUserMessage(userId, id, body.text);
  }
}
