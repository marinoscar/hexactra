import { Injectable, type OnModuleInit } from '@nestjs/common';
import { DoctorCheckRegistry, type DoctorCheck, type DoctorCheckOutcome } from '@marinoscar/platform-api/doctor';
import { Prisma } from '@prisma/client';

import { PrismaSystemService } from '../../prisma/prisma-system.service';
import { BROWSER_AGENT_FEATURE_ID } from '../../runner/browser-agent.feature';

/** The window the check compares, in days. */
export const LEDGER_WINDOW_DAYS = 7;
/** Below this share of the runs' own input tokens, the ledger is missing rows. */
export const LEDGER_MIN_SHARE = 0.5;

/** What the check reads: the runs' own counters and the AI usage ledger, over the same window. */
export interface LedgerStats {
  /** Input tokens the browser-agent runs counted themselves (`runs.input_tokens`). */
  runInputTokens: number;
  /** Ledger rows for model calls (`operation = 'responses'`). */
  responseRows: number;
  /** Of those, rows with no input token count. */
  responseRowsWithoutTokens: number;
  /** Input tokens the ledger holds for the browser agent. */
  ledgerAgentInputTokens: number;
  /** Ledger rows of catalogue syncs (no tokens, by design). */
  catalogRows: number;
}

/**
 * The verdict, pure. Fails when runs used tokens but the ledger has (almost)
 * none: the AI usage report, its cost and the per-feature split are then
 * wrong. #731 was that case: every model call's row was dropped because the
 * app's Prisma client had no `forOrg`.
 */
export function ledgerVerdict(s: LedgerStats): DoctorCheckOutcome {
  const data = { windowDays: LEDGER_WINDOW_DAYS, ...s };
  const share = s.runInputTokens > 0 ? s.ledgerAgentInputTokens / s.runInputTokens : null;
  if (s.runInputTokens > 0 && (share ?? 0) < LEDGER_MIN_SHARE) {
    return {
      status: 'fail',
      detail:
        `In the last ${LEDGER_WINDOW_DAYS} days runs used ${s.runInputTokens} input tokens, but the AI usage ledger holds ${s.ledgerAgentInputTokens} for the browser agent. ` +
        'Model calls are not being recorded: Administration → AI Usage under-reports tokens and cost. Look for "Could not record AI usage" in the API log.',
      data,
    };
  }
  if (s.responseRows > 0 && s.responseRowsWithoutTokens === s.responseRows) {
    return {
      status: 'warn',
      detail: `The ${s.responseRows} model call(s) recorded in the last ${LEDGER_WINDOW_DAYS} days carry no token counts: the provider reports no usage, so cost cannot be computed.`,
      data,
    };
  }
  if (s.responseRows === 0) {
    return { status: 'skip', detail: `No model calls in the last ${LEDGER_WINDOW_DAYS} days (${s.catalogRows} catalogue sync(s), which carry no tokens).`, data };
  }
  return {
    status: 'pass',
    detail: `${s.responseRows} model call(s) recorded with tokens in the last ${LEDGER_WINDOW_DAYS} days${share === null ? '' : `; the ledger matches ${Math.round(share * 100)}% of the runs' own input tokens`}.`,
    data,
  };
}

/**
 * `ai.usage_ledger` in the admin Doctor (`GET /api/admin/doctor`): whether the
 * AI usage ledger (`ai_usage_events`, behind Administration → AI Usage) records
 * the model calls the runs made. Read-only: aggregate reads through the system
 * client, never a row's content.
 */
@Injectable()
export class AiUsageLedgerDoctorCheck implements DoctorCheck, OnModuleInit {
  readonly id = 'ai.usage_ledger';
  readonly category = 'ai';
  readonly label = 'AI usage recording';

  constructor(
    private readonly registry: DoctorCheckRegistry,
    private readonly system: PrismaSystemService,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async run(): Promise<DoctorCheckOutcome> {
    const db = this.system.asSystem('admin-aggregate');
    const since = new Date(Date.now() - LEDGER_WINDOW_DAYS * 86_400_000);
    const [ledger] = await db.$queryRaw<{ response_rows: number; without_tokens: number; agent_input: number; catalog_rows: number }[]>(Prisma.sql`
      SELECT
        count(*) FILTER (WHERE operation = 'responses')::int AS response_rows,
        count(*) FILTER (WHERE operation = 'responses' AND input_tokens IS NULL)::int AS without_tokens,
        coalesce(sum(input_tokens) FILTER (WHERE operation = 'responses' AND feature = ${BROWSER_AGENT_FEATURE_ID}), 0)::float8 AS agent_input,
        count(*) FILTER (WHERE operation = 'catalog')::int AS catalog_rows
      FROM ai_usage_events
      WHERE created_at >= ${since}
    `);
    const [runs] = await db.$queryRaw<{ input: number }[]>(Prisma.sql`
      SELECT coalesce(sum(input_tokens), 0)::float8 AS input FROM runs WHERE created_at >= ${since}
    `);
    return ledgerVerdict({
      runInputTokens: Number(runs?.input ?? 0),
      responseRows: Number(ledger?.response_rows ?? 0),
      responseRowsWithoutTokens: Number(ledger?.without_tokens ?? 0),
      ledgerAgentInputTokens: Number(ledger?.agent_input ?? 0),
      catalogRows: Number(ledger?.catalog_rows ?? 0),
    });
  }
}
