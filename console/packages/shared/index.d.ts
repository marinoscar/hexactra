/** The product's display name (`identity.json` `productName`). */
export declare const APP_NAME: string;
/** One-line description (`identity.json` `tagline`). */
export declare const APP_TAGLINE: string;
/** `APP_NAME` slugified: lowercase, hyphenated, never empty. */
export declare const APP_SLUG: string;
/** `owner/name` of the app's GitHub repository. */
export declare const REPO_SLUG: string;
/** `https://github.com/<REPO_SLUG>`. */
export declare const REPO_URL: string;
/** Brand primary colour, `#rrggbb`. */
export declare const THEME_COLOR: string;
/** First-paint background colour, `#rrggbb`. */
export declare const BACKGROUND_COLOR: string;
/** The CLI binary name; seeds its config directory and `<NAME>_` environment prefix. */
export declare const CLI_NAME: string;
/**
 * The fields the Android companion's identity derives from: the product name, the
 * repository slug and the optional `android` block of `identity.json` (each field
 * overrides one derived default).
 */
export declare const ANDROID_IDENTITY_SOURCE: {
  readonly productName: string;
  readonly repoSlug: string;
  readonly android?: {
    readonly applicationId?: string;
    readonly deepLinkScheme?: string;
    readonly storagePrefix?: string;
    readonly apkStem?: string;
  };
};
/** An optional platform slice the starter can mount (`slices.json` `catalog`). */
export type SliceId =
  | 'credentials'
  | 'storage'
  | 'email'
  | 'notifications'
  | 'sharing'
  | 'ai'
  | 'db-backup'
  | 'exports'
  | 'onboarding'
  | 'android-app'
  | 'telemetry';
/** Every optional slice the starter can mount, in mount order (dependencies first). */
export declare const SLICE_IDS: readonly SliceId[];
/** What each slice is and requires, in mount order. */
export declare const SLICE_CATALOG: Readonly<Record<SliceId, { readonly label: string; readonly requires: readonly SliceId[] }>>;
/**
 * Validates slice ids against the catalog and returns them in mount order; throws on an unknown id, a
 * duplicate or a missing requirement, naming the slice and the line to add or remove.
 */
export declare function resolveSliceIds(
  ids: readonly string[],
  catalog?: Readonly<Record<string, { readonly requires: readonly string[] }>>,
): readonly SliceId[];
/** The slices this app mounts: `slices.json` `enabled`, validated, in mount order. */
export declare const ENABLED_SLICES: readonly SliceId[];
/** Where a capability lives on one surface: one value, several, or why it is absent. */
export type CapabilitySurface = string | readonly string[] | { readonly none: string };
/** One capability (`capabilities.json`). */
export interface Capability {
  readonly id: string;
  readonly description: string;
  /** REST operations, `METHOD /api/path` with OpenAPI `{param}` segments. */
  readonly rest: readonly string[];
  /** CLI command paths, e.g. `tasks list`. */
  readonly cli: CapabilitySurface;
  /** MCP tool names. */
  readonly mcp: CapabilitySurface;
  /** TUI screen routes. */
  readonly tui: CapabilitySurface;
  /** Web routes, e.g. `/runs/:id`. */
  readonly web: CapabilitySurface;
}
/** Every capability and where it lives on each surface; each surface's tests check it. */
export declare const CAPABILITIES: readonly Capability[];
/** App REST operations that are not client capabilities, with the reason. */
export declare const REST_EXEMPT: Readonly<Record<string, string>>;
/** One entry of the diagnostics remedy table (`diagnostics.json`). */
export interface DiagnosticRemedy {
  readonly title: string;
  readonly remedy: string;
  /** Who can fix it. */
  readonly who: 'owner' | 'admin';
  /** Where to fix it: the owner's Connections page, Administration, the provider's own console, or the owner's Web search settings. */
  readonly link?: 'settings' | 'admin' | 'provider_console' | 'web_search';
}
/** The remedy table, keyed by code (`UNAVAILABLE`, `GRANT_REVOKED`, ...). */
export declare const DIAGNOSTIC_REMEDIES: Readonly<Record<string, DiagnosticRemedy>>;

/** One MCP server preset (`mcp-presets.json`): what the Add dialog fills in. Never a secret, never a tool mode. */
export interface McpPreset {
  readonly id: string;
  readonly name: string;
  readonly url: string;
  readonly auth: 'oauth' | 'bearer' | 'header' | 'none';
  readonly headerName?: string;
  readonly docsUrl: string;
  readonly notes: string;
  /** The date the address was checked against the vendor's own documentation (`YYYY-MM-DD`). */
  readonly verified: string;
}
export declare const MCP_PRESETS: readonly McpPreset[];
