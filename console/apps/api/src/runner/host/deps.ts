// What the host's bindings need from the NestJS service: its collaborators, as one plain object built for each job.
import type { Logger } from '@nestjs/common';
import type { AiService } from '@marinoscar/platform-api/ai';
import type { SystemSettingsService } from '@marinoscar/platform-api/settings';

import type { ApprovalRulesService } from '../../approvals/approval-rules.service';
import type { FabricClient } from '../../fabric/fabric.client';
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
  /** The wall clock; tests replace it to pass time without waiting. */
  clock: () => number;
  log: Logger;
}
