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
/** A page of tasks: what `GET /api/tasks?envelope=1` returns in `data` (the document types that route as the plain array). */
export type TaskPage = Schema<'TaskPageResponseDto'>;
/** A task with its `summary` (`include=summary`; also what creating a task returns). */
export type TaskWithSummary = Schema<'TaskWithSummaryResponseDto'>;
/** A task's run statistics (`GET /api/tasks/{id}/stats`). */
export type TaskStats = Schema<'TaskStatsResponseDto'>;
/** A page of runs: what `GET /api/runs?envelope=1` returns in `data`. */
export type RunPage = Schema<'RunPageResponseDto'>;
/** Which runs: the filter of `GET /api/runs`, `GET /api/runs/counts` and a delete by filter. */
export type RunFilter = NonNullable<Schema<'DeleteRunsDto'>['filter']>;
/** What deleting runs answers: the runs deleted now, or (more than 500 matches) the queue job that deletes them. */
export type RunsDeleted = Schema<'RunsDeletedResponseDto'> | Schema<'RunsDeleteQueuedResponseDto'>;
/** What a schedule means and when it fires next, or why it would be refused (`POST /api/schedules/preview`). */
export type SchedulePreview = Schema<'SchedulePreviewResponseDto'>;
/** The portable file `policies.export` returns and `policies.import` takes. */
export type AgentPolicyFile = Schema<'PolicyFileDto'>;
/** A run trace file (`hexactra.run-trace`, formatVersion 1): what `runs.export` returns. Its JSON Schema is `run-trace.schema.json` in this package. */
export type RunTrace = Schema<'RunTraceDto'>;
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
  /** Runs: start one, read a page, delete finished ones. */
  runs: RunsClient;
  /** Schedules: check an expression before saving it. */
  schedules: SchedulesClient;
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
  /** `schedules` (at most 10) creates the task with its schedules in one transaction; one invalid schedule creates nothing. */
  create(body: Schema<'CreateTaskDto'>): Promise<TaskWithSummary>;
  update(id: string, body: Schema<'UpdateTaskDto'>): Promise<Schema<'TaskResponseDto'>>;
  /** Run a task now; `policyId` runs it under another policy for this run only. */
  run(id: string, options?: { policyId?: PolicyRef }): Promise<Schema<'RunResponseDto'>>;
  /** Pause every schedule of the task ("disable" it): it still runs when started by hand, the API or MCP. 409 `NO_SCHEDULES` without one. */
  pauseSchedules(id: string): Promise<Schema<'TaskSchedulesChangedResponseDto'>>;
  /** Resume every schedule of the task; `skipped` lists the schedules that could not be resumed. */
  resumeSchedules(id: string): Promise<Schema<'TaskSchedulesChangedResponseDto'>>;
}

export interface RunsClient {
  /** Run an ad-hoc goal; `policyId` picks the agent policy (default: yours). */
  start(body: { goal: string; profile?: string; hostId?: string | null; hostFallback?: boolean; policyId?: PolicyRef }): Promise<Schema<'RunResponseDto'>>;
  /** One page of runs, newest first (`envelope=1`): pass `nextCursor` back as `cursor`; `null` is the end. */
  list(query?: RunFilter & { cursor?: string; limit?: number; order?: 'desc' | 'asc' }): Promise<RunPage>;
  /** Delete one finished run, permanently. 409 `RUN_LIVE` for a queued, running or waiting run: cancel it first. Needs `runs:delete`. */
  delete(id: string): Promise<void>;
  /**
   * Delete many finished runs, permanently: `{ ids }` (1 to 500), or `{ filter, expectedCount }` for every finished run a
   * filter matches. More than 500 matches answer with a `jobId`: a queue job deletes them. Needs `runs:delete`.
   */
  deleteMany(body: { ids: string[] } | { filter: RunFilter; expectedCount?: number }): Promise<RunsDeleted>;
  /**
   * One run as a masked trace file (`GET /api/runs/{id}/export`): the run, its policy, budget, steps with their questions
   * and answers, the trace screenshots (base64; `screenshots: 'none'` leaves them out) and its chat. Needs `runs:read`.
   * 413 `EXPORT_TOO_LARGE` over 50 MB with screenshots; 429 `EXPORT_RATE_LIMITED` past 10 a minute.
   */
  export(id: string, options?: { screenshots?: 'embed' | 'none' }): Promise<RunTrace>;
}

export interface SchedulesClient {
  /** Always resolves: `{ valid: true, description, next, … }` or `{ valid: false, code, message }`. Saves nothing. */
  preview(body: { cron: string; timezone?: string; count?: number }): Promise<SchedulePreview>;
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
    pauseSchedules: (id) => data(api.POST('/api/tasks/{id}/schedules/pause', { params: { path: { id } } })) as never,
    resumeSchedules: (id) => data(api.POST('/api/tasks/{id}/schedules/resume', { params: { path: { id } } })) as never,
  };
  const runs: RunsClient = {
    start: (body) => data(api.POST('/api/runs', { body } as never)) as never,
    // The document types this route as the plain array; with `envelope` it answers a page.
    list: (query) => data(api.GET('/api/runs', { params: { query: { ...query, envelope: '1' } } } as never)) as never,
    delete: async (id) => {
      await data(api.DELETE('/api/runs/{id}', { params: { path: { id } } }));
    },
    deleteMany: (body) => data(api.POST('/api/runs/delete', { body })) as never,
    // The file is not wrapped in `{ data }`: `data()` passes it through as it is.
    export: (id, o) => data(api.GET('/api/runs/{id}/export', { params: { path: { id }, query: { format: 'json', screenshots: o?.screenshots ?? 'embed' } } } as never)) as Promise<RunTrace>,
  };
  const schedules: SchedulesClient = {
    preview: (body) => data(api.POST('/api/schedules/preview', { body })) as never,
  };
  return { api, data, policies, tasks, runs, schedules };
}
