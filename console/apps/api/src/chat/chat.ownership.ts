import type { ModelOwnershipDef, UserOwnedModelDef } from '@marinoscar/platform-api/core';

/** A conversation belongs to the user who started it (ChatMessage follows its Conversation). */
export const CHAT_USER_OWNED_MODELS: readonly UserOwnedModelDef<'Conversation'>[] = [
  {
    model: 'Conversation',
    ownerField: 'userId',
    purge: 'delete',
    export: 'include',
    rationale: "The user's chats and their messages (never a secret): deleted with the user, part of the export.",
  },
];

export const CHAT_MODEL_OWNERSHIP: readonly ModelOwnershipDef<'Conversation' | 'ChatMessage'>[] = [
  { model: 'Conversation', kind: 'user', rationale: 'A chat belongs to the user who started it.' },
  { model: 'ChatMessage', kind: 'user', rationale: 'A message belongs to its conversation, reached only through it.' },
];
