import { Global, Module } from '@nestjs/common';

import { DiagnosticsHistory } from './diagnostics-history.service';
import { DiagnosticsMetrics } from './diagnostics.metrics';
import { DiagnosticsRegistry } from './diagnostics.registry';

/**
 * Diagnostics (E50.10, #980): the one report shape for everything the console connects to, the registry of the providers that
 * diagnose their own targets, the history (`connection_diagnostics`) and the counter. Global, so a provider module (Google,
 * Microsoft, MCP, web search) registers its `Diagnosable` without importing this. The connection routes are in
 * `src/connections/connection-diagnostics.controller.ts`.
 */
@Global()
@Module({
  providers: [DiagnosticsRegistry, DiagnosticsHistory, DiagnosticsMetrics],
  exports: [DiagnosticsRegistry, DiagnosticsHistory, DiagnosticsMetrics],
})
export class DiagnosticsModule {}
