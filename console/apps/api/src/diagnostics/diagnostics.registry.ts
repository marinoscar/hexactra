// Which provider diagnoses its own targets (E50.10, #980): a `Diagnosable` per target kind and provider id. Google and Microsoft (E50.11)
// and MCP servers (E50.12) register here at start up; a connection whose provider registered nothing falls back to the per-capability
// probes of `POST /api/connections/{id}/test` (connection-diagnostics.service.ts), so every connection has a report from day one.
import { Injectable } from '@nestjs/common';

import type { Diagnosable, DiagnosticTargetKind } from './diagnostic-report';

@Injectable()
export class DiagnosticsRegistry {
  private readonly entries = new Map<string, Diagnosable<unknown>>();

  register<T>(kind: DiagnosticTargetKind, provider: string, d: Diagnosable<T>): void {
    this.entries.set(`${kind}:${provider}`, d as Diagnosable<unknown>);
  }

  get<T>(kind: DiagnosticTargetKind, provider: string): Diagnosable<T> | undefined {
    return this.entries.get(`${kind}:${provider}`) as Diagnosable<T> | undefined;
  }

  /** Every registered code (the remedy-table test reads it). */
  codes(): string[] {
    return [...new Set([...this.entries.values()].flatMap((d) => d.codes))];
  }
}
