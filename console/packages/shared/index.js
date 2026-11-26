// The app's identity, read from identity.json (the single identity source).
// `scripts/rename.mjs` rewrites identity.json and the few literal targets no
// runtime read can reach; everything else derives from these exports.
const identity = require('./identity.json');

/** Lowercase, hyphenated, never empty: the rule `scripts/rename.mjs` uses too. */
function slugify(name) {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug.length > 0 ? slug : 'app';
}

exports.APP_NAME = identity.productName;
exports.APP_TAGLINE = identity.tagline;
exports.APP_SLUG = slugify(identity.productName);
exports.REPO_SLUG = identity.repoSlug;
exports.REPO_URL = `https://github.com/${identity.repoSlug}`;
exports.THEME_COLOR = identity.themeColor;
exports.BACKGROUND_COLOR = identity.backgroundColor;
exports.CLI_NAME = identity.cliName;

/**
 * The fields the Android companion's identity derives from: the product name,
 * the repository slug and the optional `android` block of `identity.json`
 * (`{ applicationId?, deepLinkScheme?, storagePrefix?, apkStem? }`), frozen.
 * Pass it to `androidIdentity()` of `@marinoscar/platform-contract/android-app`.
 */
exports.ANDROID_IDENTITY_SOURCE = Object.freeze({
  productName: identity.productName,
  repoSlug: identity.repoSlug,
  ...(identity.android ? { android: Object.freeze({ ...identity.android }) } : {}),
});

// The optional platform slices this app mounts, from slices.json (the slice
// manifest). Validated here, once, so the API and the web app (which both import
// this) fail at startup with the same message and never disagree about the list.
const manifest = require('./slices.json');

/** Every optional slice the starter can mount, in mount order (dependencies first). */
exports.SLICE_IDS = Object.freeze(Object.keys(manifest.catalog));

/** `{ [id]: { label, requires } }` for every slice, in mount order. */
exports.SLICE_CATALOG = Object.freeze(manifest.catalog);

/**
 * Validates a list of slice ids against the catalog and returns it in mount
 * order: an unknown id, a duplicate, or a slice whose `requires` is not in the
 * list throws, naming the slice and the line to add or remove.
 */
function resolveSliceIds(ids, catalog = manifest.catalog) {
  const known = Object.keys(catalog);
  const seen = new Set();
  for (const id of ids) {
    if (!known.includes(id)) throw new Error(`packages/shared/slices.json: unknown slice "${id}". Known slices: ${known.join(', ')}.`);
    if (seen.has(id)) throw new Error(`packages/shared/slices.json: slice "${id}" is listed twice.`);
    seen.add(id);
  }
  const ordered = known.filter((id) => seen.has(id));
  for (const id of ordered) {
    const missing = catalog[id].requires.filter((required) => !seen.has(required));
    if (missing.length > 0) {
      throw new Error(
        `packages/shared/slices.json: slice "${id}" requires ${missing.map((m) => `"${m}"`).join(', ')}. ` +
          `Add ${missing.length === 1 ? 'it' : 'them'} to "enabled", or remove "${id}" too.`,
      );
    }
  }
  return ordered;
}
exports.resolveSliceIds = resolveSliceIds;

/** The ids in `slices.json` `enabled`, validated, in mount order. */
exports.ENABLED_SLICES = Object.freeze(resolveSliceIds(manifest.enabled));

/**
 * Every Hexactra capability and where it lives on each surface (REST, CLI,
 * MCP, TUI, web): `capabilities.json`, checked by each surface's tests.
 */
exports.CAPABILITIES = Object.freeze(require('./capabilities.json').capabilities);
/** App REST operations that are not client capabilities, with the reason. */
exports.REST_EXEMPT = Object.freeze(require('./capabilities.json').restExempt);

/**
 * The remedy table of diagnostics (E50.10): for each code a diagnostic stage or
 * a connection test returns, its title, its remedy in plain words, who can fix
 * it and where. `diagnostics.json`, read by the API, the web app and the CLI.
 */
exports.DIAGNOSTIC_REMEDIES = Object.freeze(require('./diagnostics.json').codes);

/**
 * The MCP server presets (E50.12): a short, reviewed list of well-known public servers the Add dialog offers. Data only: an address, the
 * kind of sign-in and a documentation link, each checked against the vendor's own documentation on its `verified` date. Never a secret,
 * never a tool mode. `mcp-presets.json`, served by the API (`GET /api/connections/mcp/presets`) after the administrator's host lists.
 */
exports.MCP_PRESETS = Object.freeze(require('./mcp-presets.json').presets.map((p) => Object.freeze({ ...p })));
