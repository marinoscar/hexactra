// Saved approvals (#554): the request and response shapes of `/api/approval-rules`.
// There is deliberately no create body: a rule is made only by the owner's tick on
// a server-issued question (`ApprovalRulesService.createFromAnswer`).
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import { APPROVAL_RULE_KINDS } from './approval-match';

/** How many recent uses a rule keeps. */
export const APPROVAL_RULE_USES_KEPT = 200;
/** How many uses `GET /api/approval-rules/{id}` returns. */
export const APPROVAL_RULE_USES_SHOWN = 20;
/** The largest amount limit a rule can carry (the column is DECIMAL(12, 2)). */
export const APPROVAL_MAX_AMOUNT = 9_999_999_999.99;

export const listApprovalRulesQuerySchema = z.object({
  host: z.string().trim().toLowerCase().max(253).optional().describe('Only rules for this registrable domain ("bankofamerica.com").'),
  enabled: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => (v === undefined ? undefined : v === 'true'))
    .describe('Only enabled (`true`) or disabled (`false`) rules.'),
});
export class ListApprovalRulesQueryDto extends createZodDto(listApprovalRulesQuerySchema) {}

/**
 * A patch may only NARROW a rule: set or lower `maxAmount`, set or shorten `expiresAt`, add a task or chat
 * scope, or disable it. Re-enabling a rule the owner disabled is allowed. Anything that would widen it is
 * `400 RULE_CANNOT_WIDEN`. At least one field.
 */
export const patchApprovalRuleSchema = z
  .object({
    enabled: z.boolean().optional().describe('Disable (`false`) or re-enable (`true`) the rule.'),
    maxAmount: z.number().positive().max(APPROVAL_MAX_AMOUNT).nullable().optional().describe('The largest amount the rule allows. May be set or lowered; `null` (removing it) is refused when one is set.'),
    expiresAt: z.iso.datetime({ offset: true }).nullable().optional().describe('When the rule stops matching. May be set or brought forward; `null` (removing it) is refused when one is set.'),
    taskId: z.uuid().nullable().optional().describe('Limit the rule to one task. May be added; removing or changing a scope is refused.'),
    conversationId: z.uuid().nullable().optional().describe('Limit the rule to one chat. May be added; removing or changing a scope is refused.'),
  })
  .strict()
  .refine((v) => Object.values(v).some((x) => x !== undefined), { message: 'Send at least one field.' });
export class PatchApprovalRuleDto extends createZodDto(patchApprovalRuleSchema) {}
export type PatchApprovalRule = z.infer<typeof patchApprovalRuleSchema>;

export const setApprovalsPausedSchema = z.object({ paused: z.boolean().describe('`true` turns every saved approval off until it is set back to `false`.') }).strict();
export class SetApprovalsPausedDto extends createZodDto(setApprovalsPausedSchema) {}

export const approvalRuleSchema = z.object({
  id: z.uuid(),
  kind: z.enum(APPROVAL_RULE_KINDS).describe('`gate`: a step the server stops for (a commitment). `ask`: a question the agent would ask on its own.'),
  host: z.string().describe('The registrable domain it applies on.'),
  category: z.string().nullable().describe('For `gate`: payment, purchase, send, delete or submit.'),
  matchKey: z.string().describe("For `gate`: the element's label, normalised (digits as `#`). For `ask`: the topic."),
  summary: z.string().describe("What the rule allows, in plain words: \"Press 'Pay' on bankofamerica.com\"."),
  taskId: z.uuid().nullable().describe('When set, only runs of this task.'),
  taskName: z.string().nullable().describe("The task's name, when the scope's task still exists."),
  conversationId: z.uuid().nullable().describe('When set, only runs of this chat.'),
  maxAmount: z.number().nullable().describe('When set, only steps whose amount is known and not larger. Always set for a card rule (E37.7).'),
  cardRef: z.string().nullable().describe('A saved card (E37.7): `<provider>:<item id>`. Such a rule is for paying with that one card on this site, up to `maxAmount` in the currency of its match key (`saved card usd`); null for every other rule.'),
  expiresAt: z.string().nullable(),
  enabled: z.boolean(),
  createdFromQuestionId: z.uuid().nullable().describe('The question whose answer made the rule.'),
  useCount: z.number().int(),
  lastUsedAt: z.string().nullable(),
  lastUsedRunId: z.uuid().nullable().describe('The run that last used it, while that run exists.'),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export class ApprovalRuleResponseDto extends createZodDto(approvalRuleSchema) {}
export type ApprovalRuleView = z.infer<typeof approvalRuleSchema>;

export const approvalRuleUseSchema = z.object({
  runId: z.uuid().nullable().describe('The run, while it exists.'),
  stepSeq: z.number().int().nullable(),
  usedAt: z.string(),
});

export const approvalRuleDetailSchema = approvalRuleSchema.extend({
  uses: z.array(approvalRuleUseSchema).describe(`The newest ${APPROVAL_RULE_USES_SHOWN} uses.`),
});
export class ApprovalRuleDetailResponseDto extends createZodDto(approvalRuleDetailSchema) {}
export type ApprovalRuleDetailView = z.infer<typeof approvalRuleDetailSchema>;

export const approvalsListSchema = z.object({
  paused: z.boolean().describe('Whether "Pause all" is on: while it is, no rule matches.'),
  rules: z.array(approvalRuleSchema),
});
export class ApprovalRulesListResponseDto extends createZodDto(approvalsListSchema) {}
export type ApprovalRulesList = z.infer<typeof approvalsListSchema>;

export const approvalsPausedSchema = z.object({ paused: z.boolean() });
export class ApprovalsPausedResponseDto extends createZodDto(approvalsPausedSchema) {}
