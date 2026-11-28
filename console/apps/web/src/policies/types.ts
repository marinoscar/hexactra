// The wire shapes of the agent policy feature (epic #398), as the web app reads
// them. The API is the source of truth: `apps/api/src/policies/` (#401), the
// model tiers (#403), the budget ceilings (#404), export and import (#402).
// Field names here are aligned with those schemas; the HTTP calls are all in
// `./api.ts`.

/** The three fixed model tiers, cheapest first. */
export const TIERS = ['fast', 'standard', 'frontier'] as const;
export type Tier = (typeof TIERS)[number];

export const TIER_LABEL: Record<Tier, string> = { fast: 'Fast', standard: 'Standard', frontier: 'Frontier' };

export const STALL_ACTIONS = ['nudge_then_escalate', 'escalate', 'ask_human', 'fail'] as const;
export type StallAction = (typeof STALL_ACTIONS)[number];

/** The six budget limits; each may be `null` (unlimited). */
export const BUDGET_LIMIT_KEYS = ['maxActions', 'maxModelCalls', 'maxActiveMinutes', 'maxInputTokens', 'maxOutputTokens', 'maxCostUsd'] as const;
export type BudgetLimitKey = (typeof BUDGET_LIMIT_KEYS)[number];

export interface AgentPolicySpec {
  schemaVersion: 1;
  models: {
    startTier: Tier;
    maxTier: Tier;
    allowProviderFallback: boolean;
    pins?: Partial<Record<Tier, string | null>>;
  };
  /** `maxWebCalls` (E50.7): web searches and page reads; a refused call over it, never a stop, so it is not one of the limits above. */
  budget: Record<BudgetLimitKey, number | null> & { maxWebCalls?: number | null; warnAtPercent: number };
  stall: {
    maxConsecutiveFailures: number;
    maxRepeatedAction: number;
    noProgressActions: number;
    onStall: StallAction;
    maxEscalations: number;
  };
  context: {
    screenshotsKept: number;
    pruneBatch: number;
    callsPerChunk: number;
    observationChars: number;
    /** E54.1: absent or 1 = one action per model reply. */
    actionsPerReply?: number;
  };
}

/** `GET /api/agent-policies` and `GET /api/agent-policies/:id`. */
export interface AgentPolicy {
  /** A UUID, or `builtin:<key>`. */
  id: string;
  name: string;
  description: string | null;
  version: number;
  builtin: boolean;
  spec: AgentPolicySpec;
  isDefault: boolean;
  usage: { tasks: number; schedules: number };
  hasNoHardStop: boolean;
  createdAt: string | null;
  updatedAt: string | null;
}

/** `GET` / `PUT /api/agent-policies/default`. */
export interface DefaultPolicy {
  policyId: string;
  explicit: boolean;
}

/** The `details` of a 409 `POLICY_IN_USE`. */
export interface PolicyInUseDetails {
  tasks: { id: string; name: string }[];
  schedules: { id: string; taskId: string }[];
}

// ---- Export and import (#402) ----

export const CONFLICT_MODES = ['rename', 'skip', 'replace'] as const;
export type ConflictMode = (typeof CONFLICT_MODES)[number];

/** The portable file (`kind: 'hexactra.agent-policies'`). */
export interface PolicyFile {
  kind: string;
  formatVersion: number;
  exportedAt?: string;
  policies: { name: string; description: string | null; spec: unknown }[];
}

/** `POST /api/agent-policies/import`. */
export interface ImportResult {
  created: { index: number; id: string; name: string; renamedFrom: string | null }[];
  replaced: { index: number; id: string; name: string; version: number }[];
  skipped: { index: number; name: string; reason: string }[];
  warnings: { index: number; name: string; code: string; message: string }[];
  errors: { index: number; name: string | null; issues: { path: string; message: string }[] }[];
}

// ---- Model tiers (#403) ----

export const TIER_EFFORTS = ['none', 'low', 'medium', 'high'] as const;
export type TierEffort = (typeof TIER_EFFORTS)[number];

/** One tier's definition: `null` means not set. */
export interface TierDef {
  model: string | null;
  reasoningEffort: TierEffort | null;
  maxOutputTokens: number | null;
  fallbackModel: string | null;
}

export type ModelTiers = Record<Tier, TierDef>;
/** The user's overrides: a tier absent means "inherit from the deployment". */
export type ModelTiersOverride = Partial<Record<Tier, Partial<TierDef>>>;

export type ModelSource = 'pin' | 'user' | 'deployment' | 'fill_down' | 'ai_default';

/** One tier of `GET /api/agent-policies/model-tiers/effective`. */
export interface EffectiveTier {
  model: string | null;
  provider?: string | null;
  modelSource: ModelSource | null;
  borrowedFrom?: Tier | null;
  reasoningEffort: TierEffort | null;
  effortSource?: 'user' | 'deployment' | null;
  maxOutputTokens: number | null;
  maxOutputTokensSource?: 'user' | 'deployment' | null;
  fallbackModel: string | null;
  fallbackSource?: 'user' | 'deployment' | null;
  vision: boolean | null;
  tools: boolean | null;
  usable?: boolean;
  problem?: string | null;
}
export type EffectiveTiers = Record<Tier, EffectiveTier>;

// ---- Budget ceilings (#404) ----

/** The `browserAgentCeilings` system namespace: the same keys as a policy's budget limits. */
export type BudgetCeilings = Record<BudgetLimitKey, number | null>;

// ---- Prices (#400) ----

export interface ModelPrice {
  inputPerMTok: number;
  outputPerMTok: number;
  cachedInputPerMTok?: number;
}

/** The `agentPricing` system namespace. */
export interface AgentPricing {
  currency: 'USD';
  models: Record<string, ModelPrice>;
}

/** What `GET /api/system-settings` carries for this feature. */
export interface AgentSystemSettings {
  version: number;
  agentPricing?: AgentPricing;
  browserAgentTiers?: ModelTiers;
  browserAgentCeilings?: BudgetCeilings;
}
