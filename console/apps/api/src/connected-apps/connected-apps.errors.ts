// The typed refusals of the per-app limits (#464). One sentence per code,
// written for the person who reads it in the chat: the REST message, and the
// sentence the MCP error table (src/mcp/mcp.errors.ts) gives the model. A
// refusal is thrown BEFORE anything is written: no run row, no session.
import { ForbiddenException } from '@nestjs/common';

export const APP_LIMIT_CODES = ['APP_PAUSED', 'APP_RUN_LIMIT', 'APP_COST_LIMIT', 'APP_POLICY_NOT_ALLOWED', 'APP_DOMAIN_NOT_ALLOWED'] as const;
export type AppLimitCode = (typeof APP_LIMIT_CODES)[number];

/** Where the owner changes an app's limits. */
export const APP_SETTINGS_PLACE = 'Settings → AI apps';

/** The sentence of a refusal. */
export function appLimitSentence(code: AppLimitCode, d: { limit?: number | null; kind?: 'concurrent' | 'daily'; policyId?: string; site?: string } = {}): string {
  switch (code) {
    case 'APP_PAUSED':
      return `The user paused this app in Hexactra: it cannot start runs or browser sessions until they resume it in ${APP_SETTINGS_PLACE}.`;
    case 'APP_RUN_LIMIT':
      return d.kind === 'concurrent'
        ? `This app already has ${d.limit ?? 'the most'} runs working at once, its limit. Wait for one to finish (run_wait) or stop one; the user can raise the limit in ${APP_SETTINGS_PLACE}.`
        : `This app reached its daily limit of ${d.limit ?? 'its'} runs. The user can raise it in ${APP_SETTINGS_PLACE}.`;
    case 'APP_COST_LIMIT':
      return `This app reached its daily spending limit of $${(d.limit ?? 0).toFixed(2)}. The user can raise it in ${APP_SETTINGS_PLACE}.`;
    case 'APP_POLICY_NOT_ALLOWED':
      return `This app may not use the agent policy ${d.policyId ?? 'it named'}. Leave policy_id out to use the one the user chose for it, or ask the user to allow it in ${APP_SETTINGS_PLACE}.`;
    case 'APP_DOMAIN_NOT_ALLOWED':
      return `This app may not visit ${d.site ?? 'that site'}: the user limited the sites it may use in ${APP_SETTINGS_PLACE}.`;
  }
}

/** A refusal of a per-app limit: `403` with the code, the sentence, and the details. */
export class AppLimitError extends ForbiddenException {
  constructor(
    readonly appCode: AppLimitCode,
    details: Parameters<typeof appLimitSentence>[1] = {},
  ) {
    super({ code: appCode, message: appLimitSentence(appCode, details), details });
  }
}
