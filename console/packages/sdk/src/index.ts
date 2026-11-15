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
}

export function createConsoleClient(options: ConsoleClientOptions): ConsoleClient {
  const api = createClient<paths>({
    baseUrl: options.baseUrl.replace(/\/+$/, ''),
    headers: { authorization: `Bearer ${options.token}` },
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
  return {
    api,
    async data(call) {
      const { data, error, response } = await call;
      if (!response.ok) {
        const e = (error ?? {}) as { code?: string; message?: string; details?: unknown };
        throw new ConsoleApiError(response.status, e.code, e.message ?? `HTTP ${response.status}`, e.details);
      }
      const body = data as { data?: unknown } | undefined;
      return (body && typeof body === 'object' && 'data' in body ? body.data : body) as never;
    },
  };
}
