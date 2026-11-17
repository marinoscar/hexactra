import { BadRequestException, ConflictException, ForbiddenException, Injectable, InternalServerErrorException, Logger, NotFoundException, PreconditionFailedException } from '@nestjs/common';
import { UserSettingsService } from '@marinoscar/platform-api/settings';
import { Prisma } from '@prisma/client';

import './policies.errors';
import { PrismaService } from '../prisma/prisma.service';
import { agentPolicySpecSchema, hasNoHardStop, type AgentPolicySpec } from './agent-policy.schema';
import { BUILTIN_POLICIES, SYSTEM_DEFAULT_POLICY_REF, builtinPolicy, cloneSpec, parsePolicyRef } from './builtin-policies';
import { legacyPolicyName, legacyTaskSpec, type LegacyTaskLimits } from './legacy-task-policy';
import { PolicyModelCheck } from './policy-model-check';
import { browserAgentSettingsSchema } from './policies.settings';
import type { CreatePolicyDto, UpdatePolicyDto } from './policies.schemas';

/** A policy as the service hands it around: a built-in or one of the user's own. */
export interface PolicyRecord {
  /** The reference: a UUID, or `builtin:<key>`. */
  id: string;
  name: string;
  description: string | null;
  version: number;
  builtin: boolean;
  spec: AgentPolicySpec;
  createdAt: Date | null;
  updatedAt: Date | null;
}

/** A policy as the API returns it. */
export interface PolicyView extends PolicyRecord {
  isDefault: boolean;
  usage: { tasks: number; schedules: number };
  hasNoHardStop: boolean;
}

const MAX_NAME = 100;

/**
 * Agent policies (#401): the user's own, always through `forUser()`, plus the
 * four built-ins (code, `builtin:<key>`). Resolution of which policy a run
 * runs under is `PolicyResolver`; this service owns the rows, their validation
 * and the user's default.
 */
@Injectable()
export class PoliciesService {
  private readonly log = new Logger(PoliciesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly modelCheck: PolicyModelCheck,
    private readonly settings: UserSettingsService,
  ) {}

  private db(userId: string) {
    return this.prisma.forUser({ userId });
  }

  // ---- Reading ----

  /** The policy a reference names for this user (a built-in, or one of their own), or null. Never throws for a missing policy. */
  async find(userId: string, ref: string): Promise<PolicyRecord | null> {
    const kind = parsePolicyRef(ref);
    if (!kind) return null;
    if (kind.kind === 'builtin') {
      const b = builtinPolicy(ref)!;
      return { id: b.id, name: b.name, description: b.description, version: b.version, builtin: true, spec: cloneSpec(b.spec), createdAt: null, updatedAt: null };
    }
    const row = await this.db(userId).agentPolicy.findFirst({ where: { id: kind.id } });
    return row ? this.record(row) : null;
  }

  /** Like `find`, but 404 `POLICY_NOT_FOUND`. */
  async require(userId: string, ref: string): Promise<PolicyRecord> {
    const p = await this.find(userId, ref);
    if (!p) throw new NotFoundException({ code: 'POLICY_NOT_FOUND', message: 'Policy not found' });
    return p;
  }

  /** Validates a stored row's spec on read: a row that no longer parses is a server fault, never silently used. */
  private record(row: { id: string; name: string; description: string | null; version: number; spec: unknown; createdAt: Date; updatedAt: Date }): PolicyRecord {
    const spec = agentPolicySpecSchema.safeParse(row.spec);
    if (!spec.success) {
      this.log.error(`policy ${row.id}: the stored spec is invalid: ${spec.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
      throw new InternalServerErrorException({ code: 'POLICY_SPEC_INVALID', message: 'The stored policy is not valid' });
    }
    return { id: row.id, name: row.name, description: row.description, version: row.version, builtin: false, spec: spec.data, createdAt: row.createdAt, updatedAt: row.updatedAt };
  }

  /** The user's chosen default reference (read without creating a settings row); null when none was chosen. */
  async readDefaultRef(userId: string): Promise<string | null> {
    const row = await this.prisma.userSettings.findUnique({ where: { userId }, select: { value: true } });
    const parsed = browserAgentSettingsSchema.safeParse((row?.value as { browserAgent?: unknown } | null | undefined)?.browserAgent);
    return parsed.success ? parsed.data.defaultPolicyRef : null;
  }

  private async usage(userId: string): Promise<{ tasks: Map<string, number>; schedules: Map<string, number> }> {
    const [tasks, schedules] = await Promise.all([
      this.prisma.task.groupBy({ by: ['policyRef'], where: { userId, policyRef: { not: null } }, _count: { _all: true } }),
      this.prisma.taskSchedule.groupBy({ by: ['policyRef'], where: { userId, policyRef: { not: null } }, _count: { _all: true } }),
    ]);
    const toMap = (rows: { policyRef: string | null; _count: { _all: number } }[]) => new Map(rows.map((r) => [r.policyRef as string, r._count._all]));
    return { tasks: toMap(tasks), schedules: toMap(schedules) };
  }

  private view(p: PolicyRecord, defaultRef: string, usage: { tasks: Map<string, number>; schedules: Map<string, number> }): PolicyView {
    return { ...p, isDefault: p.id === defaultRef, usage: { tasks: usage.tasks.get(p.id) ?? 0, schedules: usage.schedules.get(p.id) ?? 0 }, hasNoHardStop: hasNoHardStop(p.spec) };
  }

  /** Built-ins, then the user's own by name, each with `isDefault`, `usage` and `hasNoHardStop`. */
  async list(userId: string): Promise<PolicyView[]> {
    const [rows, defaultRef, usage] = await Promise.all([this.db(userId).agentPolicy.findMany({ orderBy: { name: 'asc' } }), this.readDefaultRef(userId), this.usage(userId)]);
    const effective = defaultRef ?? SYSTEM_DEFAULT_POLICY_REF;
    const own: PolicyRecord[] = [];
    for (const r of rows) {
      try {
        own.push(this.record(r));
      } catch {
        // One broken row must not hide the others; it is logged by `record`.
      }
    }
    const builtins = BUILTIN_POLICIES.map<PolicyRecord>((b) => ({ id: b.id, name: b.name, description: b.description, version: b.version, builtin: true, spec: cloneSpec(b.spec), createdAt: null, updatedAt: null }));
    return [...builtins, ...own].map((p) => this.view(p, effective, usage));
  }

  async get(userId: string, ref: string): Promise<PolicyView> {
    const p = await this.require(userId, ref);
    const [defaultRef, usage] = await Promise.all([this.readDefaultRef(userId), this.usage(userId)]);
    return this.view(p, defaultRef ?? SYSTEM_DEFAULT_POLICY_REF, usage);
  }

  // ---- Writing ----

  /** 400 `POLICY_PIN_INVALID` for a pin that is not an enabled model with tools and vision. */
  private async assertPins(userId: string, spec: AgentPolicySpec): Promise<void> {
    const problems = await this.modelCheck.check(userId, spec);
    if (problems.length > 0) {
      throw new BadRequestException({ code: 'POLICY_PIN_INVALID', message: problems.map((p) => `${p.tier}: ${p.message}`).join('; '), details: { pins: problems } });
    }
  }

  private static isUniqueViolation(e: unknown): boolean {
    return e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002';
  }

  private nameTaken(name: string): ConflictException {
    return new ConflictException({ code: 'POLICY_NAME_TAKEN', message: `You already have a policy named "${name}"` });
  }

  async create(userId: string, input: CreatePolicyDto): Promise<PolicyView> {
    await this.assertPins(userId, input.spec);
    try {
      const row = await this.db(userId).agentPolicy.create({
        data: { userId, name: input.name, description: input.description ?? null, spec: input.spec as Prisma.InputJsonValue },
      });
      return this.get(userId, row.id);
    } catch (e) {
      if (PoliciesService.isUniqueViolation(e)) throw this.nameTaken(input.name);
      throw e;
    }
  }

  /**
   * Edit a policy of the user. `expectedVersion` (the `If-Match` header) makes
   * the write conditional: 412 `POLICY_VERSION_CONFLICT` when the stored version
   * moved. A spec change bumps `version`; a rename or a new description does too
   * (the version is the row's). Built-ins answer 403 `POLICY_BUILTIN_READONLY`.
   */
  async update(userId: string, ref: string, patch: UpdatePolicyDto, expectedVersion?: number): Promise<PolicyView> {
    const kind = parsePolicyRef(ref);
    if (!kind) throw new NotFoundException({ code: 'POLICY_NOT_FOUND', message: 'Policy not found' });
    if (kind.kind === 'builtin') throw new ForbiddenException({ code: 'POLICY_BUILTIN_READONLY', message: 'Built-in policies cannot be edited: duplicate one to change a copy' });
    const current = await this.require(userId, ref);
    if (expectedVersion !== undefined && expectedVersion !== current.version) {
      throw new PreconditionFailedException({ code: 'POLICY_VERSION_CONFLICT', message: 'The policy changed since you loaded it', details: { version: current.version } });
    }
    if (patch.spec) await this.assertPins(userId, patch.spec);
    try {
      // Compare-and-set on the version, so two editors cannot both win.
      const { count } = await this.db(userId).agentPolicy.updateMany({
        where: { id: kind.id, version: current.version },
        data: {
          ...(patch.name !== undefined ? { name: patch.name } : {}),
          ...(patch.description !== undefined ? { description: patch.description } : {}),
          ...(patch.spec ? { spec: patch.spec as Prisma.InputJsonValue } : {}),
          version: { increment: 1 },
        },
      });
      if (count === 0) {
        const now = await this.find(userId, ref);
        if (!now) throw new NotFoundException({ code: 'POLICY_NOT_FOUND', message: 'Policy not found' });
        throw new PreconditionFailedException({ code: 'POLICY_VERSION_CONFLICT', message: 'The policy changed since you loaded it', details: { version: now.version } });
      }
    } catch (e) {
      if (PoliciesService.isUniqueViolation(e)) throw this.nameTaken(patch.name ?? current.name);
      throw e;
    }
    return this.get(userId, ref);
  }

  /** A copy of a built-in or own policy under a new name. */
  async duplicate(userId: string, ref: string, name: string): Promise<PolicyView> {
    const source = await this.require(userId, ref);
    return this.create(userId, { name, description: source.description, spec: cloneSpec(source.spec) });
  }

  /**
   * Delete an own policy. 409 `POLICY_IS_DEFAULT` for the user's default;
   * 409 `POLICY_IN_USE` (listing the tasks and schedules) unless `reassignTo`
   * names another policy, which the tasks and schedules then use.
   */
  async remove(userId: string, ref: string, reassignTo?: string): Promise<void> {
    const kind = parsePolicyRef(ref);
    if (!kind) throw new NotFoundException({ code: 'POLICY_NOT_FOUND', message: 'Policy not found' });
    if (kind.kind === 'builtin') throw new ForbiddenException({ code: 'POLICY_BUILTIN_READONLY', message: 'Built-in policies cannot be deleted' });
    const policy = await this.require(userId, ref);
    if ((await this.readDefaultRef(userId)) === policy.id) {
      throw new ConflictException({ code: 'POLICY_IS_DEFAULT', message: 'This is your default policy: choose another default first' });
    }
    const [tasks, schedules] = await Promise.all([
      this.prisma.task.findMany({ where: { userId, policyRef: policy.id }, select: { id: true, name: true }, orderBy: { name: 'asc' } }),
      this.prisma.taskSchedule.findMany({ where: { userId, policyRef: policy.id }, select: { id: true, taskId: true }, orderBy: { createdAt: 'asc' } }),
    ]);
    if ((tasks.length > 0 || schedules.length > 0) && reassignTo === undefined) {
      throw new ConflictException({
        code: 'POLICY_IN_USE',
        message: `The policy is used by ${tasks.length} task(s) and ${schedules.length} schedule(s): pass reassignTo to move them`,
        details: { tasks, schedules },
      });
    }
    if (reassignTo !== undefined) {
      if (reassignTo === policy.id) throw new BadRequestException({ code: 'POLICY_REF_INVALID', message: 'reassignTo must be a different policy' });
      await this.assertAssignable(userId, reassignTo, 'reassignTo');
    }
    await this.prisma.$transaction(async (tx) => {
      if (reassignTo !== undefined) {
        await tx.task.updateMany({ where: { userId, policyRef: policy.id }, data: { policyRef: reassignTo } });
        await tx.taskSchedule.updateMany({ where: { userId, policyRef: policy.id }, data: { policyRef: reassignTo } });
      }
      await tx.agentPolicy.deleteMany({ where: { id: policy.id, userId } });
    });
  }

  /** 400 `POLICY_REF_INVALID` unless `ref` is a built-in or one of the user's own policies. Null and undefined pass (no policy). */
  async assertAssignable(userId: string, ref: string | null | undefined, field = 'policyId'): Promise<void> {
    if (ref === null || ref === undefined) return;
    if (!(await this.find(userId, ref))) {
      throw new BadRequestException({ code: 'POLICY_REF_INVALID', message: `${field} does not name a built-in policy or one of yours` });
    }
  }

  // ---- The default ----

  async getDefault(userId: string): Promise<{ policyId: string; explicit: boolean }> {
    const ref = await this.readDefaultRef(userId);
    return { policyId: ref ?? SYSTEM_DEFAULT_POLICY_REF, explicit: ref !== null };
  }

  /** Choose the default policy (`null`: back to Balanced). 404 for a policy that is not the user's. */
  async setDefault(userId: string, ref: string | null): Promise<{ policyId: string; explicit: boolean }> {
    if (ref !== null) await this.require(userId, ref);
    await this.settings.patchSettings(userId, { browserAgent: ref === null ? null : { defaultPolicyRef: ref } } as never);
    return this.getDefault(userId);
  }

  // ---- Legacy task fields ----

  /**
   * The policy the earlier `maxSteps` / `maxMinutes` / `model` task fields stand
   * for: an own policy named `Task: <task name>`, derived from Balanced
   * (`legacyTaskSpec`). Reuses the user's policy with an identical spec. Returns its reference.
   */
  async ensureLegacyPolicy(userId: string, taskName: string, limits: LegacyTaskLimits): Promise<string> {
    const spec = legacyTaskSpec(limits);
    const db = this.db(userId);
    const existing = await db.agentPolicy.findFirst({ where: { name: { startsWith: 'Task: ' }, spec: { equals: spec as Prisma.InputJsonValue } }, orderBy: { createdAt: 'asc' } });
    if (existing) return existing.id;
    const base = legacyPolicyName(taskName);
    for (let n = 0; n < 5; n++) {
      const name = n === 0 ? base : `${base.slice(0, MAX_NAME - 6)} (${Math.random().toString(36).slice(2, 6)})`;
      try {
        const row = await db.agentPolicy.create({
          data: { userId, name, description: "Derived from the task's earlier step, time and model limits.", spec: spec as Prisma.InputJsonValue },
        });
        return row.id;
      } catch (e) {
        if (!PoliciesService.isUniqueViolation(e)) throw e;
      }
    }
    throw this.nameTaken(base);
  }
}
