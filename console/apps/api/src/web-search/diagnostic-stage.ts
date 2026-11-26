// The stage of a diagnostic report (epic E50 Design §4). LOCAL until the diagnostics framework (E50.10, #980) is on main: it then
// owns this shape in `src/diagnostics/diagnostic-report.ts` and this file re-exports it. A stage holds codes, counts and timings;
// never content, a provider's message, an address or a token.
export type StageStatus = 'pass' | 'warn' | 'fail' | 'skipped';

export interface DiagnosticStage {
  /** `config`, `address`, `sign_in`, `live_query`, ... */
  id: string;
  status: StageStatus;
  /** Closed vocabulary, `/^[A-Z][A-Z_]{0,39}$/`, never provider text. */
  code: string | null;
  /** A key of the remedy table, rendered by the client. */
  remedy: string | null;
  ms: number | null;
  /** Counts, a host name, an API id; never content, an address or a token. */
  data?: Record<string, string | number | boolean>;
}
