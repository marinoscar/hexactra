// Export and import (E46.23): a versioned file of procedures with no secrets, never trusted on arrival. Pure.
//   never exported: ids of users, runs, tasks, chats, procedures or versions; connection ids or tokens (an account is its provider and a
//   placeholder); secret-reference ids (a saved login is its label and site); evidence; traces; a literal that fails the sensitive check.
import { z } from 'zod';

import { parameterSchema } from '../schema/core';
import { procedureVersionSchema, type ProcedureVersion } from '../schema/procedure';
import type { Step } from '../schema/step';
import type { SensitivePredicate } from '../validate/sensitive';
import { defaultIsSensitive } from '../validate/sensitive';

export const TRANSFER_KIND = 'hexactra.kgraph';
export const FORMAT_VERSION = 1;
export const TRANSFER_LIMITS = Object.freeze({ bytes: 1_000_000, procedures: 50, steps: 500 });

const exportedVersionSchema = procedureVersionSchema.omit({ id: true, procedure: true, number: true, state: true, changeClass: true, sourceRun: true, parent: true, createdAt: true, evidence: true, stepEvidence: true });
export const exportedProcedureSchema = z.object({
  task: z.object({ name: z.string().min(1).max(200), goal: z.string().min(1).max(8000), parameters: z.array(z.unknown()).max(50).default([]), outputs: z.array(z.unknown()).max(50).default([]) }),
  version: exportedVersionSchema,
});
export const transferFileSchema = z.object({
  kind: z.literal(TRANSFER_KIND),
  formatVersion: z.number().int().min(1),
  exportedAt: z.string(),
  procedures: z.array(exportedProcedureSchema).max(TRANSFER_LIMITS.procedures),
  surface: z.array(z.unknown()).max(5000).default([]),
});
export type TransferFile = z.infer<typeof transferFileSchema>;
export type ExportedProcedure = z.infer<typeof exportedProcedureSchema>;

export type TransferError = { code: 'too_large' | 'malformed' | 'unknown_format_version' | 'too_many_procedures' | 'too_many_steps'; message: string };

export interface ExportInput {
  task: { name: string; goal: string; parameters: unknown[]; outputs: unknown[] };
  version: ProcedureVersion;
}

/** One procedure as it leaves: placeholders for accounts, labels for saved logins, a parameter for any literal that looks like a secret. */
export function exportProcedure(p: ExportInput, isSensitive: SensitivePredicate = defaultIsSensitive): ExportedProcedure {
  const v = structuredClone(p.version);
  const accounts = v.accounts.map((a, i) => ({ id: `account-${i + 1}`, connectionId: `account-${i + 1}`, provider: a.provider }));
  const accountIds = new Map(v.accounts.map((a, i) => [a.id, `account-${i + 1}`]));
  const secretRefs = v.secretRefs.map((r, i) => ({ id: `login-${i + 1}`, kind: r.kind, label: r.label }));
  const refIds = new Map(v.secretRefs.map((r, i) => [r.id, `login-${i + 1}`]));
  const parameters = [...v.parameters];
  let n = 0;
  const steps: Step[] = v.steps.map((s) => {
    const fix = (bindings: Record<string, (typeof s & { kind: 'call' })['args'][string]>) => {
      for (const [k, b] of Object.entries(bindings)) {
        if (b.kind === 'secret') bindings[k] = { ...b, ref: refIds.get(b.ref) ?? 'login-unknown' };
        if (b.kind === 'literal' && typeof b.value === 'string' && isSensitive(b.value)) {
          const id = `p:import-${++n}`;
          parameters.push(parameterSchema.parse({ id, name: `Withheld value ${n}`, sensitive: true }));
          bindings[k] = { kind: 'parameter', parameter: id };
        }
      }
    };
    if (s.kind === 'call') fix(s.args);
    if (s.kind === 'judge') fix(s.inputs);
    return s;
  });
  const { id: _i, procedure: _p, number: _n, state: _s, changeClass: _c, sourceRun: _r, parent: _pa, createdAt: _at, evidence: _e, stepEvidence: _se, ...rest } = { ...v, steps, accounts: accounts.map((a) => ({ ...a, id: accountIds.get(a.id) ?? a.id })), secretRefs, parameters };
  return exportedProcedureSchema.parse({ task: { name: p.task.name, goal: p.task.goal, parameters: p.task.parameters, outputs: p.task.outputs }, version: rest });
}

export function exportFile(procedures: readonly ExportInput[], now: Date, isSensitive?: SensitivePredicate): TransferFile {
  return { kind: TRANSFER_KIND, formatVersion: FORMAT_VERSION, exportedAt: now.toISOString(), procedures: procedures.map((p) => exportProcedure(p, isSensitive)), surface: [] };
}

/** Read an untrusted file: size, format version, shape and limits. Nothing in it is trusted beyond its shape. */
export function readTransferFile(raw: string | unknown): { ok: true; file: TransferFile } | { ok: false; error: TransferError } {
  const text = typeof raw === 'string' ? raw : JSON.stringify(raw);
  if (text.length > TRANSFER_LIMITS.bytes) return { ok: false, error: { code: 'too_large', message: `The file is over ${TRANSFER_LIMITS.bytes} bytes` } };
  let json: unknown;
  try {
    json = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    return { ok: false, error: { code: 'malformed', message: 'The file is not JSON' } };
  }
  const head = json as { kind?: unknown; formatVersion?: unknown; procedures?: unknown };
  if (head?.kind !== TRANSFER_KIND) return { ok: false, error: { code: 'malformed', message: 'This is not a Hexactra Knowledge Graph file' } };
  if (typeof head.formatVersion === 'number' && head.formatVersion > FORMAT_VERSION) return { ok: false, error: { code: 'unknown_format_version', message: `This file is format version ${head.formatVersion}; this console reads up to ${FORMAT_VERSION}. Update the console first.` } };
  if (Array.isArray(head.procedures) && head.procedures.length > TRANSFER_LIMITS.procedures) return { ok: false, error: { code: 'too_many_procedures', message: `At most ${TRANSFER_LIMITS.procedures} procedures per file` } };
  const parsed = transferFileSchema.safeParse(json);
  if (!parsed.success) return { ok: false, error: { code: 'malformed', message: parsed.error.issues.slice(0, 3).map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') } };
  if (parsed.data.procedures.some((p) => p.version.steps.length > TRANSFER_LIMITS.steps)) return { ok: false, error: { code: 'too_many_steps', message: `At most ${TRANSFER_LIMITS.steps} steps per procedure` } };
  return { ok: true, file: parsed.data };
}
