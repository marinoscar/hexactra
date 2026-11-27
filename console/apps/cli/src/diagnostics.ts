// A diagnostic report in a terminal (E50.15, #985): the same report the Connections and Web search pages show (E50.10), as one line per
// stage (a mark, the stage's title, its code in words) with the remedy under a stage that failed or warned. The words come from the
// remedy table the API and the web app share (`packages/shared/diagnostics.json`); the API returns codes only. Pure, except
// `runDiagnostic`, which turns a call that could not be made into exit code 2.
import { DIAGNOSTIC_REMEDIES } from '@app/shared';
import { CliError } from '@marinoscar/platform-cli/commands';

export type StageStatus = 'pass' | 'warn' | 'fail' | 'skipped';

/** One stage of `DiagnosticReport` (`apps/api/src/diagnostics/diagnostic-report.ts`). */
export interface DiagnosticStageView {
  id: string;
  status: StageStatus;
  code: string | null;
  remedy: string | null;
  ms: number | null;
  data?: Record<string, string | number | boolean>;
}

/** A report as `POST /api/connections/{id}/diagnose` and the other diagnose routes return it: codes and counts only. */
export interface DiagnosticReportView {
  id: string;
  target: { kind: string; id: string };
  trigger: string;
  overall: StageStatus;
  startedAt: string;
  finishedAt: string;
  stages: DiagnosticStageView[];
}

/** The summary row of `GET /api/connections/diagnostics/summary`. */
export interface DiagnosticSummaryView {
  targetId: string;
  overall: StageStatus;
  at: string;
}

/** Exit codes of the diagnose commands: 0 for pass or warn, 1 for a failed stage, 2 when the command could not run. */
export const DIAGNOSE_EXIT = { OK: 0, FAILED: 1, COULD_NOT_RUN: 2 } as const;

/** The command could not run (not logged in, the server refused the call, a network error): exit code 2, the API's words. */
export class DiagnoseCouldNotRun extends CliError {
  readonly exitCode = DIAGNOSE_EXIT.COULD_NOT_RUN;
}

const MARK: Record<StageStatus, string> = { pass: 'ok  ', warn: 'warn', fail: 'FAIL', skipped: 'skip' };

/** The stages the console's diagnostics name, in words; another id is shown as its own words (`sign_in` → `Sign in`). */
const STAGE_TITLES: Record<string, string> = {
  status: 'Connection status',
  provider_installed: 'Installed and switched on here',
  sign_in: 'Sign-in',
  server: 'The MCP server',
  latency: 'Time taken',
  app_config: "The deployment's app",
  redirect_uri: 'Redirect address',
  discovery: "The provider's sign-in endpoints",
  client_check: 'Client id and secret',
  picker_key: 'File picker key',
  switch: 'Switched on',
  address: 'Address',
  network: 'Network',
  initialize: 'MCP handshake',
  tool_list: 'Tool list',
  tool_changes: 'Tool changes',
  enabled_tools: 'Tools switched on',
  offered_cap: 'Tools offered to a run',
  switches: 'Switched on',
  provider: 'Provider',
  credential: 'Key',
  credential_tier: 'Key',
  live_query: 'A live search',
  daily_limit: "Today's limit",
  limit: "Today's limit",
  limits: "Today's limit",
  fetch: 'Reading pages',
  web_fetch: 'Reading pages',
};

export function stageTitle(id: string): string {
  if (STAGE_TITLES[id]) return STAGE_TITLES[id];
  const [head, tail] = id.split(':');
  if (head === 'capability' && tail) return `Capability ${tail}`;
  const words = id.replace(/[:_]+/g, ' ').trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** A stage's line, and under it the remedy when the stage failed or warned. */
export function stageLines(s: DiagnosticStageView): string[] {
  const entry = s.code ? DIAGNOSTIC_REMEDIES[s.code] : undefined;
  const code = s.code ? `  (${s.code}: ${entry?.title ?? 'Failed'})` : '';
  const ms = s.ms !== null && s.status !== 'skipped' ? `  ${s.ms} ms` : '';
  const lines = [`${MARK[s.status]}  ${stageTitle(s.id)}${code}${ms}`];
  const remedy = (s.remedy ? DIAGNOSTIC_REMEDIES[s.remedy] : undefined) ?? entry;
  if ((s.status === 'fail' || s.status === 'warn') && remedy) lines.push(`      ${remedy.remedy}${remedy.who === 'admin' ? ' (your administrator can fix this)' : ''}`);
  return lines;
}

/** The whole report: its stages in order, then the overall result. */
export function reportLines(r: DiagnosticReportView, name?: string): string[] {
  const lines = r.stages.flatMap(stageLines);
  const overall = r.overall === 'pass' ? 'Everything passed' : r.overall === 'warn' ? 'Passed, with warnings' : r.overall === 'fail' ? 'Failed' : 'Nothing was checked';
  lines.push(`${overall}${name ? `: ${name}` : ''} (${r.finishedAt.replace('T', ' ').slice(0, 19)} UTC)`);
  return lines;
}

/** 0 for pass or warn (or nothing to check), 1 for a failed stage. */
export function reportExitCode(r: Pick<DiagnosticReportView, 'overall'>): number {
  return r.overall === 'fail' ? DIAGNOSE_EXIT.FAILED : DIAGNOSE_EXIT.OK;
}

/** One line of a report history: when, the overall result, who ran it and the first failing stage. */
export function historyLine(r: DiagnosticReportView): string {
  const failing = r.stages.find((s) => s.status === 'fail') ?? r.stages.find((s) => s.status === 'warn');
  const what = failing ? `  ${stageTitle(failing.id)}${failing.code ? ` (${failing.code})` : ''}` : '';
  return `${r.finishedAt.replace('T', ' ').slice(0, 19)}  ${r.overall.padEnd(7)}  ${r.trigger.padEnd(10)}${what}`;
}

/** The word a HEALTH column shows for the last report of a connection. */
export function healthWord(s: DiagnosticSummaryView | undefined): string {
  if (!s) return 'not checked';
  return s.overall === 'pass' ? 'ok' : s.overall === 'skipped' ? 'not checked' : s.overall;
}

/** Runs a diagnose call; a call that could not be made becomes `DiagnoseCouldNotRun` (exit code 2). */
export async function runDiagnostic<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (e) {
    throw new DiagnoseCouldNotRun(e instanceof Error ? e.message : String(e));
  }
}
