// Search providers in the host (E50.5, #975; epic E50 Design §2, decision record `docs/decisions/web-search.md` §1).
//
// One interface for every search API the console can call for the agent's `web_search` tool. An adapter is one file under
// `providers/`, an injectable that registers itself here from its `onModuleInit`. The id is PERMANENT: it names the stored key
// (`web_search.<id>`), the settings (`webSearch.providers.<id>`), the usage rows and a metric label.
//
// A provider receives its key (`ProviderAuth`) at the moment of the request only, and throws nothing but `WebToolError` (a closed
// code): never a provider's own message, a URL with a key, or the query.
import { Injectable, Optional } from '@nestjs/common';
import type { WebSearchResult } from '@marinoscar/hexactra-web-agent';

import type { SecretBytes } from '../secrets/secrets-provider.port';
import { CREDENTIAL_TIERS } from '../service-credentials/service-credential.port';
import { apiKeyShape, ServiceCredentialRegistry } from '../service-credentials/service-credential.registry';
import type { DiagnosticStage } from './diagnostic-stage';

export type { WebSearchResult };

/** What a provider needs to make a call. `api_key`: the caller wipes the key after the call. */
export type ProviderAuth = { kind: 'api_key'; key: SecretBytes } | { kind: 'none'; baseUrl: string } | { kind: 'ai_service'; userId: string; orgId: string | null };

export interface SearchRequest {
  query: string;
  count: number;
  freshness: 'day' | 'week' | 'month' | 'year' | null;
  /** A host name; the adapter turns it into the provider's site filter (`site:` for Brave). */
  site: string | null;
  signal: AbortSignal;
}

export interface SearchProvider {
  /** Permanent: `brave`. */
  readonly id: string;
  /** What people see: `Brave Search`. */
  readonly label: string;
  /** `results` fills hits; `answer` writes an answer and cites hits (decision record §1). */
  readonly kind: 'results' | 'answer';
  /** What the provider authenticates with. `api_key` is stored as the service credential `web_search.<id>`. */
  readonly credential: 'api_key' | 'none' | 'ai_service';
  /** The hosts it calls, for the egress list. */
  readonly hosts: readonly string[];
  /** A DEFAULT estimate in USD per call, from the decision record; the administrator overrides it. Never shown as a fact. */
  readonly estimatedCostPerCallUsd: number | null;
  /** Throws `WebToolError`, never a provider message. */
  search(req: SearchRequest, auth: ProviderAuth): Promise<WebSearchResult>;
  /** The provider's own diagnostic stages (E50.13 adds more). Never a key, a query or a provider message. */
  diagnose(auth: ProviderAuth | null, signal: AbortSignal): Promise<DiagnosticStage[]>;
}

/** A provider id: lower-case, permanent. */
export const SEARCH_PROVIDER_ID_PATTERN = /^[a-z][a-z0-9_]{0,31}$/;

/** The service of every search provider's stored key: `{ service: 'web_search', name: <provider id> }`. */
export const WEB_SEARCH_SERVICE = 'web_search';

export const credentialRefOf = (providerId: string) => ({ service: WEB_SEARCH_SERVICE, name: providerId });

@Injectable()
export class SearchProviderRegistry {
  private readonly providers = new Map<string, SearchProvider>();

  constructor(@Optional() private readonly credentials?: ServiceCredentialRegistry) {}

  /**
   * Registers an adapter and, for a provider with a key, its service credential reference (`web_search.<id>`, label
   * "<label> API key", every tier, the API key shape check). A malformed id or a second provider with the same id is a programming
   * error and fails at boot.
   */
  register(provider: SearchProvider): void {
    if (!SEARCH_PROVIDER_ID_PATTERN.test(provider.id)) throw new Error(`Search provider id "${provider.id}" is malformed: it matches ${String(SEARCH_PROVIDER_ID_PATTERN)}`);
    if (this.providers.has(provider.id)) throw new Error(`Search provider "${provider.id}" is already registered`);
    this.providers.set(provider.id, provider);
    if (provider.credential === 'api_key') this.credentials?.register({ ref: credentialRefOf(provider.id), label: `${provider.label} API key`, tiers: CREDENTIAL_TIERS, validate: apiKeyShape });
  }

  get(id: string): SearchProvider | null {
    return this.providers.get(id) ?? null;
  }

  /** Every provider, in registration order. */
  list(): SearchProvider[] {
    return [...this.providers.values()];
  }

  /** The registered ids: the bounded values of the `provider` metric label. */
  ids(): string[] {
    return [...this.providers.keys()];
  }
}
