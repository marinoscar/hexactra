// Binds the feature-gated MCP scopes' availability check (mcp.scope-availability.ts) to the Knowledge Graph's switches (#916).
import { Injectable, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';

import { KgraphEnabledService } from '../kgraph/kgraph-enabled.service';
import { bindScopeFeatureCheck } from './mcp.scope-availability';

/**
 * Binds `scopeFeatureAvailable` to the Knowledge Graph's switches, the same ones `McpDispatcher.unavailableFeatures`
 * reads for the tools: with a user, the deployment's and the user's switches (`status().available`); without one (the
 * metadata documents and `/authorize`, before anyone signs in), the deployment's switch alone. No Knowledge Graph
 * module bound: unavailable.
 */
@Injectable()
export class McpScopeAvailabilityBinder implements OnModuleInit, OnModuleDestroy {
  constructor(@Optional() private readonly kgraph?: KgraphEnabledService) {}

  onModuleInit(): void {
    const kgraph = this.kgraph;
    if (!kgraph) {
      bindScopeFeatureCheck(null);
      return;
    }
    bindScopeFeatureCheck(async (feature, ctx) => {
      if (feature !== 'kgraph') return false;
      if (ctx.userId) return (await kgraph.status(ctx.userId)).available;
      return (await kgraph.systemSettingsOf()).enabled;
    });
  }

  onModuleDestroy(): void {
    bindScopeFeatureCheck(null);
  }
}
