// Pricing a browser-agent model call, and adding up what a run used.
//
// Pure: no I/O, no clock. The price table is the admin's `agentPricing`
// system setting (agent-pricing.settings.ts), read by the caller and passed
// in; nothing here knows a price. Prices are USD per million tokens.
//
// `AiUsage.inputTokens` INCLUDES the cached input tokens in every adapter
// (the Anthropic mapper adds cache reads and writes to it), so the uncached
// part is `input - cached`. A model with no price is `null`, never 0: the
// run then shows "at least" its cost instead of a wrong exact figure.

/** What one model costs, in USD per million tokens. */
export interface ModelPrice {
  inputPerMTok: number;
  outputPerMTok: number;
  /** Price of an input token served from the provider's cache; absent bills it as input. */
  cachedInputPerMTok?: number;
}

/** The price table: `'<provider>:<modelId>'` to its price. */
export type PriceTable = Readonly<Record<string, ModelPrice>>;

/** The token counts of one call (what `AiUsage` reports; an unreported count is zero). */
export interface CallUsage {
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
}

/** Decimal places a stored cost keeps (`runs.cost_usd` is Decimal(12,6)). */
export const COST_DECIMALS = 6;
const MICROS = 10 ** COST_DECIMALS;

/** The key of a model in the price table. */
export function priceKey(provider: string, model: string): string {
  return `${provider}:${model}`;
}

/** USD rounded to `COST_DECIMALS` places. */
export function roundUsd(usd: number): number {
  return Math.round(usd * MICROS) / MICROS;
}

function count(n: number | undefined): number {
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : 0;
}

/** The cost of `usage` at `price`, rounded to 6 places. */
export function priceUsage(price: ModelPrice, usage: CallUsage): number {
  const input = count(usage.inputTokens);
  const output = count(usage.outputTokens);
  // A provider cannot serve more from the cache than it was given.
  const cached = Math.min(count(usage.cachedInputTokens), input);
  const cachedRate = price.cachedInputPerMTok ?? price.inputPerMTok;
  const usd = ((input - cached) * price.inputPerMTok + cached * cachedRate + output * price.outputPerMTok) / 1_000_000;
  return roundUsd(usd);
}

/**
 * The cost in USD of one call to `provider`/`model`, or `null` when the model
 * has no price (unknown, never free). An unpriced model whose price is listed
 * as 0 is priced: 0 is a decision of the admin.
 */
export function priceCall(provider: string, model: string, usage: CallUsage, prices: PriceTable | null | undefined): number | null {
  const price = prices?.[priceKey(provider, model)];
  return price ? priceUsage(price, usage) : null;
}

/** What `RunUsage` hands to be saved: the increments since the last `drain`. */
export interface UsageDelta {
  modelCalls: number;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  /** USD of the priced calls, at most 6 decimal places. */
  costUsd: number;
  /** False when at least one call could not be priced: `costUsd` is then a lower bound. */
  costKnown: boolean;
  /** The priced and unpriced calls by model served, for the run page (no secrets, no user data). */
  byModel: Record<string, { calls: number; costUsd: number | null }>;
}

/**
 * Adds up the calls of a run between two saves. Cost is kept in whole
 * micro-dollars so that a long run does not drift in floating point.
 * The budget engine (#404) reads the same totals through `delta()`.
 */
export class RunUsage {
  private calls = 0;
  private input = 0;
  private output = 0;
  private cached = 0;
  private micros = 0;
  private known = true;
  private models: Record<string, { calls: number; micros: number; known: boolean }> = {};

  /**
   * Count one model call. `provider` and `model` are what actually served it
   * (`response.provider`, `response.model`); pass what was asked for only
   * when the response names none. An empty model is priced as unknown.
   */
  add(provider: string | undefined, model: string | undefined, usage: CallUsage | undefined, prices: PriceTable | null | undefined): number | null {
    const u = usage ?? {};
    this.calls += 1;
    this.input += count(u.inputTokens);
    this.output += count(u.outputTokens);
    this.cached += Math.min(count(u.cachedInputTokens), count(u.inputTokens));
    const usd = provider && model ? priceCall(provider, model, u, prices) : null;
    const label = provider && model ? priceKey(provider, model) : 'unknown';
    const entry = (this.models[label] ??= { calls: 0, micros: 0, known: true });
    entry.calls += 1;
    if (usd === null) {
      this.known = false;
      entry.known = false;
    } else {
      this.micros += Math.round(usd * MICROS);
      entry.micros += Math.round(usd * MICROS);
    }
    return usd;
  }

  /** True once a call was added since the last `drain`. */
  get dirty(): boolean {
    return this.calls > 0;
  }

  /** The totals since the last `drain`, without resetting. */
  delta(): UsageDelta {
    return {
      modelCalls: this.calls,
      inputTokens: this.input,
      outputTokens: this.output,
      cachedInputTokens: this.cached,
      costUsd: this.micros / MICROS,
      costKnown: this.known,
      byModel: Object.fromEntries(Object.entries(this.models).map(([k, v]) => [k, { calls: v.calls, costUsd: v.known ? v.micros / MICROS : null }])),
    };
  }

  /** The totals since the last `drain`, then start again from zero. */
  drain(): UsageDelta {
    const d = this.delta();
    this.calls = this.input = this.output = this.cached = this.micros = 0;
    this.known = true;
    this.models = {};
    return d;
  }
}
