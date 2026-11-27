// OpenAI web search (E50.9, #979): the first ANSWER-type search provider. Decision record `docs/decisions/web-search.md` §1 (the
// OpenAI row) and §2.
//
//   AiService.forUser(userId, { orgId, feature: 'web_search' }).respond({
//     provider: 'openai', model: <webSearch.providers.openai.model>,
//     instructions: <fixed>, input: <the query, plus the site and freshness asked for>,
//     tools: [{ type: 'web_search', searchContextSize: 'low' }], toolChoice: 'required', maxOutputTokens: 800,
//   }, { signal })
//   message text → answer.text; message citations (url, title, the cited span) → answer.citations and hits;
//   hosted_tool_call items with tool 'web_search' → the number of searches made.
//
// No key is handled here: the AI service resolves the caller's OpenAI key (the user's own, the organization's or the deployment's,
// under the administrator's AI policy), meters the tokens under the "Web search" feature and holds the connection. The search fee
// is counted by the web search service in `web_search_usage` (`estimatedCostPerCallUsd` is the fee only, never the tokens).
//
// THE RULE (decision record §2): the hosted `web_search` tool is attached ONLY here, inside this adapter, which runs because the
// agent called the `web_search` tool through `executeTool` (Stop, Pause, the gates, the span and the step record). It is never
// attached to the agent's own model calls. `test/architecture/hosted-web-search.spec.ts` fails when it appears elsewhere.
//
// The model is not the run's: this is not a `browser_agent` call, so rule 1 of "Agent run policies" (console AGENTS.md: every
// browser-agent call goes through the snapshot's tiers) does not apply. It is the administrator's setting
// `webSearch.providers.openai.model`, with no default: until it is set the provider is not usable.
import { Injectable, Optional, type OnModuleInit } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { WEB_CAPS, WebToolError, type WebSearchHit } from '@marinoscar/hexactra-web-agent';
import { AiConfigService, AiService, UsableModelsService, isAiErrorCode, type AiErrorCode, type AiOutputItem, type AiResponse, type AiUrlCitation } from '@marinoscar/platform-api/ai';

import type { StageOutcome } from '../../diagnostics/stages';
import type { DiagnosticStage } from '../diagnostic-stage';
import { SearchProviderRegistry, type ProviderAuth, type ProviderDiagnoseOptions, type ProviderSearchResult, type SearchProvider, type SearchRequest } from '../search-provider';
import { WEB_SEARCH_AI_FEATURE_ID } from '../web-search.feature';
import { DIAGNOSTIC_QUERY, providerStages } from '../web-search-diagnostics';
import { WebSearchService } from '../web-search.service';
import { providerSettingsOf } from '../web-search.settings';
import { capText, clampCount, hitOf, siteOperand } from './provider-kit';

export const OPENAI_SEARCH_PROVIDER_ID = 'openai';
/** The AI provider the call goes to: the key must be an OpenAI key, at some tier. */
export const OPENAI_AI_PROVIDER = 'openai';
/** For the egress entry: the AI service calls OpenAI's API (an administrator's base URL override is the AI slice's). */
export const OPENAI_HOST = 'api.openai.com';
/**
 * The search FEE per call, about USD 10 per 1,000 calls of the standard search tool (decision record §1, 2026-11-26): a default the
 * administrator overrides. The tokens are NOT in it: they are in the AI usage ledger under "Web search".
 */
export const OPENAI_SEARCH_ESTIMATED_FEE_USD = 0.01;
/** The fixed instruction. Never anything a user or a page wrote. */
export const OPENAI_SEARCH_INSTRUCTIONS = 'Answer the question from a web search. Cite the pages.';
/** A small output cap: the answer is at most 4,000 characters for the model anyway. */
export const OPENAI_SEARCH_MAX_OUTPUT_TOKENS = 800;
/** At most this many cited pages become hits. */
export const OPENAI_SEARCH_MAX_HITS = 10;

const FRESHNESS_WORDS: Record<NonNullable<SearchRequest['freshness']>, string> = { day: 'the past day', week: 'the past week', month: 'the past month', year: 'the past year' };

/** The codes of this provider's own diagnostics (each has a remedy entry in `packages/shared/diagnostics.json`). */
export const OPENAI_SEARCH_DIAGNOSTIC_CODES = ['AI_OFF', 'HOSTED_TOOL_DISABLED', 'AI_KEY_MISSING', 'AI_MODEL_NOT_REACHABLE'] as const;

/** What the adapter needs from the AI slice. Resolved lazily (the slice may not be mounted); a test replaces it. */
export interface OpenAiSearchAi {
  ai: Pick<AiService, 'forUser'>;
  usableModels: Pick<UsableModelsService, 'assertUsable'>;
  config: Pick<AiConfigService, 'resolveForOrg'>;
}

/** The request's input: the query, then the site and freshness asked for in words the search understands. */
export function openAiSearchInput(req: Pick<SearchRequest, 'query' | 'site' | 'freshness'>): string {
  const site = siteOperand(req.site);
  const lines = [site ? `${req.query} site:${site}` : req.query];
  if (site) lines.push(`Use only pages on ${site}.`);
  if (req.freshness) lines.push(`Use only pages published in ${FRESHNESS_WORDS[req.freshness]}.`);
  return lines.join('\n');
}

const CONTROL_KEEP_NEWLINE = new RegExp('[\\u0000-\\u0009\\u000b-\\u001f\\u007f-\\u009f\\u200b-\\u200f\\u2028-\\u202e\\u2060-\\u2064\\ufeff]', 'g');

/** The answer as the model may read it: control and invisible characters removed, line breaks kept, capped like the tool caps it. */
export function answerText(raw: string): string {
  const text = raw
    .replace(CONTROL_KEEP_NEWLINE, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return capText(text, WEB_CAPS.answer);
}

/** The hits of an answer: each cited page once, in the provider's order, the cited span as the snippet; at most `max`. */
export function citedHits(messages: { text: string; citations: readonly AiUrlCitation[] }[], max: number): WebSearchHit[] {
  const out: WebSearchHit[] = [];
  const seen = new Set<string>();
  for (const m of messages) {
    for (const c of m.citations) {
      if (out.length >= max) return out;
      if (!c || typeof c !== 'object') continue;
      const start = Number.isInteger(c.startIndex) ? c.startIndex : 0;
      const end = Number.isInteger(c.endIndex) ? c.endIndex : 0;
      const span = end > start && start >= 0 && end <= m.text.length ? m.text.slice(start, end) : '';
      const hit = hitOf(c.title, c.url, span, null);
      if (!hit || seen.has(hit.url)) continue;
      seen.add(hit.url);
      out.push(hit);
    }
  }
  return out;
}

/** The mapping of one response: the answer, its cited pages and the number of searches made. `UNAVAILABLE` for no answer; no result for an answer that cites no page. */
export function mapOpenAiSearch(res: Pick<AiResponse, 'output'>, count: number): ProviderSearchResult {
  const output: AiOutputItem[] = Array.isArray(res?.output) ? res.output : [];
  const messages = output.filter((o): o is Extract<AiOutputItem, { type: 'message' }> => o?.type === 'message' && typeof o.text === 'string').map((m) => ({ text: m.text, citations: Array.isArray(m.citations) ? m.citations : [] }));
  const text = answerText(messages.map((m) => m.text).join('\n\n'));
  if (!text) throw new WebToolError('UNAVAILABLE');
  const hits = citedHits(messages, clampCount(count, OPENAI_SEARCH_MAX_HITS));
  const searches = output.filter((o) => o?.type === 'hosted_tool_call' && o.tool === 'web_search').length;
  const counted = searches > 0 ? { searches } : {};
  // An answer that cites no page is no result: nothing the model or the owner could check it against (the agent uses the browser).
  if (hits.length === 0) return { provider: OPENAI_SEARCH_PROVIDER_ID, hits: [], answer: null, ...counted };
  return { provider: OPENAI_SEARCH_PROVIDER_ID, hits, answer: { text, citations: hits.map((h) => h.url) }, ...counted };
}

/** The AI service's error code, read without copying its message. */
function aiCodeOf(e: unknown): AiErrorCode | null {
  const code = (e as { code?: unknown } | null)?.code;
  return isAiErrorCode(code) ? code : null;
}

/** An `AiError` as the closed code of a search. The AI service's message is never copied. */
export function openAiSearchFailure(e: unknown, signal: AbortSignal): WebToolError {
  if (signal.aborted) return new WebToolError('ABORTED');
  switch (aiCodeOf(e)) {
    // The key or the AI set-up refuses the call: "not set up correctly", and the next provider is tried.
    case 'AI_KEY_INVALID':
    case 'AI_KEY_REQUIRED':
    case 'AI_DISABLED':
    case 'AI_PROVIDER_DISABLED':
    case 'AI_TOOL_DISABLED':
    case 'AI_MODEL_NOT_ENABLED':
    case 'AI_MODEL_NOT_REACHABLE':
    case 'AI_CAPABILITY_UNSUPPORTED':
      return new WebToolError('AUTH_REFUSED');
    case 'AI_RATE_LIMITED': {
      const after = (e as { retryAfterMs?: unknown }).retryAfterMs;
      return new WebToolError('RATE_LIMITED', typeof after === 'number' && Number.isFinite(after) && after >= 0 ? { retryAfterMs: Math.round(after) } : {});
    }
    default:
      // AI_PROVIDER_UNAVAILABLE, a content filter, an invalid request, anything else.
      return new WebToolError('UNAVAILABLE');
  }
}

@Injectable()
export class OpenAiSearchProvider implements SearchProvider, OnModuleInit {
  readonly id = OPENAI_SEARCH_PROVIDER_ID;
  readonly label = 'OpenAI web search';
  readonly kind = 'answer' as const;
  readonly credential = 'ai_service' as const;
  readonly hosts = [OPENAI_HOST] as const;
  readonly estimatedCostPerCallUsd = OPENAI_SEARCH_ESTIMATED_FEE_USD;
  readonly diagnosticCodes = OPENAI_SEARCH_DIAGNOSTIC_CODES;

  /** Set by a test; otherwise the AI slice's services, looked up when first needed. */
  aiDeps: OpenAiSearchAi | null = null;

  constructor(
    private readonly registry: SearchProviderRegistry,
    /** Where the model comes from: the web search settings (`system()`, cached for a few seconds). */
    private readonly settings: WebSearchService,
    @Optional() private readonly modules?: ModuleRef,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  /** The AI slice's services, or null when it is not mounted (the provider is then never usable). */
  private deps(): OpenAiSearchAi | null {
    if (this.aiDeps) return this.aiDeps;
    if (!this.modules) return null;
    try {
      this.aiDeps = { ai: this.modules.get(AiService, { strict: false }), usableModels: this.modules.get(UsableModelsService, { strict: false }), config: this.modules.get(AiConfigService, { strict: false }) };
      return this.aiDeps;
    } catch {
      return null;
    }
  }

  /** The administrator's model; null when not chosen. An `openai:` prefix is accepted. */
  async model(): Promise<string | null> {
    const raw = providerSettingsOf(await this.settings.system(), this.id).model;
    if (!raw) return null;
    return raw.startsWith(`${OPENAI_AI_PROVIDER}:`) ? raw.slice(OPENAI_AI_PROVIDER.length + 1) || null : raw;
  }

  async search(req: SearchRequest, auth: ProviderAuth): Promise<ProviderSearchResult> {
    if (auth.kind !== 'ai_service') throw new WebToolError('NOT_CONFIGURED');
    if (req.signal.aborted) throw new WebToolError('ABORTED');
    const deps = this.deps();
    const model = await this.model();
    if (!deps || !model) throw new WebToolError('NOT_CONFIGURED');
    let res: AiResponse;
    try {
      res = await deps.ai.forUser(auth.userId, { feature: WEB_SEARCH_AI_FEATURE_ID, ...(auth.orgId ? { orgId: auth.orgId } : {}) }).respond(
        {
          provider: OPENAI_AI_PROVIDER,
          model,
          instructions: OPENAI_SEARCH_INSTRUCTIONS,
          input: openAiSearchInput(req),
          tools: [{ type: 'web_search', searchContextSize: 'low' }],
          toolChoice: 'required',
          maxOutputTokens: OPENAI_SEARCH_MAX_OUTPUT_TOKENS,
        },
        // Stop reaches the AI service: it aborts the provider call (and records a cancelled usage row).
        { signal: req.signal },
      );
    } catch (e) {
      throw openAiSearchFailure(e, req.signal);
    }
    if (req.signal.aborted) throw new WebToolError('ABORTED');
    try {
      return mapOpenAiSearch(res, req.count);
    } catch {
      throw new WebToolError('UNAVAILABLE');
    }
  }

  /**
   * The `credential` stage, and whether the provider is usable for `who` (null: the deployment, the AI keys' system tier): a model is
   * chosen, AI is on, the administrator switched the hosted web search on (`ai.hostedTools.web_search`), and the key that would pay
   * reaches the model with the capabilities the feature needs. The AI service decides which key; none is read here.
   */
  async diagnoseCredential(who: { userId: string; orgId: string | null } | null): Promise<StageOutcome> {
    const model = await this.model();
    if (!model) return { status: 'fail', code: 'MODEL_NOT_CHOSEN' };
    const deps = this.deps();
    if (!deps) return { status: 'fail', code: 'AI_OFF' };
    const orgId = who?.orgId ?? undefined;
    try {
      const policy = await deps.config.resolveForOrg(orgId);
      if (!policy.enabled) return { status: 'fail', code: 'AI_OFF' };
      if (!policy.hostedTools?.web_search) return { status: 'fail', code: 'HOSTED_TOOL_DISABLED' };
      const { keySource } = await deps.usableModels.assertUsable(who?.userId ?? null, OPENAI_AI_PROVIDER, model, ['responses', 'hosted_tools'], orgId ? { orgId } : {});
      return { status: 'pass', data: { model, keySource: String(keySource) } };
    } catch (e) {
      switch (aiCodeOf(e)) {
        case 'AI_DISABLED':
        case 'AI_PROVIDER_DISABLED':
          return { status: 'fail', code: 'AI_OFF' };
        case 'AI_KEY_REQUIRED':
        case 'AI_KEY_INVALID':
          return { status: 'fail', code: 'AI_KEY_MISSING' };
        case 'AI_TOOL_DISABLED':
          return { status: 'fail', code: 'HOSTED_TOOL_DISABLED' };
        case 'AI_MODEL_NOT_ENABLED':
        case 'AI_MODEL_NOT_REACHABLE':
        case 'AI_CAPABILITY_UNSUPPORTED':
        case 'AI_INVALID_REQUEST':
          return { status: 'fail', code: 'AI_MODEL_NOT_REACHABLE', data: { model } };
        default:
          return { status: 'fail', code: 'UNAVAILABLE', remedy: 'SEARCH_UNAVAILABLE' };
      }
    }
  }

  /**
   * `network` is the AI service's: it holds the connection to OpenAI and nothing here can probe it without a key, so the stage is
   * skipped (with why) and the live query, one real answer to the fixed word, proves the path.
   */
  async diagnose(auth: ProviderAuth, signal: AbortSignal, opts: ProviderDiagnoseOptions = {}): Promise<DiagnosticStage[]> {
    return providerStages({
      network: async () => ({ status: 'skipped', data: { through: 'ai_service' } }),
      query: (s) => this.search({ query: DIAGNOSTIC_QUERY, count: 1, freshness: null, site: null, signal: s }, auth),
      signal,
      liveQuery: opts.liveQuery ?? true,
    });
  }
}
