// Request and response shapes of the file routes of a connection (E39.10, #607): what the delivery editor's spreadsheet and folder
// choosers call. They speak the provider-neutral `FileInfo` of the documents capability; nothing is provider specific, and no response
// carries a token (the picker route carries one short-lived access token, on purpose: see `ConnectionFilesService.pickerSession`).
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

const control = /^[^\u0000-\u001f\u007f]+$/;
const iso = z.string().describe('ISO 8601 timestamp');
const fileId = z.string().min(1).max(512).regex(control, 'No control characters');

export const fileListQuerySchema = z
  .object({
    q: z.string().trim().max(200).optional().describe('Words in the name.'),
    type: z.enum(['spreadsheet', 'folder', 'document', 'any']).optional().describe('Default `any`.'),
    folderId: fileId.optional().describe('Only what is directly in this folder.'),
    pageToken: z.string().min(1).max(2048).optional().describe("The `nextPageToken` of the previous page (the provider's own token)."),
  })
  .strict();
export class FileListQueryDto extends createZodDto(fileListQuerySchema) {}

export const fileParamSchema = z.object({ id: z.string().uuid(), fileId });
export class FileParamDto extends createZodDto(fileParamSchema) {}

export const pickedFileSchema = z.object({ fileId }).strict();
export class PickedFileDto extends createZodDto(pickedFileSchema) {}

export const newFolderSchema = z
  .object({
    name: z.string().trim().min(1).max(200).regex(control, 'No control characters'),
    parentId: fileId.optional().describe('Create it inside this folder (default: the root, or the app folder where the provider has one).'),
  })
  .strict();
export class NewFolderDto extends createZodDto(newFolderSchema) {}

export const connectionFileSchema = z.object({
  id: z.string(),
  name: z.string(),
  kind: z.enum(['document', 'spreadsheet', 'folder', 'pdf', 'other']),
  mimeType: z.string(),
  size: z.number().int().nullable(),
  modifiedAt: iso.nullable(),
  webUrl: z.string().nullable().describe('Where the owner can open it at the provider.'),
  parentId: z.string().nullable(),
});
export class ConnectionFileResponseDto extends createZodDto(connectionFileSchema) {}

export const connectionFilesPageSchema = z.object({ items: z.array(connectionFileSchema), nextPageToken: z.string().nullable() });
export class ConnectionFilesPageResponseDto extends createZodDto(connectionFilesPageSchema) {}

export const pickerSessionSchema = z.object({
  accessToken: z.string().describe("A short-lived Google access token for the browser's file picker. Never stored, logged or cached by the console; it expires on its own."),
  appId: z.string().nullable().describe("The Google Cloud project number (the picker's `setAppId`), derived from the administrator's client id; null when it cannot be."),
  apiKey: z.string().nullable().describe("The browser API key the administrator set for the picker (a public key restricted to this console's address); null when none is set."),
  expiresAt: iso.nullable(),
});
export class PickerSessionResponseDto extends createZodDto(pickerSessionSchema) {}
