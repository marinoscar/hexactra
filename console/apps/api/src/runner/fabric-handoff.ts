// The fabric's operation and handoff shapes (what the runner reads of them), and the body of a handoff request.

/** An operation as the fabric reports it (fields the runner reads). */
export interface FabricOperation {
  id: string;
  state: 'queued' | 'dispatched' | 'succeeded' | 'failed' | 'timed_out' | 'cancelled';
  result?: Record<string, unknown>;
  error?: string;
  /** Top-level navigations the browser blocked under the session's allowed sites since the previous action (#508). */
  navigation_blocked?: Array<{ host: string; at: string }>;
}

export type FabricHandoffInput = 'none' | 'text' | 'secret' | 'choice' | 'multi_choice' | 'number' | 'confirm' | 'takeover' | 'credentials';

/** The answer as the fabric reports it (`HandoffView.response`, snake_case). */
export interface FabricHandoffResponse {
  /** Absent on fabrics older than the typed contract (#285): derive it from the status. */
  outcome?: 'completed' | 'cancelled';
  value?: string;
  values?: string[];
  /** A secret (or a sign-in's password): it exists but is never returned; a `type_secret` action types it, once. */
  value_withheld?: boolean;
  /** The person's choice for the question's "remember me" option (#527). */
  remember?: boolean;
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
  /** The site's "remember me" option offered with the question (#527). */
  remember?: { label: string };
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
  /** credentials and secret: the site's "remember me" option, in the page's words (#527). */
  rememberLabel?: string | null;
  /**
   * credentials only (E37.4b): the fabric keeps the typed password in its memory after `type_secret` types it, for ten minutes
   * after the answer, so the owner's secrets provider can still be asked to save the sign-in (`saveLogin`). Never returned.
   */
  offerSave?: boolean;
  timeoutMs?: number;
}

/** A created handoff: its id and what the inbox shows. */
export interface CreatedHandoff {
  id: string;
  viewerUrl: string | null;
  pageTitle: string | null;
  /** The page's URL as the browser reported it: used, never stored (E48.5: a takeover on Google's sign-in links to the guided sign-in). */
  pageUrl?: string | null;
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
    ...(req.rememberLabel ? { remember: { label: req.rememberLabel } } : {}),
    ...(req.offerSave ? { offer_save: true } : {}),
    timeout_ms: req.timeoutMs,
  };
}
