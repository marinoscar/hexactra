// =============================================================================
// The user-data manifest: what a data reset keeps and deletes (issue #880)
// =============================================================================
//
// The platform's categories, model hints and factory reset steps come first
// (`registerPlatformUserData()`); everything below is the app's DATA. This is
// the only file you edit when a model gains an owner column or the reset needs
// an extra step: the Danger Zone, the factory reset, the organization
// offboarding and the data export pick the entries up with no code change.
// The `userData` conformance suite (test/conformance.spec.ts) and the Doctor's
// `user-data.registries` check fail until every user-owned model (see
// `src/notes/notes.ownership.ts`) has an entry here.
// =============================================================================

import {
  registerFactoryResetStep,
  registerOffboardingPrecondition,
  registerPlatformUserData,
  registerUserDataCategory,
  registerUserDataModels,
  registerUserDataScope,
  type FactoryResetStepDef,
  type OffboardingPreconditionDef,
  type UserDataCategoryDef,
  type UserDataModelHint,
  type UserDataScopeDef,
} from '@marinoscar/platform-api/user-data';
import type { Prisma } from '@prisma/client';

/** The app's categories: the Danger Zone rows, and what a scope selects. */
export const APP_USER_DATA_CATEGORIES: readonly UserDataCategoryDef[] = [
  { id: 'notes', label: 'Notes', description: 'Every note you wrote.', content: true },
  { id: 'documents', label: 'Documents', description: 'Every document you wrote.', content: true },
  { id: 'memories', label: 'Memories', description: 'Every fact you let the agent use (people, accounts, preferences), with their earlier versions.', content: true },
  { id: 'saved-logins', label: 'Saved logins', description: "The logins you saved in Hexactra's built-in store, their earlier versions and your encryption key. Deleting them is permanent: nothing can decrypt them afterwards.", content: true },
  { id: 'kgraph', label: 'Knowledge Graph', description: 'What the agent learned from your saved tasks: procedures, their versions and evidence, your site facts, and your Knowledge Graph choices per task and run.', content: true },
  { id: 'browser-tasks', label: 'Browser tasks and runs', description: 'Your browser tasks, their runs, the steps the agents took, the videos of the runs you recorded, the questions they asked you, your chats, your agent policies, your limits for connected AI apps and what those apps did, your saved approvals, your email triggers with what they did, the benchmarks you started, and the guided profile sign-ins you started on your nodes.', content: true },
];

/** One keep-or-delete decision per user-owned model. */
export const APP_USER_DATA_MODELS: readonly UserDataModelHint<Prisma.ModelName>[] = [
  { model: 'Note', category: 'notes' },
  { model: 'Document', category: 'documents' },
  { model: 'Task', category: 'browser-tasks' },
  { model: 'Run', category: 'browser-tasks' },
  { model: 'TaskSchedule', category: 'browser-tasks' },
  { model: 'Question', category: 'browser-tasks' },
  { model: 'AgentPolicy', category: 'browser-tasks' },
  { model: 'Conversation', category: 'browser-tasks' },
  { model: 'ConnectedAppSettings', category: 'browser-tasks' },
  { model: 'McpActivity', category: 'browser-tasks' },
  { model: 'Memory', category: 'memories' },
  { model: 'ApprovalRule', category: 'browser-tasks' },
  { model: 'SecretsConnection', category: 'credentials' },
  { model: 'Secret', category: 'saved-logins' },
  { model: 'SecretVersion', category: 'saved-logins' },
  { model: 'SecretType', category: 'saved-logins' },
  { model: 'SecretsStoreDataKey', category: 'saved-logins' },
  { model: 'SecretsStoreCallbackToken', category: 'saved-logins' },
  { model: 'PasskeyCredential', category: 'saved-logins' },
  { model: 'MediaFolder', category: 'saved-logins' },
  { model: 'BackupRun', category: 'saved-logins' },
  { model: 'BackupSchedule', category: 'saved-logins' },
  { model: 'AgentCardGrant', category: 'saved-logins' },
  { model: 'AgentCardGrantRequest', category: 'saved-logins' },
  { model: 'SecretsActivity', category: 'credentials' },
  { model: 'Connection', category: 'credentials' },
  { model: 'ConnectionFlow', category: 'credentials' },
  // A connection's diagnostic reports (E50.10): with the connections.
  { model: 'ConnectionDiagnostic', category: 'credentials' },
  { model: 'TaskDelivery', category: 'browser-tasks' },
  { model: 'RunDelivery', category: 'browser-tasks' },
  { model: 'DeliveryRecipient', category: 'browser-tasks' },
  { model: 'MailTrigger', category: 'browser-tasks' },
  { model: 'MailTriggerEvent', category: 'browser-tasks' },
  { model: 'Benchmark', category: 'browser-tasks' },
  // A run's video (epic #755): with its run.
  { model: 'RunRecording', category: 'browser-tasks' },
  // The Knowledge Graph (epic E46).
  { model: 'KgTaskSettings', category: 'kgraph' },
  { model: 'KgRun', category: 'kgraph' },
  { model: 'KgNode', category: 'kgraph' },
  { model: 'KgEdge', category: 'kgraph' },
  { model: 'KgProcedure', category: 'kgraph' },
  { model: 'KgProcedureVersion', category: 'kgraph' },
  { model: 'KgEvidence', category: 'kgraph' },
  { model: 'KgReview', category: 'kgraph' },
  { model: 'KgTrace', category: 'kgraph' },
  { model: 'KgLedger', category: 'kgraph' },
  { model: 'KgSiteFact', category: 'kgraph' },
  // The guided profile sign-ins a person started (E48.4): host, profile and outcome, no email.
  { model: 'ProfileSigninSession', category: 'browser-tasks' },
  // AI usage summed per hour (#732): the same category as the ledger it sums (`AiUsageEvent`).
  { model: 'AiUsageHourly', category: 'ai' },
  // Web search counts per day and provider (E50.5): with the AI usage they sit next to.
  { model: 'WebSearchUsage', category: 'ai' },
];

/** Narrow scopes, such as "delete my notes" (none by default: the built-in scopes cover every category). */
export const APP_USER_DATA_SCOPES: readonly UserDataScopeDef[] = [];

/** Extra factory reset steps, for data the model registry cannot describe. */
export const APP_FACTORY_RESET_STEPS: readonly FactoryResetStepDef[] = [];

/** Checks that must pass before an organization may be offboarded. */
export const APP_OFFBOARDING_PRECONDITIONS: readonly OffboardingPreconditionDef[] = [];

registerPlatformUserData();
APP_USER_DATA_CATEGORIES.forEach(registerUserDataCategory);
registerUserDataModels(APP_USER_DATA_MODELS);
APP_USER_DATA_SCOPES.forEach(registerUserDataScope);
APP_FACTORY_RESET_STEPS.forEach(registerFactoryResetStep);
APP_OFFBOARDING_PRECONDITIONS.forEach(registerOffboardingPrecondition);
