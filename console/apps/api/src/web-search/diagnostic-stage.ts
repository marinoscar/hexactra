// The stage of a diagnostic report (epic E50 Design §4): owned by the diagnostics framework (E50.10, #980,
// `src/diagnostics/diagnostic-report.ts`) and re-exported here for the search providers. A stage holds codes, counts and timings;
// never content, a provider's message, an address or a token.
export type { DiagnosticStage, StageStatus } from '../diagnostics/diagnostic-report';
