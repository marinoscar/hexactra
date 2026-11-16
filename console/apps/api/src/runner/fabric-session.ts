import { FabricClient, FabricError } from '../fabric/fabric.client';

/** How long a run waits for a person who took over its browser (#342). */
export const TAKEOVER_WAIT_MS = 30 * 60_000;
const TAKEOVER_POLL_MS = 5_000;

/** The fabric refused because a person controls the host's desktop. */
export const isTakeoverActive = (e: unknown): e is FabricError => e instanceof FabricError && e.status === 409 && e.code === 'takeover_active';

/** An operation as the fabric reports it (fields the runner reads). */
export interface FabricOperation {
  id: string;
  state: 'queued' | 'dispatched' | 'succeeded' | 'failed' | 'timed_out' | 'cancelled';
  result?: Record<string, unknown>;
  error?: string;
}

export type FabricHandoffInput = 'none' | 'text' | 'secret' | 'choice' | 'multi_choice' | 'number' | 'confirm' | 'takeover';

/** The answer as the fabric reports it (`HandoffView.response`, snake_case). */
export interface FabricHandoffResponse {
  /** Absent on fabrics older than the typed contract (#285): derive it from the status. */
  outcome?: 'completed' | 'cancelled';
  value?: string;
  values?: string[];
  /** A secret: the value exists but is never returned; a `type_secret` action types it, once. */
  value_withheld?: boolean;
  channel?: string;
  by?: string;
  answered_at?: string;
}

export interface FabricHandoff {
  id: string;
  /** The fabric session it belongs to. */
  session_id?: string;
  status: 'pending' | 'completed' | 'cancelled' | 'expired';
  input: FabricHandoffInput;
  kind: string;
  prompt?: string;
  choices?: (string | { id: string; label: string; description?: string })[];
  page?: { url?: string; title?: string };
  viewer_url?: string;
  created_at?: string;
  expires_at?: string;
  resolved_at?: string;
  response?: FabricHandoffResponse;
}

/** How a resolved handoff ended: the response's outcome, or (older fabrics) its status. Null while pending or expired. */
export function handoffOutcome(h: Pick<FabricHandoff, 'status' | 'response'>): 'completed' | 'cancelled' | null {
  if (h.response?.outcome) return h.response.outcome;
  if (h.status === 'completed') return 'completed';
  if (h.status === 'cancelled') return 'cancelled';
  return null;
}

/** What a handoff asks, in the console's camelCase (mapped to the fabric's snake_case body). */
export interface HandoffRequest {
  kind: string;
  prompt: string;
  input: string;
  choices?: (string | { id: string; label: string; description?: string })[];
  constraints?: {
    maxLength?: number;
    pattern?: string;
    multiline?: boolean;
    min?: number;
    max?: number;
    step?: number;
    unit?: string;
    minSelections?: number;
    maxSelections?: number;
  } | null;
  confirmLabel?: string | null;
  denyLabel?: string | null;
  risk?: 'low' | 'high' | null;
  timeoutMs?: number;
}

/** A created handoff: its id and what the inbox shows. */
export interface CreatedHandoff {
  id: string;
  viewerUrl: string | null;
  pageTitle: string | null;
  expiresAt: Date | null;
}

const CONSTRAINT_FIELDS = {
  maxLength: 'max_length',
  pattern: 'pattern',
  multiline: 'multiline',
  min: 'min',
  max: 'max',
  step: 'step',
  unit: 'unit',
  minSelections: 'min_selections',
  maxSelections: 'max_selections',
} as const;

/**
 * A choice as the fabric takes it: a bare string when it is its own label
 * (what fabrics before the typed contract accept), else `{ id, label, description? }`.
 */
function fabricChoice(c: string | { id: string; label: string; description?: string }): string | { id: string; label: string; description?: string } {
  if (typeof c === 'string' || (c.id === c.label && !c.description)) return typeof c === 'string' ? c : c.id;
  return { id: c.id, label: c.label, ...(c.description ? { description: c.description } : {}) };
}

/** The fabric's create body. Typed-contract fields are sent only when set, so older fabrics keep accepting it. */
export function handoffBody(req: HandoffRequest): Record<string, unknown> {
  const constraints: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(req.constraints ?? {})) {
    if (v !== undefined) constraints[CONSTRAINT_FIELDS[k as keyof typeof CONSTRAINT_FIELDS]] = v;
  }
  return {
    kind: req.kind,
    prompt: req.prompt,
    input: req.input,
    choices: (req.choices ?? []).map(fabricChoice),
    ...(Object.keys(constraints).length ? { constraints } : {}),
    ...(req.confirmLabel ? { confirm_label: req.confirmLabel } : {}),
    ...(req.denyLabel ? { deny_label: req.denyLabel } : {}),
    ...(req.risk ? { risk: req.risk } : {}),
    timeout_ms: req.timeoutMs,
  };
}

/** The fabric calls a run makes, over the console's FabricClient. */
export class FabricSession {
  constructor(
    private readonly fabric: FabricClient,
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  ) {}

  async create(opts: { profile: string; hostId: string | null; label: string }): Promise<string> {
    const s = await this.fabric.request<{ id: string }>('POST', '/v1/sessions', {
      body: { profile: opts.profile, label: opts.label, ...(opts.hostId ? { host_id: opts.hostId } : {}) },
    });
    return s.id;
  }

  /**
   * Runs one action. While a person controls the host's desktop (#342) the
   * fabric refuses new actions with `409 takeover_active`: by default this
   * waits (up to 30 minutes) and runs the step once they release it;
   * `waitForTakeover: false` throws at once instead (an external agent
   * decides itself when to retry).
   */
  async act(sessionId: string, action: Record<string, unknown>, timeoutMs = 45_000, opts: { waitForTakeover?: boolean } = {}): Promise<FabricOperation> {
    const until = Date.now() + TAKEOVER_WAIT_MS;
    for (;;) {
      try {
        return await this.fabric.request<FabricOperation>('POST', `/v1/sessions/${sessionId}/actions`, {
          body: { action, timeout_ms: timeoutMs },
          timeoutMs: timeoutMs + 15_000,
        });
      } catch (e) {
        if (opts.waitForTakeover === false || !isTakeoverActive(e) || Date.now() >= until) throw e;
        await this.sleep(TAKEOVER_POLL_MS);
      }
    }
  }

  async end(sessionId: string): Promise<void> {
    await this.fabric.request('DELETE', `/v1/sessions/${sessionId}`).catch(() => undefined);
  }

  async createHandoff(sessionId: string, req: HandoffRequest): Promise<string> {
    return (await this.openHandoff(sessionId, req)).id;
  }

  /** Create a handoff and keep what the inbox shows (viewer link, page title, expiry). */
  async openHandoff(sessionId: string, req: HandoffRequest): Promise<CreatedHandoff> {
    const r = await this.fabric.request<{ handoff: Partial<FabricHandoff> & { id: string } }>('POST', `/v1/sessions/${sessionId}/handoffs`, { body: handoffBody(req) });
    const h = r.handoff;
    const expires = h.expires_at ? new Date(h.expires_at) : null;
    return { id: h.id, viewerUrl: h.viewer_url ?? null, pageTitle: h.page?.title ?? null, expiresAt: expires && !Number.isNaN(expires.getTime()) ? expires : null };
  }

  /** Answer a handoff with the console's service token, as `answeredBy` (e.g. `user:<id>`). */
  async respond(id: string, answer: { outcome: 'completed' | 'cancelled'; value?: string; values?: string[]; channel?: string; answeredBy?: string }): Promise<void> {
    await this.fabric.request('POST', `/v1/handoffs/${id}/respond`, {
      body: {
        outcome: answer.outcome,
        ...(answer.value !== undefined ? { value: answer.value } : {}),
        ...(answer.values !== undefined ? { values: answer.values } : {}),
        ...(answer.channel ? { channel: answer.channel } : {}),
        ...(answer.answeredBy ? { answered_by: answer.answeredBy } : {}),
      },
    });
  }

  /** Withdraw a pending handoff (best effort). */
  async cancelHandoff(id: string): Promise<void> {
    await this.fabric.request('POST', `/v1/handoffs/${id}/cancel`).catch(() => undefined);
  }

  getHandoff(id: string): Promise<FabricHandoff> {
    return this.fabric.request<FabricHandoff>('GET', `/v1/handoffs/${id}`);
  }

  /**
   * Type the answer of a `secret` handoff into `selector` with the fabric's
   * `type_secret` action: the fabric types it on the host, so the plaintext
   * never reaches the console. Single use; the fabric refuses (409
   * `secret_unavailable`) when it was already used, erased or expired.
   */
  typeSecret(sessionId: string, opts: { handoffId: string; selector: string; clear?: boolean; submit?: boolean; tabId?: number }, timeoutMs?: number): Promise<FabricOperation> {
    return this.act(
      sessionId,
      {
        type: 'type_secret',
        handoff_id: opts.handoffId,
        selector: opts.selector,
        clear: opts.clear ?? true,
        submit: opts.submit ?? false,
        ...(opts.tabId !== undefined ? { tab_id: opts.tabId } : {}),
      },
      timeoutMs,
    );
  }
}
