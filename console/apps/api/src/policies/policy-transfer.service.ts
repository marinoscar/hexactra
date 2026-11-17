import { BadRequestException, ConflictException, Injectable, Logger, Optional, PayloadTooLargeException } from '@nestjs/common';
import { SystemSettingsService } from '@marinoscar/platform-api/settings';
import { Prisma } from '@prisma/client';

import './policies.errors';
import { PrismaService } from '../prisma/prisma.service';
import { PoliciesService } from './policies.service';
import { PolicyModelCheck } from './policy-model-check';
import {
  buildPolicyFile,
  ceilingWarning,
  exceedsCeilings,
  MAX_IMPORT_BYTES,
  parsePolicyFile,
  policyFileName,
  renamedName,
  UnsupportedVersionError,
  type BudgetCeilings,
  type PolicyFile,
  type PolicyFileEntry,
} from './policy-transfer';
import type { ImportPoliciesResponse } from './policy-transfer.schemas';

/** The system settings namespace of the deployment's budget ceilings (#404). Read by name: until #404 registers it, nothing is a ceiling. */
export const CEILINGS_NAMESPACE = 'browserAgentCeilings';

export type ConflictMode = 'rename' | 'skip' | 'replace';

/**
 * Export and import of agent policies as portable JSON (#402). Export reads
 * through `PoliciesService` (built-ins and the user's own); import validates the
 * whole file first, drops model pins this deployment cannot use, then writes
 * everything in ONE transaction, so a file is imported entirely or not at all.
 * Creating goes through the same name and pin rules as `PoliciesService.create`.
 */
@Injectable()
export class PolicyTransferService {
  private readonly log = new Logger(PolicyTransferService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly policies: PoliciesService,
    private readonly modelCheck: PolicyModelCheck,
    @Optional() private readonly systemSettings?: SystemSettingsService,
  ) {}

  // ---- Export ----

  /** The file for `ids` (`all`, or a comma-separated list of policy ids), and the name to download it under. */
  async export(userId: string, ids: string, includePins: boolean, now: Date = new Date()): Promise<{ file: PolicyFile; filename: string }> {
    const wanted = ids.trim() === 'all' ? null : [...new Set(ids.split(',').map((s) => s.trim()).filter(Boolean))];
    if (wanted !== null && wanted.length === 0) throw new BadRequestException({ code: 'POLICY_REF_INVALID', message: 'ids names no policy' });
    const records = wanted === null ? (await this.policies.list(userId)) : await Promise.all(wanted.map((id) => this.policies.require(userId, id)));
    return { file: buildPolicyFile(records, { includePins, now }), filename: policyFileName(now) };
  }

  // ---- Import ----

  async import(userId: string, raw: unknown, onConflict: ConflictMode): Promise<ImportPoliciesResponse> {
    this.assertSize(raw);
    let parsed;
    try {
      parsed = parsePolicyFile(raw);
    } catch (e) {
      if (e instanceof UnsupportedVersionError) throw new BadRequestException({ code: 'POLICY_IMPORT_UNSUPPORTED_VERSION', message: e.message, details: { [e.what]: e.found, supported: e.supported } });
      throw e;
    }
    if (!parsed.ok) {
      const n = parsed.errors.length;
      throw new BadRequestException({
        code: 'POLICY_IMPORT_INVALID',
        message: n > 0 ? `${n} of the policies in the file ${n === 1 ? 'is' : 'are'} invalid; nothing was imported` : `The file is not a policy export: ${parsed.fileIssues.map((i) => i.message).join('; ')}`,
        details: { errors: parsed.errors, fileIssues: parsed.fileIssues },
      });
    }

    const warnings: ImportPoliciesResponse['warnings'] = [];
    const ceilings = await this.readCeilings();
    const entries: PolicyFileEntry[] = [];
    for (const [index, entry] of parsed.entries.entries()) {
      const spec = structuredClone(entry.spec);
      const problems = await this.modelCheck.check(userId, spec);
      for (const p of problems) {
        // The pin is dropped, so that tier uses the user's own tier definition.
        if (spec.models.pins) delete spec.models.pins[p.tier];
        warnings.push({ index, name: entry.name, code: 'PIN_DROPPED', message: `The ${p.tier} model pin "${p.pin}" is ${p.reason === 'unsupported' ? 'not usable here (it needs tools and vision)' : 'not an enabled model you can use here'}; that tier uses your tier definition instead` });
      }
      if (spec.models.pins && Object.values(spec.models.pins).every((v) => !v)) delete spec.models.pins;
      for (const c of exceedsCeilings(spec, ceilings)) warnings.push({ index, name: entry.name, code: 'EXCEEDS_CEILING', message: ceilingWarning(c) });
      entries.push({ ...entry, spec });
    }

    const result = await this.write(userId, entries, onConflict);
    return { ...result, warnings, errors: [] };
  }

  /** 413 for a body over the limit (the transport allows more than the import does). */
  private assertSize(raw: unknown): void {
    const bytes = Buffer.byteLength(JSON.stringify(raw ?? null), 'utf8');
    if (bytes > MAX_IMPORT_BYTES) {
      throw new PayloadTooLargeException({ code: 'POLICY_IMPORT_TOO_LARGE', message: `A policy file may be at most ${MAX_IMPORT_BYTES / 1024} KB (this one is ${Math.ceil(bytes / 1024)} KB)` });
    }
  }

  private async readCeilings(): Promise<BudgetCeilings | null> {
    try {
      const value = (await (this.systemSettings as unknown as { getNamespace(key: string): Promise<unknown> } | undefined)?.getNamespace(CEILINGS_NAMESPACE)) as BudgetCeilings | null | undefined;
      return value && typeof value === 'object' ? value : null;
    } catch (e) {
      // The namespace is not registered (or the settings could not be read): no ceilings apply.
      this.log.debug(`no deployment ceilings read: ${e instanceof Error ? e.message : String(e)}`);
      return null;
    }
  }

  /** The whole import in one transaction; any failure rolls all of it back. */
  private async write(userId: string, entries: readonly PolicyFileEntry[], mode: ConflictMode): Promise<Pick<ImportPoliciesResponse, 'created' | 'replaced' | 'skipped'>> {
    const created: ImportPoliciesResponse['created'] = [];
    const replaced: ImportPoliciesResponse['replaced'] = [];
    const skipped: ImportPoliciesResponse['skipped'] = [];
    try {
      // The user scope extension applies to the transaction client too (`policies.db.spec.ts` proves it), so every
      // statement below is confined to this user's rows even before its explicit `userId`.
      await this.prisma.forUser({ userId }).$transaction(async (tx) => {
        const existing = await tx.agentPolicy.findMany({ where: { userId }, select: { id: true, name: true } });
        const byName = new Map(existing.map((r) => [r.name, r.id]));
        const taken = new Set(byName.keys());
        for (const [index, entry] of entries.entries()) {
          const id = byName.get(entry.name);
          const data = { description: entry.description, spec: entry.spec as Prisma.InputJsonValue };
          if (id === undefined) {
            const row = await tx.agentPolicy.create({ data: { userId, name: entry.name, ...data } });
            taken.add(entry.name);
            created.push({ index, id: row.id, name: row.name, renamedFrom: null });
          } else if (mode === 'skip') {
            skipped.push({ index, name: entry.name, reason: 'name_taken' });
          } else if (mode === 'replace') {
            const row = await tx.agentPolicy.update({ where: { id }, data: { ...data, version: { increment: 1 } } });
            replaced.push({ index, id: row.id, name: row.name, version: row.version });
          } else {
            const name = renamedName(entry.name, taken);
            const row = await tx.agentPolicy.create({ data: { userId, name, ...data } });
            taken.add(name);
            created.push({ index, id: row.id, name: row.name, renamedFrom: entry.name });
          }
        }
      });
    } catch (e) {
      // A policy of that name appeared between the read and the write: nothing was imported, try again.
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new ConflictException({ code: 'POLICY_NAME_TAKEN', message: 'A policy with one of these names was created while the file was importing; nothing was imported, try again' });
      }
      throw e;
    }
    return { created, replaced, skipped };
  }
}

