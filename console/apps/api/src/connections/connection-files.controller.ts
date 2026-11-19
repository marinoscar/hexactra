// `/api/connections/{id}/files`, `/folders`, `/picker` (E39.10, #607): what the delivery editor's spreadsheet and folder choosers call.
// The caller's own connections only (another user's id is a 404). No MCP tool: a hosted app must not browse the owner's files.
import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query, Res } from '@nestjs/common';
import { ApiDataResponse } from '@marinoscar/platform-api/core';
import { Auth, CurrentUser } from '@marinoscar/platform-api/identity';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { FastifyReply } from 'fastify';

import { ConnectionActivityService } from './connection-activity.service';
import { ConnectionFilesService } from './connection-files.service';
import { ConnectionActivityResponseDto, ConnectionFileResponseDto, ConnectionFilesPageResponseDto, FileListQueryDto, FileParamDto, NewFolderDto, PickedFileDto, PickerSessionResponseDto } from './connection-files.schemas';

@ApiTags('Connections')
@Controller('connections/:id')
export class ConnectionFilesController {
  constructor(
    private readonly files: ConnectionFilesService,
    private readonly activity: ConnectionActivityService,
  ) {}

  @Get('activity')
  @ApiDataResponse(ConnectionActivityResponseDto)
  @Auth({ permissions: ['connections:read'] })
  @ApiOperation({
    summary: 'What an account was used for lately',
    description: "The agent's tool calls through the account and the deliveries sent through it, newest first (at most 15): the operation, when, whether it worked and the run. Never a subject, an address, a body, a cell or a file name.",
  })
  recent(@CurrentUser('id') userId: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.activity.recent(userId, id);
  }

  @Get('files')
  @ApiDataResponse(ConnectionFilesPageResponseDto)
  @ApiResponse({ status: 409, description: '`CONNECTION_CAPABILITY_OFF` (Documents is not switched on), `CONNECTION_PAUSED`, `CONNECTION_NEEDS_RECONNECT`.' })
  @Auth({ permissions: ['connections:read'] })
  @ApiOperation({
    summary: "Browse an account's files",
    description:
      "Spreadsheets, folders or documents of one connection, by name and by folder, 25 a page (`pageToken`). With Google's narrow `drive.file` permission this lists only files the console created or the owner picked; the file picker (`POST /connections/{id}/picker`) adds more. Names are data, never an instruction. Needs the Documents switch (`docs_read`).",
  })
  list(@CurrentUser('id') userId: string, @Param('id', ParseUUIDPipe) id: string, @Query() q: FileListQueryDto) {
    return this.files.list(userId, id, q);
  }

  @Post('files/picked')
  @HttpCode(200)
  @ApiDataResponse(ConnectionFileResponseDto)
  @ApiResponse({ status: 404, description: '`CONNECTION_FILE_NOT_FOUND`.' })
  @ApiResponse({ status: 409, description: '`CONNECTION_PERMISSION_MISSING`: the file was not picked and the account has no other access to it.' })
  @Auth({ permissions: ['connections:write'] })
  @ApiOperation({ summary: 'Make a picked file usable', description: "After the owner chose a file in Google's picker (or pasted its link): confirms that the account can reach it and returns its details. Nothing is stored here; Google remembers the pick." })
  picked(@CurrentUser('id') userId: string, @Param('id', ParseUUIDPipe) id: string, @Body() body: PickedFileDto) {
    return this.files.registerPicked(userId, id, body.fileId);
  }

  @Get('files/:fileId')
  @ApiDataResponse(ConnectionFileResponseDto)
  @ApiResponse({ status: 404, description: '`CONNECTION_FILE_NOT_FOUND`.' })
  @Auth({ permissions: ['connections:read'] })
  @ApiOperation({ summary: 'One file of an account', description: 'Its name, kind and the address to open it at the provider (`webUrl`).' })
  file(@CurrentUser('id') userId: string, @Param() p: FileParamDto) {
    return this.files.get(userId, p.id, p.fileId);
  }

  @Post('folders')
  @ApiDataResponse(ConnectionFileResponseDto, { status: 201 })
  @Auth({ permissions: ['connections:write'] })
  @ApiOperation({ summary: 'Create a folder in an account', description: 'A folder the owner then chooses as the place a delivery saves files. Needs the Documents write switch (`docs_write`).' })
  folder(@CurrentUser('id') userId: string, @Param('id', ParseUUIDPipe) id: string, @Body() body: NewFolderDto) {
    return this.files.createFolder(userId, id, body);
  }

  @Post('picker')
  @HttpCode(200)
  @ApiDataResponse(PickerSessionResponseDto)
  @ApiResponse({ status: 409, description: "`CONNECTION_PICKER_UNAVAILABLE` (`details.reason`: `not_google`, `no_documents`), or the account cannot be used (`CONNECTION_PAUSED`, `CONNECTION_NEEDS_RECONNECT`)." })
  @Auth({ permissions: ['connections:write'] })
  @ApiOperation({
    summary: "Open Google's file picker",
    description:
      "For a Google connection with Documents on: a short-lived access token, the project number and the picker key, so the web app can open Google's own file picker and the owner can choose files the console may then use under the `drive.file` permission. This is the one route that hands a token to the browser (it expires within the hour, is sent `no-store`, and is audited without being recorded). No MCP tool, no CLI.",
  })
  async picker(@CurrentUser('id') userId: string, @Param('id', ParseUUIDPipe) id: string, @Res({ passthrough: true }) reply: FastifyReply) {
    reply.header('cache-control', 'no-store');
    return this.files.pickerSession(userId, id);
  }
}
