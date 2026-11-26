// The remedy table (E50.10, #980), shared with the web app and the CLI: `packages/shared/diagnostics.json`. The API returns codes; the
// clients render these words. Every code a stage can return has an entry (test/diagnostics.spec.ts).
import { DIAGNOSTIC_REMEDIES, type DiagnosticRemedy } from '@app/shared';

export const REMEDY_CODES: ReadonlySet<string> = new Set(Object.keys(DIAGNOSTIC_REMEDIES));

export function remedyFor(code: string): DiagnosticRemedy | null {
  return DIAGNOSTIC_REMEDIES[code] ?? null;
}
