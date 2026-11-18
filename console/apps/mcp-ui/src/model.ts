// What the run card knows about a run, read from tool results. Pure
// functions: every string here comes from a tool result (and so, partly,
// from web pages and the agent) and is only ever rendered as text.

/** The only server tools this bundle ever calls (the build checks the file holds no other tool name). */
export const ALLOWED_TOOLS = ['run_card_poll', 'run_wait', 'run_status', 'run_cancel', 'task_run'] as const;
export type AllowedTool = (typeof ALLOWED_TOOLS)[number];

/** The typed question of a waiting run (the progress block's `question`). */
export interface CardQuestion {
  id: string;
  input: string;
  prompt: string;
  answerable_here: boolean;
  how_to_answer?: string;
}

/** The progress block (#463) the card reads. */
export interface CardProgress {
  run_id: string;
  status: string;
  cursor: string;
  activity: string;
  steps_done: number;
  elapsed_s: number;
  needs_human: boolean;
  question?: CardQuestion;
  result?: string;
  stop_reason?: string;
  budget?: Record<string, number | null>;
  console_url: string;
  screenshot?: 'included' | 'unavailable' | 'hidden';
  screenshot_note?: string;
}

/** The run fields the card reads (the REST run, without steps). */
export interface CardRun {
  id: string;
  goal?: string;
  status?: string;
  taskId?: string | null;
  stopReason?: string | null;
  costUsd?: number;
  costKnown?: boolean;
  currentTier?: string | null;
  policy?: { name?: string } | null;
  trigger?: string;
}

/** A supersession key minted by the server (`card_key`). */
export interface CardKey {
  created_at: number;
  seq: number;
}

/** One tool result, as the card uses it. */
export interface Snapshot {
  progress: CardProgress;
  run?: CardRun;
  image?: { data: string; mimeType: string };
  key?: CardKey;
}

/** The parts of an MCP `CallToolResult` the card reads. */
export interface ToolResultLike {
  content?: unknown[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

const IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

function obj(v: unknown): Record<string, unknown> | undefined {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

function num(v: unknown, d = 0): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : d;
}

function progressOf(v: unknown): CardProgress | undefined {
  const p = obj(v);
  if (!p || typeof p.run_id !== 'string' || typeof p.status !== 'string') return undefined;
  const q = obj(p.question);
  const budget = obj(p.budget);
  return {
    run_id: p.run_id,
    status: p.status,
    cursor: str(p.cursor) ?? '',
    activity: str(p.activity) ?? '',
    steps_done: num(p.steps_done),
    elapsed_s: num(p.elapsed_s),
    needs_human: p.needs_human === true,
    ...(q && typeof q.id === 'string'
      ? { question: { id: q.id, input: str(q.input) ?? '', prompt: str(q.prompt) ?? '', answerable_here: q.answerable_here === true, ...(str(q.how_to_answer) ? { how_to_answer: str(q.how_to_answer) } : {}) } }
      : {}),
    ...(str(p.result) !== undefined ? { result: str(p.result) } : {}),
    ...(str(p.stop_reason) !== undefined ? { stop_reason: str(p.stop_reason) } : {}),
    ...(budget ? { budget: Object.fromEntries(Object.entries(budget).map(([k, x]) => [k, typeof x === 'number' ? x : null])) } : {}),
    console_url: str(p.console_url) ?? '',
    ...(p.screenshot === 'included' || p.screenshot === 'unavailable' || p.screenshot === 'hidden' ? { screenshot: p.screenshot } : {}),
    ...(str(p.screenshot_note) ? { screenshot_note: str(p.screenshot_note) } : {}),
  };
}

function runOf(v: Record<string, unknown>): CardRun | undefined {
  if (typeof v.id !== 'string') return undefined;
  const policy = obj(v.policy);
  return {
    id: v.id,
    ...(str(v.goal) !== undefined ? { goal: str(v.goal) } : {}),
    ...(str(v.status) ? { status: str(v.status) } : {}),
    taskId: str(v.taskId) ?? null,
    stopReason: str(v.stopReason) ?? null,
    ...(typeof v.costUsd === 'number' ? { costUsd: v.costUsd } : {}),
    ...(typeof v.costKnown === 'boolean' ? { costKnown: v.costKnown } : {}),
    currentTier: str(v.currentTier) ?? null,
    policy: policy && typeof policy.name === 'string' ? { name: policy.name } : null,
    ...(str(v.trigger) ? { trigger: str(v.trigger) } : {}),
  };
}

/** The structured result: `structuredContent`, else the JSON after a text block's summary line (hosts that drop structured content). */
function structured(r: ToolResultLike): Record<string, unknown> | undefined {
  if (obj(r.structuredContent)) return r.structuredContent;
  for (const c of r.content ?? []) {
    const b = obj(c);
    const text = b?.type === 'text' ? str(b.text) : undefined;
    if (!text) continue;
    const at = text.indexOf('{');
    if (at < 0) continue;
    try {
      const v = obj(JSON.parse(text.slice(at)));
      if (v) return v;
    } catch {
      // not JSON: a plain sentence
    }
  }
  return undefined;
}

/**
 * A tool result as a snapshot: a run with `progress` (run_goal, task_run,
 * run_status, run_cancel, run_card_poll) or a bare progress block
 * (run_wait), the first image, and the supersession key. `undefined` for an
 * error or anything else.
 */
export function snapshotOf(r: ToolResultLike | undefined | null): Snapshot | undefined {
  if (!r || r.isError) return undefined;
  const s = structured(r);
  if (!s) return undefined;
  const nested = progressOf(s.progress);
  const progress = nested ?? progressOf(s);
  if (!progress) return undefined;
  const run = nested ? runOf(s) : undefined;
  let image: Snapshot['image'];
  for (const c of r.content ?? []) {
    const b = obj(c);
    if (b?.type === 'image' && typeof b.data === 'string' && typeof b.mimeType === 'string' && IMAGE_MIMES.has(b.mimeType) && /^[A-Za-z0-9+/=]+$/.test(b.data.slice(0, 200))) {
      image = { data: b.data, mimeType: b.mimeType };
      break;
    }
  }
  const k = obj(s.card_key);
  const key = k && typeof k.created_at === 'number' && typeof k.seq === 'number' ? { created_at: k.created_at, seq: k.seq } : undefined;
  return { progress, ...(run ? { run } : {}), ...(image ? { image } : {}), ...(key ? { key } : {}) };
}

export const TERMINAL = new Set(['succeeded', 'failed', 'cancelled']);

/** The eight states the card draws. */
export type CardState = 'queued' | 'running' | 'waiting' | 'succeeded' | 'failed' | 'cancelled' | 'budget' | 'stalled';

/** The card state of a run: a budget or a stall stop is its own state, whatever the final status. */
export function cardState(p: CardProgress, run?: CardRun): CardState {
  const reason = run?.stopReason ?? '';
  if (TERMINAL.has(p.status)) {
    if (reason.startsWith('budget_') || /limit of its policy/.test(p.stop_reason ?? '')) return 'budget';
    if (reason === 'stalled' || (p.stop_reason ?? '').startsWith('Stopped: it was stuck')) return 'stalled';
    return p.status as CardState;
  }
  if (p.status === 'waiting_human' || p.needs_human) return 'waiting';
  if (p.status === 'queued') return 'queued';
  return 'running';
}

export const STATE_LABEL: Readonly<Record<CardState, string>> = {
  queued: 'Queued',
  running: 'Running',
  waiting: 'Needs you',
  succeeded: 'Finished',
  failed: 'Failed',
  cancelled: 'Stopped',
  budget: 'Budget reached',
  stalled: 'Stalled',
};

export function isTerminal(s: CardState): boolean {
  return s === 'succeeded' || s === 'failed' || s === 'cancelled' || s === 'budget' || s === 'stalled';
}

/** The budgets the meter shows (actions, cost, active minutes), with their labels. */
const METER_KEYS: readonly [string, string][] = [
  ['actions', 'Actions'],
  ['cost', 'Cost'],
  ['activeMinutes', 'Active time'],
];

/** The budget closest to its limit, or `null` when every one of them is unlimited (the meter is hidden). */
export function budgetMeter(budget: Record<string, number | null> | undefined): { label: string; percent: number } | null {
  let best: { label: string; percent: number } | null = null;
  for (const [k, label] of METER_KEYS) {
    const v = budget?.[k];
    if (typeof v !== 'number') continue;
    if (!best || v > best.percent) best = { label, percent: Math.max(0, Math.min(100, v)) };
  }
  return best;
}

/** "6 s", "1 min 40 s", "2 h 5 min". */
export function formatDuration(seconds: number): string {
  const n = Math.max(0, Math.floor(seconds));
  if (n < 60) return `${n} s`;
  if (n < 3600) return `${Math.floor(n / 60)} min ${n % 60} s`;
  return `${Math.floor(n / 3600)} h ${Math.floor((n % 3600) / 60)} min`;
}

export function formatCost(run: CardRun | undefined): string | null {
  if (!run || typeof run.costUsd !== 'number' || run.costUsd <= 0) return null;
  const v = `$${run.costUsd < 0.01 ? run.costUsd.toFixed(4) : run.costUsd.toFixed(2)}`;
  return run.costKnown === false ? `at least ${v}` : v;
}

/** An http(s) URL, or `null`: the only links the card opens. */
export function safeUrl(v: string | undefined): string | null {
  if (!v) return null;
  try {
    const u = new URL(v);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.toString() : null;
  } catch {
    return null;
  }
}

/** The console page that answers a question (the inbox), from the run's console URL. */
export function inboxUrl(consoleUrl: string, questionId: string): string | null {
  const base = safeUrl(consoleUrl);
  if (!base) return null;
  return `${new URL(base).origin}/inbox/q/${encodeURIComponent(questionId)}`;
}

/** The first 120 characters of a goal, and whether there is more. */
export function shortGoal(goal: string): { text: string; more: boolean } {
  const one = goal.replace(/\s+/g, ' ').trim();
  return one.length > 120 ? { text: `${one.slice(0, 119)}…`, more: true } : { text: one, more: false };
}
