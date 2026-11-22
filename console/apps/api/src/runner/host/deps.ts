// What the host's bindings need from the NestJS service: its collaborators, as one plain object built for each job.
import type { Logger } from '@nestjs/common';
import type { AiService } from '@marinoscar/platform-api/ai';
import type { SystemSettingsService } from '@marinoscar/platform-api/settings';

import type { CapabilityHub } from '../../connections/capability-hub';
import type { McpRunService } from '../../connections/mcp/mcp-run.service';
import type { ApprovalRulesService } from '../../approvals/approval-rules.service';
import type { FabricClient } from '../../fabric/fabric.client';
import type { KgraphAfterRun } from '../../kgraph/kgraph-compile.job';
import type { KgraphEnabledService } from '../../kgraph/kgraph-enabled.service';
import type { PrismaProcedureStore } from '../../kgraph/prisma-procedure-store';
import type { KgraphSiteFactsService } from '../../kgraph/site-facts.service';
import type { MemoryContext } from '../../memories/memory-context';
import type { MemoryProposals } from '../../memories/memory-proposals.service';
import type { ModelTiersService } from '../../policies/model-tiers.service';
import type { PolicyModelCheck } from '../../policies/policy-model-check';
import type { PolicyResolver } from '../../policies/policy.resolver';
import type { PrismaService } from '../../prisma/prisma.service';
import type { QuestionsService } from '../../questions/questions.service';
import type { RunSecretsService } from '../../secrets/run-secrets.service';
import type { RunArtifactStore } from '../../tasks/run-delete.service';
import type { RunNotifier } from '../../tasks/run-notifier';
import type { RunTraceService } from '../../tasks/run-trace.service';
import type { TasksService } from '../../tasks/tasks.service';

export interface HostDeps {
  prisma: PrismaService;
  tasks: TasksService;
  fabric: FabricClient;
  ai: AiService;
  notifier?: RunNotifier;
  questions?: QuestionsService;
  systemSettings?: SystemSettingsService;
  policies?: PolicyResolver;
  modelCheck?: PolicyModelCheck;
  modelTiers?: ModelTiersService;
  /** Where the masked trace screenshots go (#541); absent without the storage slice, and then none is taken. */
  artifacts?: RunArtifactStore;
  memoryContext?: MemoryContext;
  proposals?: MemoryProposals;
  /** Saved approvals (#555): the owner's standing answers, matched by the server. Absent: every step asks. */
  approvals?: ApprovalRulesService;
  /** The owner's secrets providers (E37.3): absent without the secrets module, and then no run signs in from a saved login. */
  secrets?: RunSecretsService;
  /** The owner's connections (E39.7): the provider-neutral mail, calendar and documents of one connection. Absent without the connections module: then no run is offered a connection tool. */
  connections?: Pick<CapabilityHub, 'mail' | 'calendar' | 'documents'>;
  /** The owner's MCP servers (E39.9): the tools a run may be offered and calling one. Absent without the connections module. */
  mcp?: Pick<McpRunService, 'toolsFor' | 'call' | 'check' | 'exactSecrets'>;
  /** The run's trace and PDF report (E35): `file_upload` hands the report to a connection. */
  traces?: Pick<RunTraceService, 'exportPdf'>;
  /** The Knowledge Graph's gate (E46): absent, or `off` for the run, and nothing watches its tool calls. */
  kgraph?: Pick<KgraphEnabledService, 'modeFor' | 'systemSettingsOf'> & Partial<Pick<KgraphEnabledService, 'everydayFor' | 'countError'>>;
  /** The Knowledge Graph's store (E46.9): absent, and no run replays a procedure. */
  kgraphStore?: PrismaProcedureStore;
  /** The owner's site facts (E46.31, E46.32): absent, and no run is given site facts or offered `propose_site_fact` and `site_facts`. */
  kgraphSiteFacts?: Pick<KgraphSiteFactsService, 'propose' | 'activeFor' | 'offeredTo' | 'recordOffered' | 'markUsed' | 'afterRun'>;
  /** After a run's final transition (E46.7): enqueues the compile job when the run was captured. Best effort. */
  kgraphAfterRun?: Pick<KgraphAfterRun, 'finished'>;
  /** The wall clock; tests replace it to pass time without waiting. */
  clock: () => number;
  log: Logger;
}
