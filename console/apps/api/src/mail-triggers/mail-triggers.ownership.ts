import type { ModelOwnershipDef, UserOwnedModelDef } from '@marinoscar/platform-api/core';

/**
 * A mail trigger belongs to the owner who made it (E39.8, #605). It holds the rules, never a message: an event row keeps the
 * provider's message id, the outcome and the run, no subject, address or body.
 */
export const MAIL_TRIGGERS_USER_OWNED_MODELS: readonly UserOwnedModelDef<'MailTrigger' | 'MailTriggerEvent'>[] = [
  {
    model: 'MailTrigger',
    ownerField: 'userId',
    purge: 'delete',
    export: 'include',
    rationale: "The user's email triggers: the task, the account, the match rules (senders the owner chose), the input mapping, caps, status and times. No message. Deleted with the user, part of the export.",
  },
  {
    model: 'MailTriggerEvent',
    ownerField: 'userId',
    purge: 'delete',
    export: 'include',
    rationale: "What each trigger did with a message: the provider's message id (the dedupe key), the outcome, a reason code and the run. No subject, sender or body. Deleted with the user, part of the export.",
  },
];

export const MAIL_TRIGGERS_MODEL_OWNERSHIP: readonly ModelOwnershipDef<'MailTrigger' | 'MailTriggerEvent'>[] = [
  { model: 'MailTrigger', kind: 'user', rationale: "A trigger is one owner's rule on their own mailbox; never shared." },
  { model: 'MailTriggerEvent', kind: 'user', rationale: "One owner's record of what a trigger did with a message." },
];
