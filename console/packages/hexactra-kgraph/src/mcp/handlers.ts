// Host-neutral handlers of the three procedure tools (E46.22), written over the ports: a host binds `ProcedureStorePort` (its database) and
// `ProcedureRunPort` (its own run start path: the same policy, limits, gates and questions as any run). Every record is the caller's own
// (the store's owner isolation); every label passes `mask`; a sensitive parameter is shown by its name only and never accepted as input.
// Nothing here authenticates, checks a scope or limits a caller: that is the host's (docs/mcp.md, "What a host adds").
import type { z } from 'zod';

import type { ProcedureStorePort } from '../ports';
import type { Procedure, ProcedureVersion } from '../schema';
import { defaultMask, healthOf, stepList } from '../view';
import { procedureGetDescriptor, procedureRunDescriptor, proceduresListDescriptor, type ProcedureSummary } from './descriptors';

/** A host's own run start path. It refuses (throws) what any run of the task would refuse. */
export interface ProcedureRunPort {
  /** Start a run of the procedure's task with the given (non-sensitive) inputs, keyed by parameter name. Returns at once. */
  start(owner: string, procedure: Procedure, inputs: Record<string, string | number>): Promise<{ runId: string; status: string }>;
}

export interface ProcedureToolsHost {
  store: ProcedureStorePort;
  runs: ProcedureRunPort;
  /** The task's name, for the list (the store holds only its id). Default: the procedure's own name. */
  taskName?(owner: string, task: string): Promise<string | null>;
  /** Masks a label before it is returned. Default: the package's conservative mask. */
  mask?(text: string): string;
}

/** What a handler returns: a one-line summary, the structured result and whether it carries page-derived labels. */
export interface ProcedureToolResult<T = Record<string, unknown>> {
  ok: boolean;
  /** One line for the model. On an error, the reason. */
  summary: string;
  structured: T | null;
  /** A short machine code on an error. */
  code?: 'NOT_FOUND' | 'NOT_ACTIVE' | 'SENSITIVE_INPUT' | 'RUN_REFUSED';
  /** The host prefixes its untrusted-content notice. */
  untrusted: boolean;
}

/** The version a procedure shows: its active one, else the newest. */
export function shownVersion(procedure: Procedure, versions: readonly ProcedureVersion[]): ProcedureVersion | null {
  return versions.find((v) => v.id === procedure.activeVersion) ?? versions[0] ?? null;
}

/** A procedure as the tools show it. */
export function procedureSummary(procedure: Procedure, version: ProcedureVersion | null, taskName: string, mask: (t: string) => string = defaultMask): ProcedureSummary {
  return {
    id: procedure.id,
    task_id: procedure.task,
    task_name: mask(taskName),
    name: mask(procedure.name),
    state: version?.state ?? null,
    health: version ? healthOf(version.evidence, version.state) : 'unknown',
    parameters: (version?.parameters ?? []).map((p) => ({ name: mask(p.name), type: p.type, required: p.required, sensitive: p.sensitive })),
    outputs: (version?.outputs ?? []).filter((o) => !o.sensitive).map((o) => ({ name: mask(o.name) })),
  };
}

const fail = (summary: string, code: ProcedureToolResult['code']): ProcedureToolResult<never> => ({ ok: false, summary, structured: null, code, untrusted: false });

/** The three handlers over the host's ports. `owner` is the authenticated caller: never an argument. */
export function procedureToolHandlers(host: ProcedureToolsHost) {
  const mask = host.mask ?? defaultMask;
  const nameOf = async (owner: string, p: Procedure) => (await host.taskName?.(owner, p.task)) ?? p.name;
  const load = async (owner: string, id: string) => {
    const procedure = await host.store.getProcedure(owner, id);
    if (!procedure) return null;
    return { procedure, version: shownVersion(procedure, await host.store.listVersions(owner, procedure.id)) };
  };

  return {
    async procedures_list(owner: string, raw: z.input<typeof proceduresListDescriptor.input>): Promise<ProcedureToolResult<z.infer<typeof proceduresListDescriptor.output>>> {
      const args = proceduresListDescriptor.input.parse(raw);
      const words = args.query?.toLowerCase().split(/\s+/) ?? [];
      const all = (await host.store.listProcedures(owner)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      const out: ProcedureSummary[] = [];
      for (const p of all) {
        const s = procedureSummary(p, shownVersion(p, await host.store.listVersions(owner, p.id)), await nameOf(owner, p), mask);
        if (args.state && s.state !== args.state) continue;
        if (!words.every((w) => `${s.name} ${s.task_name}`.toLowerCase().includes(w))) continue;
        out.push(s);
      }
      const procedures = out.slice(0, args.limit);
      return { ok: true, summary: `${procedures.length} procedure(s).`, structured: { procedures, has_more: out.length > procedures.length }, untrusted: false };
    },

    async procedure_get(owner: string, raw: z.input<typeof procedureGetDescriptor.input>): Promise<ProcedureToolResult<z.infer<typeof procedureGetDescriptor.output>>> {
      const args = procedureGetDescriptor.input.parse(raw);
      const found = await load(owner, args.procedure_id);
      if (!found) return fail(`No procedure ${args.procedure_id}.`, 'NOT_FOUND');
      const steps = found.version
        ? stepList(found.version, mask).map((s) => ({ id: s.id, kind: s.kind, label: s.label, tool: s.tool, target: s.target, uses_ai: s.usesAi, commits: s.commitClass, health: s.health }))
        : [];
      const structured = { ...procedureSummary(found.procedure, found.version, await nameOf(owner, found.procedure), mask), steps, untrusted: true };
      return { ok: true, summary: `Procedure ${found.procedure.id}: ${steps.length} step(s).`, structured, untrusted: true };
    },

    async procedure_run(owner: string, raw: z.input<typeof procedureRunDescriptor.input>): Promise<ProcedureToolResult<z.infer<typeof procedureRunDescriptor.output>>> {
      const args = procedureRunDescriptor.input.parse(raw);
      const found = await load(owner, args.procedure_id);
      if (!found) return fail(`No procedure ${args.procedure_id}.`, 'NOT_FOUND');
      if (found.version?.state !== 'active') return fail('This procedure is not active yet: it can be run once it has been verified.', 'NOT_ACTIVE');
      const inputs = args.inputs ?? {};
      const sensitive = new Set(found.version.parameters.filter((p) => p.sensitive).map((p) => p.name.toLowerCase()));
      if (Object.keys(inputs).some((k) => sensitive.has(k.toLowerCase()))) return fail('A sensitive parameter is never passed here: the owner enters it when the run starts.', 'SENSITIVE_INPUT');
      let started: { runId: string; status: string };
      try {
        started = await host.runs.start(owner, found.procedure, inputs);
      } catch (err) {
        return fail(`The run was not started: ${err instanceof Error ? err.message.slice(0, 300) : 'refused'}`, 'RUN_REFUSED');
      }
      const structured = { run_id: started.runId, status: started.status, procedure_id: found.procedure.id, task_id: found.procedure.task, follow: `run_wait with run_id ${started.runId}` };
      return { ok: true, summary: `Run ${started.runId} started (${started.status}). Follow it with run_wait.`, structured, untrusted: false };
    },
  };
}

export type ProcedureToolHandlers = ReturnType<typeof procedureToolHandlers>;
