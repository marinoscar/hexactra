// The MCP endpoint's metrics, exported through OTLP like the run metrics
// (tasks/run-metrics.ts). Labels are bounded enums: the method, the protocol
// revision, a client bucket, the credential kind and the outcome; the tool
// name only on the tool histogram (a closed list). Never a token, an
// argument value, a result or a user.
import { Injectable, Optional } from '@nestjs/common';
import { AppMetricsService } from '@marinoscar/platform-api/host';
import { registerAppMetrics, type AppMetricDef } from '@marinoscar/platform-api/otel-core';

import { CLIENT_BUCKETS, SUPPORTED_VERSIONS } from './mcp.protocol';
import { MCP_TOOLS } from './mcp.tools';

/** Methods counted by name; anything else is `other`. */
export const MCP_METRIC_METHODS = ['initialize', 'ping', 'server/discover', 'tools/list', 'tools/call', 'resources/list', 'resources/read', 'notification', 'batch', 'refused'] as const;
const CREDENTIALS = ['jwt', 'pat', 'node', 'oauth', 'none'] as const;
const OUTCOME = ['true', 'false'] as const;

/** Names are permanent once dashboards read them (the platform requires the `app.` prefix). */
export const MCP_METRICS: readonly AppMetricDef[] = [
  {
    key: 'mcpRequests',
    name: 'app.mcp.requests',
    kind: 'counter',
    unit: '{message}',
    description: 'JSON-RPC messages the MCP endpoint answered, by method, protocol revision, client bucket, credential kind and error.',
    attributes: {
      method: { kind: 'enum', values: MCP_METRIC_METHODS },
      protocol_version: { kind: 'enum', values: SUPPORTED_VERSIONS },
      client: { kind: 'enum', values: CLIENT_BUCKETS },
      credential: { kind: 'enum', values: CREDENTIALS },
      is_error: { kind: 'enum', values: OUTCOME },
    },
  },
  {
    key: 'mcpToolDuration',
    name: 'app.mcp.tool.duration',
    kind: 'histogram',
    unit: 's',
    description: 'Wall time of one MCP tool call, by tool, client bucket and error.',
    buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120, 240],
    attributes: {
      tool: { kind: 'enum', values: MCP_TOOLS.map((t) => t.name) },
      client: { kind: 'enum', values: CLIENT_BUCKETS },
      credential: { kind: 'enum', values: CREDENTIALS },
      is_error: { kind: 'enum', values: OUTCOME },
    },
  },
];
registerAppMetrics(MCP_METRICS);

/** Records the MCP metrics; a no-op where the host has no metrics service (unit tests). */
@Injectable()
export class McpMetrics {
  constructor(@Optional() private readonly metrics?: AppMetricsService) {}

  message(labels: { method: string; protocolVersion: string; client: string; credential: string; isError: boolean }): void {
    this.metrics?.add('mcpRequests', 1, {
      method: labels.method,
      protocol_version: labels.protocolVersion,
      client: labels.client,
      credential: labels.credential,
      is_error: String(labels.isError),
    });
  }

  tool(labels: { tool: string; client: string; credential: string; isError: boolean }, seconds: number): void {
    if (seconds >= 0) this.metrics?.record('mcpToolDuration', seconds, { tool: labels.tool, client: labels.client, credential: labels.credential, is_error: String(labels.isError) });
  }
}
