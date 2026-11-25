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

import { BENCHMARKS_MODEL_OWNERSHIP, BENCHMARKS_USER_OWNED_MODELS } from '../benchmark/benchmark.ownership';
import { CHAT_MODEL_OWNERSHIP, CHAT_USER_OWNED_MODELS } from '../chat/chat.ownership';
import { CONNECTIONS_MODEL_OWNERSHIP, CONNECTIONS_USER_OWNED_MODELS } from '../connections/connections.ownership';
import { MAIL_TRIGGERS_MODEL_OWNERSHIP, MAIL_TRIGGERS_USER_OWNED_MODELS } from '../mail-triggers/mail-triggers.ownership';
import { CONNECTED_APPS_MODEL_OWNERSHIP, CONNECTED_APPS_USER_OWNED_MODELS } from '../connected-apps/connected-apps.ownership';
import { DELIVERIES_MODEL_OWNERSHIP, DELIVERIES_USER_OWNED_MODELS } from '../deliveries/deliveries.ownership';
import { MCP_ACTIVITY_MODEL_OWNERSHIP, MCP_ACTIVITY_USER_OWNED_MODELS } from '../mcp/mcp-activity.ownership';
import { USAGE_MODEL_OWNERSHIP, USAGE_USER_OWNED_MODELS } from '../usage/usage.ownership';
import { DOCUMENT_MODEL_OWNERSHIP, DOCUMENT_USER_OWNED_MODELS } from '../documents/documents.ownership';
import { KGRAPH_MODEL_OWNERSHIP, KGRAPH_USER_OWNED_MODELS } from '../kgraph/kgraph.ownership';
import { MEMORIES_MODEL_OWNERSHIP, MEMORIES_USER_OWNED_MODELS } from '../memories/memories.ownership';
import { APP_MODEL_OWNERSHIP, APP_USER_OWNED_MODELS } from '../notes/notes.ownership';
import { POLICIES_MODEL_OWNERSHIP, POLICIES_USER_OWNED_MODELS } from '../policies/policies.ownership';
import { APPROVALS_MODEL_OWNERSHIP, APPROVALS_USER_OWNED_MODELS } from '../approvals/approvals.ownership';
import { STORE_MODEL_OWNERSHIP, STORE_USER_OWNED_MODELS } from '../secrets/builtin/store.ownership';
import { SECRETS_MODEL_OWNERSHIP, SECRETS_USER_OWNED_MODELS } from '../secrets/secrets.ownership';
import { QUESTIONS_MODEL_OWNERSHIP, QUESTIONS_USER_OWNED_MODELS } from '../questions/questions.ownership';
import { TASKS_MODEL_OWNERSHIP, TASKS_USER_OWNED_MODELS } from '../tasks/tasks.ownership';
import { RECORDINGS_MODEL_OWNERSHIP, RECORDINGS_USER_OWNED_MODELS } from '../recordings/recordings.ownership';
import { PROFILE_SIGNIN_MODEL_OWNERSHIP, PROFILE_SIGNIN_USER_OWNED_MODELS } from '../fleet/profile-signin.ownership';
import { PERMISSION_OPTIONS } from './permissions';
// The OAuth server's MCP scopes and the `/api/mcp` protected resource (#459): registered
// here, beside the permissions they name, before bootstrap.
import '../mcp/mcp.oauth';

registerPlatformPermissions(PERMISSION_OPTIONS);
registerPlatformUserOwnedModels([...APP_USER_OWNED_MODELS, ...TASKS_USER_OWNED_MODELS, ...QUESTIONS_USER_OWNED_MODELS, ...DOCUMENT_USER_OWNED_MODELS, ...POLICIES_USER_OWNED_MODELS, ...CHAT_USER_OWNED_MODELS, ...CONNECTED_APPS_USER_OWNED_MODELS, ...MCP_ACTIVITY_USER_OWNED_MODELS, ...MEMORIES_USER_OWNED_MODELS, ...APPROVALS_USER_OWNED_MODELS, ...SECRETS_USER_OWNED_MODELS, ...STORE_USER_OWNED_MODELS, ...CONNECTIONS_USER_OWNED_MODELS, ...MAIL_TRIGGERS_USER_OWNED_MODELS, ...DELIVERIES_USER_OWNED_MODELS, ...BENCHMARKS_USER_OWNED_MODELS, ...USAGE_USER_OWNED_MODELS, ...RECORDINGS_USER_OWNED_MODELS, ...KGRAPH_USER_OWNED_MODELS, ...PROFILE_SIGNIN_USER_OWNED_MODELS]);
registerPlatformModelOwnership([...APP_MODEL_OWNERSHIP, ...TASKS_MODEL_OWNERSHIP, ...QUESTIONS_MODEL_OWNERSHIP, ...DOCUMENT_MODEL_OWNERSHIP, ...POLICIES_MODEL_OWNERSHIP, ...CHAT_MODEL_OWNERSHIP, ...CONNECTED_APPS_MODEL_OWNERSHIP, ...MCP_ACTIVITY_MODEL_OWNERSHIP, ...MEMORIES_MODEL_OWNERSHIP, ...APPROVALS_MODEL_OWNERSHIP, ...SECRETS_MODEL_OWNERSHIP, ...STORE_MODEL_OWNERSHIP, ...CONNECTIONS_MODEL_OWNERSHIP, ...MAIL_TRIGGERS_MODEL_OWNERSHIP, ...DELIVERIES_MODEL_OWNERSHIP, ...BENCHMARKS_MODEL_OWNERSHIP, ...USAGE_MODEL_OWNERSHIP, ...RECORDINGS_MODEL_OWNERSHIP, ...KGRAPH_MODEL_OWNERSHIP, ...PROFILE_SIGNIN_MODEL_OWNERSHIP]);
