import { FabricClient } from '../fabric/fabric.client';

/** An operation as the fabric reports it (fields the runner reads). */
export interface FabricOperation {
  id: string;
  state: 'queued' | 'dispatched' | 'succeeded' | 'failed' | 'timed_out' | 'cancelled';
  result?: Record<string, unknown>;
  error?: string;
}

export interface FabricHandoff {
  id: string;
  status: 'pending' | 'completed' | 'cancelled' | 'expired';
  input: 'none' | 'text' | 'secret' | 'choice';
  kind: string;
  viewer_url?: string;
  response?: { outcome: 'completed' | 'cancelled'; value?: string; by?: string };
}

/** The fabric calls a run makes, over the console's FabricClient. */
export class FabricSession {
  constructor(private readonly fabric: FabricClient) {}

  async create(opts: { profile: string; hostId: string | null; label: string }): Promise<string> {
    const s = await this.fabric.request<{ id: string }>('POST', '/v1/sessions', {
      body: { profile: opts.profile, label: opts.label, ...(opts.hostId ? { host_id: opts.hostId } : {}) },
    });
    return s.id;
  }

  async act(sessionId: string, action: Record<string, unknown>, timeoutMs = 45_000): Promise<FabricOperation> {
    return this.fabric.request<FabricOperation>('POST', `/v1/sessions/${sessionId}/actions`, {
      body: { action, timeout_ms: timeoutMs },
      timeoutMs: timeoutMs + 15_000,
    });
  }

  async end(sessionId: string): Promise<void> {
    await this.fabric.request('DELETE', `/v1/sessions/${sessionId}`).catch(() => undefined);
  }

  async createHandoff(sessionId: string, req: { kind: string; prompt: string; input: string; choices?: string[]; timeoutMs?: number }): Promise<string> {
    return (await this.openHandoff(sessionId, req)).id;
  }

  /** Ask a person; with the request's expiry (`null` when the fabric gives none), which schedules the reminders. */
  async openHandoff(sessionId: string, req: { kind: string; prompt: string; input: string; choices?: string[]; timeoutMs?: number }): Promise<{ id: string; expiresAt: Date | null }> {
    const r = await this.fabric.request<{ handoff: { id: string; expires_at?: string } }>('POST', `/v1/sessions/${sessionId}/handoffs`, {
      body: { kind: req.kind, prompt: req.prompt, input: req.input, choices: req.choices ?? [], timeout_ms: req.timeoutMs },
    });
    const exp = r.handoff.expires_at ? new Date(r.handoff.expires_at) : null;
    return { id: r.handoff.id, expiresAt: exp && !Number.isNaN(exp.getTime()) ? exp : null };
  }

  getHandoff(id: string): Promise<FabricHandoff> {
    return this.fabric.request<FabricHandoff>('GET', `/v1/handoffs/${id}`);
  }

  /** The secret a person typed; single use, never logged. */
  async claimSecret(id: string): Promise<string> {
    return (await this.fabric.request<{ value: string }>('POST', `/v1/handoffs/${id}/claim`, { body: {} })).value;
  }
}
