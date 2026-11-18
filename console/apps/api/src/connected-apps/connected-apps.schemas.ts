// Connected AI apps (#464): the per-app limits, their defaults and the wire
// shapes of `/api/connected-apps`.
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import { policyRefSchema } from '../policies/policies.schemas';
import { domainSchema } from '../tasks/tasks.schemas';
import { RUN_ORIGINS } from './request-client';

/** The defaults of a new app's limits (also the columns' defaults in `connected-apps.prisma`). */
export const APP_LIMIT_DEFAULTS = {
  policyId: null,
  allowedPolicyIds: [] as string[],
  allowedDomains: [] as string[],
  maxConcurrentRuns: 2,
  dailyRunLimit: 50,
  dailyCostLimitUsd: null,
  confirmPurchases: true,
  paused: false,
} as const;

/** The deployment's ceilings when an administrator set none (`mcp.maxConcurrentRunsPerApp`, `mcp.maxDailyRunsPerApp`). */
export const APP_CEILING_DEFAULTS = { maxConcurrentRunsPerApp: 5, maxDailyRunsPerApp: 200 } as const;

/** An app's limits, as the API returns them. */
export const appLimitsSchema = z.object({
  policyId: z.string().nullable().describe("The agent policy this app's runs use when the call names none; null: the user's default."),
  allowedPolicyIds: z.array(z.string()).describe('The only policies this app may choose; empty: any.'),
  allowedDomains: z.array(z.string()).describe("Sites this app's runs and browser sessions may visit (suffix match), on top of the task's own; empty: no extra limit."),
  maxConcurrentRuns: z.number().int().describe('Live runs and sessions this app may have at once (clamped to the deployment ceiling).'),
  dailyRunLimit: z.number().int().describe("Runs and sessions per day in the user's profile time zone (clamped to the deployment ceiling)."),
  dailyCostLimitUsd: z.number().nullable().describe('USD per day over this app\'s runs; null: no cost limit.'),
  confirmPurchases: z.boolean().describe('Ask before risky steps (purchases, submissions) even when the task does not.'),
  paused: z.boolean().describe('Refuse new runs and sessions from this app without disconnecting it.'),
});
export type AppLimits = z.infer<typeof appLimitsSchema>;

const policyList = z.array(policyRefSchema).max(20);

/** `PATCH /connected-apps/:clientId/settings`: any subset. */
export const patchAppSettingsSchema = z
  .object({
    policyId: policyRefSchema.nullable(),
    allowedPolicyIds: policyList,
    allowedDomains: z.array(domainSchema).max(50),
    maxConcurrentRuns: z.number().int().min(1).max(20),
    dailyRunLimit: z.number().int().min(1).max(1000),
    dailyCostLimitUsd: z.number().min(0.01).max(10_000).multipleOf(0.01).nullable(),
    confirmPurchases: z.boolean(),
    paused: z.boolean(),
  })
  .partial()
  .strict();
export class PatchAppSettingsDto extends createZodDto(patchAppSettingsSchema) {}

/** The limits of a run that applied when it started: recorded on the run and in its policy snapshot. */
export const runAppLimitsSchema = appLimitsSchema.omit({ paused: true }).extend({
  clientId: z.string(),
  clientName: z.string().nullable(),
  /** The policy the app's limits chose (its own default, or the first allowed one), when they did. */
  appliedPolicyId: z.string().nullable(),
});
export type RunAppLimits = z.infer<typeof runAppLimitsSchema>;

/** A scope of the app's consent, in words. */
export const appScopeSchema = z.object({
  id: z.string(),
  label: z.string().describe('A short name: "Delegate", "Tasks", "Inbox", "Drive browser", "JavaScript", "Desktop", "Policies".'),
  consent: z.string().describe('What the consent page said'),
  risk: z.enum(['low', 'elevated', 'high']),
});

/** 30-day usage, counted from runs. */
export const appUsageSchema = z.object({
  runs30d: z.number().int(),
  costUsd30d: z.number(),
  costKnown: z.boolean(),
  lastRunAt: z.string().nullable(),
  liveRuns: z.number().int(),
  runsToday: z.number().int(),
  costTodayUsd: z.number(),
});

export const connectedAppSchema = z.object({
  clientId: z.string().describe('`oauth_clients.id`'),
  grantId: z.string().nullable().describe('The active grant (what Disconnect revokes: `DELETE /api/oauth/grants/:id`); null when the app is no longer connected'),
  name: z.string().describe('The display name: the client\'s host ("chatgpt.com"), or its own name for a local app'),
  displayName: z.string().describe('"ChatGPT", "Claude", or the name'),
  selfName: z.string().nullable().describe('The name the client gives itself (self-asserted; secondary)'),
  host: z.string().nullable(),
  logoUri: z.string().nullable(),
  verified: z.boolean().describe('True: an OAuth client known to the server'),
  removed: z.boolean().describe('The client row was deleted by an administrator: its runs keep their name'),
  connectedAt: z.string().nullable(),
  lastUsedAt: z.string().nullable(),
  scopes: z.array(appScopeSchema),
  limits: appLimitsSchema,
  usage: appUsageSchema,
});
export type ConnectedAppView = z.infer<typeof connectedAppSchema>;

export const runClientSchema = z
  .object({
    id: z.string().nullable().describe('The OAuth client id; null for an unverified MCP client name'),
    name: z.string().nullable().describe('The display name at the time the run started'),
    verified: z.boolean().describe('False: a name an MCP client gave itself over a personal access token'),
  })
  .describe('The AI app that started the run; null when it was not started by an app');

export const runOriginSchema = z.enum(RUN_ORIGINS).describe('Where the run was started from: web (the console), android, cli, api, mcp (an AI app), schedule, system');
