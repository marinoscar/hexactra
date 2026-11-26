import type { ModelOwnershipDef, UserOwnedModelDef } from '@marinoscar/platform-api/core';

/** Web search usage (E50.5, #975): counts per user, day and provider. */
export const WEB_SEARCH_USER_OWNED_MODELS: readonly UserOwnedModelDef<'WebSearchUsage'>[] = [
  {
    model: 'WebSearchUsage',
    ownerField: 'userId',
    purge: 'delete',
    export: 'include',
    rationale: "How many web searches the console made for the user, per day and provider, and their estimated cost (counts only: no query, no result, no key). Deleted with the user, part of the export.",
  },
];

export const WEB_SEARCH_MODEL_OWNERSHIP: readonly ModelOwnershipDef<'WebSearchUsage'>[] = [
  { model: 'WebSearchUsage', kind: 'user', rationale: "One user's web search counts for one day and provider." },
];
