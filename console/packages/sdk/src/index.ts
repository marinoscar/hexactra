// @hexactra/console-sdk: the Hexactra Console REST API, typed from its
// OpenAPI document (openapi.json → src/schema.d.ts, `npm run generate`).
//
//   const hx = createConsoleClient({ baseUrl: 'https://console.example.test', token: process.env.HEXACTRA_TOKEN! });
//   const task = await hx.data(hx.api.POST('/api/tasks', { body: { name: 'Fares', goal: 'Find a fare' } }));
//
// `api` is an openapi-fetch client: every path, parameter, body and response
// is checked against the spec. `data()` unwraps the console's `{ data }`
// envelope and turns an error response into a `ConsoleApiError`.
import createClient, { type Client } from 'openapi-fetch';

import type { components, paths } from './schema.js';

export type { components, paths } from './schema.js';
/** A schema of the document, by name: `Schema<'TaskResponseDto'>`. */
export type Schema<K extends keyof components['schemas']> = components['schemas'][K];

/** The spec of an agent policy: models and tiers, budgets, stall detection, context (the `spec` of a policy). */
export type AgentPolicySpec = Schema<'AgentPolicyResponseDto'>['spec'];
/** An agent policy as the API returns it. */
export type AgentPolicy = Schema<'AgentPolicyResponseDto'>;
/** The portable file `policies.export` returns and `policies.import` takes. */
export type AgentPolicyFile = Schema<'PolicyFileDto'>;
/** What to do on a name clash when importing. */
export type PolicyConflictMode = 'rename' | 'skip' | 'replace';

export interface ConsoleClientOptions {
  /** The console's origin, e.g. `https://console.example.test` (the API is at `/api`). */
  baseUrl: string;
  /** A personal access token (`pat_…`) or an access token. Never logged by the SDK. */
  token: string;
  /** A fetch implementation (default: the global one). */
  fetch?: typeof fetch;
}

/** An error response of the console: `statusCode`, `code` (stable) and `message` (prose). */
export class ConsoleApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | undefined,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ConsoleApiError';
  }
}

type Result<T> = Promise<{ data?: T; error?: unknown; response: Response }>;

export interface ConsoleClient {
  /** The typed client over every route of the document. */
  api: Client<paths>;
  /** Awaits a call, unwraps `{ data }`, throws `ConsoleApiError` on an error status. */
  data<T>(call: Result<T>): Promise<T extends { data: infer D } ? D : T>;
  /** Agent policies: the budgets and model tiers a run follows (`/api/agent-policies`). */
  policies: PoliciesClient;
  /** Tasks, with the `policyId` option. */
  tasks: TasksClient;
  /** Ad-hoc runs, with the `policyId` option. */
  runs: RunsClient;
}

/** A policy reference: an own policy's UUID, or `builtin:economy|balanced|thorough|unlimited`. */
export type PolicyRef = string;

export interface PoliciesClient {
  /** The built-in policies and your own. */
  list(): Promise<AgentPolicy[]>;
  get(id: PolicyRef): Promise<AgentPolicy>;
  create(input: { name: string; description?: string | null; spec: AgentPolicySpec }): Promise<AgentPolicy>;
  /** Pass `version` (the policy's `version`) to be refused with 412 `POLICY_VERSION_CONFLICT` when it moved meanwhile. */
  update(id: PolicyRef, spec: AgentPolicySpec, version?: number, fields?: { name?: string; description?: string | null }): Promise<AgentPolicy>;
  /** `null` goes back to `builtin:balanced`. */
  setDefault(id: PolicyRef | null): Promise<{ policyId: string; explicit: boolean }>;
  /** The portable file of the chosen policies (default: the built-ins and all of your own). */
  export(options?: { ids?: PolicyRef[]; includePins?: boolean }): Promise<AgentPolicyFile>;
  import(file: AgentPolicyFile | Record<string, unknown>, options?: { onConflict?: PolicyConflictMode }): Promise<Schema<'ImportPoliciesResponseDto'>>;
}

export interface TasksClient {
  create(body: Schema<'CreateTaskDto'>): Promise<Schema<'TaskResponseDto'>>;
  update(id: string, body: Schema<'UpdateTaskDto'>): Promise<Schema<'TaskResponseDto'>>;
  /** Run a task now; `policyId` runs it under another policy for this run only. */
  run(id: string, options?: { policyId?: PolicyRef }): Promise<Schema<'RunResponseDto'>>;
}

export interface RunsClient {
  /** Run an ad-hoc goal; `policyId` picks the agent policy (default: yours). */
  start(body: { goal: string; profile?: string; hostId?: string | null; hostFallback?: boolean; policyId?: PolicyRef }): Promise<Schema<'RunResponseDto'>>;
}

export function createConsoleClient(options: ConsoleClientOptions): ConsoleClient {
  const api = createClient<paths>({
    baseUrl: options.baseUrl.replace(/\/+$/, ''),
    headers: { authorization: `Bearer ${options.token}` },
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
  async function data<T>(call: Result<T>): Promise<T extends { data: infer D } ? D : T> {
    const { data, error, response } = await call;
    if (!response.ok) {
      const e = (error ?? {}) as { code?: string; message?: string; details?: unknown };
      throw new ConsoleApiError(response.status, e.code, e.message ?? `HTTP ${response.status}`, e.details);
    }
    const body = data as { data?: unknown } | undefined;
    return (body && typeof body === 'object' && 'data' in body ? body.data : body) as never;
  }
  // The helpers are thin: each is one typed call of `api`, so they cannot drift from the document.
  const policies: PoliciesClient = {
    list: () => data(api.GET('/api/agent-policies')) as Promise<AgentPolicy[]>,
    get: (id) => data(api.GET('/api/agent-policies/{id}', { params: { path: { id } } })) as Promise<AgentPolicy>,
    create: (input) => data(api.POST('/api/agent-policies', { body: input })) as Promise<AgentPolicy>,
    update: (id, spec, version, fields) =>
      data(
        api.PATCH('/api/agent-policies/{id}', {
          params: { path: { id } },
          ...(version !== undefined ? { headers: { 'if-match': String(version) } } : {}),
          body: { ...fields, spec },
        } as never),
      ) as Promise<AgentPolicy>,
    setDefault: (id) => data(api.PUT('/api/agent-policies/default', { body: { policyId: id } })) as Promise<{ policyId: string; explicit: boolean }>,
    export: (o) =>
      data(
        api.GET('/api/agent-policies/export', {
          params: { query: { ids: o?.ids?.length ? o.ids.join(',') : 'all', includePins: o?.includePins === false ? 'false' : 'true' } },
        } as never),
      ) as Promise<AgentPolicyFile>,
    import: (file, o) => data(api.POST('/api/agent-policies/import', { body: { file: file as Record<string, unknown>, onConflict: o?.onConflict ?? 'rename' } })) as never,
  };
  const tasks: TasksClient = {
    create: (body) => data(api.POST('/api/tasks', { body })) as never,
    update: (id, body) => data(api.PATCH('/api/tasks/{id}', { params: { path: { id } }, body })) as never,
    run: (id, o) => data(api.POST('/api/tasks/{id}/runs', { params: { path: { id } }, body: o?.policyId ? { policyId: o.policyId } : {} } as never)) as never,
  };
  const runs: RunsClient = {
    start: (body) => data(api.POST('/api/runs', { body } as never)) as never,
  };
  return { api, data, policies, tasks, runs };
}
