// Fills the platform's static registries once, at import time, before
// bootstrap: roles and permissions (the mounted slices' and the app's), every
// platform model with a foreign key to `User` plus the app's, and every
// platform model's ownership kind plus the app's. Platform entries register
// first, so a collision names the app. Imported for its side effect by
// `src/prisma/prisma.service.ts` (before the first scoped client) and by the
// conformance spec.
import {
  registerPlatformModelOwnership,
  registerPlatformPermissions,
  registerPlatformUserOwnedModels,
} from '@marinoscar/platform-api/manifest';

import { CHAT_MODEL_OWNERSHIP, CHAT_USER_OWNED_MODELS } from '../chat/chat.ownership';
import { CONNECTED_APPS_MODEL_OWNERSHIP, CONNECTED_APPS_USER_OWNED_MODELS } from '../connected-apps/connected-apps.ownership';
import { MCP_ACTIVITY_MODEL_OWNERSHIP, MCP_ACTIVITY_USER_OWNED_MODELS } from '../mcp/mcp-activity.ownership';
import { DOCUMENT_MODEL_OWNERSHIP, DOCUMENT_USER_OWNED_MODELS } from '../documents/documents.ownership';
import { MEMORIES_MODEL_OWNERSHIP, MEMORIES_USER_OWNED_MODELS } from '../memories/memories.ownership';
import { APP_MODEL_OWNERSHIP, APP_USER_OWNED_MODELS } from '../notes/notes.ownership';
import { POLICIES_MODEL_OWNERSHIP, POLICIES_USER_OWNED_MODELS } from '../policies/policies.ownership';
import { APPROVALS_MODEL_OWNERSHIP, APPROVALS_USER_OWNED_MODELS } from '../approvals/approvals.ownership';
import { QUESTIONS_MODEL_OWNERSHIP, QUESTIONS_USER_OWNED_MODELS } from '../questions/questions.ownership';
import { TASKS_MODEL_OWNERSHIP, TASKS_USER_OWNED_MODELS } from '../tasks/tasks.ownership';
import { PERMISSION_OPTIONS } from './permissions';
// The OAuth server's MCP scopes and the `/api/mcp` protected resource (#459): registered
// here, beside the permissions they name, before bootstrap.
import '../mcp/mcp.oauth';

registerPlatformPermissions(PERMISSION_OPTIONS);
registerPlatformUserOwnedModels([...APP_USER_OWNED_MODELS, ...TASKS_USER_OWNED_MODELS, ...QUESTIONS_USER_OWNED_MODELS, ...DOCUMENT_USER_OWNED_MODELS, ...POLICIES_USER_OWNED_MODELS, ...CHAT_USER_OWNED_MODELS, ...CONNECTED_APPS_USER_OWNED_MODELS, ...MCP_ACTIVITY_USER_OWNED_MODELS, ...MEMORIES_USER_OWNED_MODELS, ...APPROVALS_USER_OWNED_MODELS]);
registerPlatformModelOwnership([...APP_MODEL_OWNERSHIP, ...TASKS_MODEL_OWNERSHIP, ...QUESTIONS_MODEL_OWNERSHIP, ...DOCUMENT_MODEL_OWNERSHIP, ...POLICIES_MODEL_OWNERSHIP, ...CHAT_MODEL_OWNERSHIP, ...CONNECTED_APPS_MODEL_OWNERSHIP, ...MCP_ACTIVITY_MODEL_OWNERSHIP, ...MEMORIES_MODEL_OWNERSHIP, ...APPROVALS_MODEL_OWNERSHIP]);
