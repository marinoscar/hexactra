// The vocabulary of Connections (E39.2, #599): providers, capabilities, capability groups and the rules that tie them.
// Closed lists on purpose: a capability is a permission the owner switches on, so a new one is a decision, not a string.

/** The services the owner can connect. `mcp` is reserved for E39.9 and has no adapter. */
export const CONNECTION_PROVIDER_IDS = ['google', 'microsoft'] as const;
export type ConnectionProviderId = (typeof CONNECTION_PROVIDER_IDS)[number];

/**
 * What an account may be used for. Read is never write: each write capability brings its read capability.
 * `mail_modify` (archive, labels, mark read, drafts) is the seventh, added by the decision record of E39.1
 * (`docs/decisions/connections-auth.md`): at both providers it needs a higher permission than send (Gmail `gmail.modify` is a
 * restricted scope; Graph `Mail.ReadWrite`), so it is its own switch rather than a free rider on `mail_send`.
 */
export const CAPABILITIES = ['mail_read', 'mail_send', 'mail_modify', 'calendar_read', 'calendar_write', 'docs_read', 'docs_write'] as const;
export type Capability = (typeof CAPABILITIES)[number];

/** The groups the owner sees as Mail, Calendar and Documents, and the unit of a default account. */
export const CAPABILITY_GROUPS = ['mail', 'calendar', 'docs'] as const;
export type CapabilityGroup = (typeof CAPABILITY_GROUPS)[number];

const GROUP_OF: Record<Capability, CapabilityGroup> = {
  mail_read: 'mail',
  mail_send: 'mail',
  mail_modify: 'mail',
  calendar_read: 'calendar',
  calendar_write: 'calendar',
  docs_read: 'docs',
  docs_write: 'docs',
};

const READ_OF: Record<Capability, Capability> = {
  mail_read: 'mail_read',
  mail_send: 'mail_read',
  mail_modify: 'mail_read',
  calendar_read: 'calendar_read',
  calendar_write: 'calendar_read',
  docs_read: 'docs_read',
  docs_write: 'docs_read',
};

export const groupOf = (c: Capability): CapabilityGroup => GROUP_OF[c];
export const isWriteCapability = (c: Capability): boolean => READ_OF[c] !== c;
export const isCapability = (v: unknown): v is Capability => typeof v === 'string' && (CAPABILITIES as readonly string[]).includes(v);
export const isProviderId = (v: unknown): v is ConnectionProviderId => typeof v === 'string' && (CONNECTION_PROVIDER_IDS as readonly string[]).includes(v);

/**
 * The switches as stored: every write capability brings its read capability (the page shows "read" or "read and write", never
 * "write only"), in the order of {@link CAPABILITIES}, without duplicates.
 */
export function normalizeCapabilities(input: Iterable<Capability>): Capability[] {
  const set = new Set<Capability>();
  for (const c of input) {
    set.add(c);
    set.add(READ_OF[c]);
  }
  return CAPABILITIES.filter((c) => set.has(c));
}

/** What a provider's grant allows once a write the provider did not grant (or whose read it did not grant) is dropped. */
export function keepSupported(wanted: readonly Capability[], granted: readonly Capability[]): Capability[] {
  const ok = new Set(granted);
  return normalizeCapabilities(wanted.filter((c) => ok.has(c) && ok.has(READ_OF[c])));
}

/** The groups a set of capabilities touches. */
export const groupsOf = (caps: readonly Capability[]): CapabilityGroup[] => CAPABILITY_GROUPS.filter((g) => caps.some((c) => GROUP_OF[c] === g));

/** The capabilities in `next` that `previous` does not have: what an incremental consent has to ask for. */
export const addedCapabilities = (previous: readonly Capability[], next: readonly Capability[]): Capability[] => next.filter((c) => !previous.includes(c));

export const MAX_LABEL_LENGTH = 60;
/** At most this many accounts per owner (a bound, not a plan). */
export const MAX_CONNECTIONS_PER_USER = 25;
/** A Connect must finish within this long of its start. */
export const CONNECT_TTL_MS = 10 * 60_000;
/** The page the browser returns to when the flow names none. */
export const DEFAULT_RETURN_TO = '/settings/connections';
/** The access token is refreshed when it has less than this left. */
export const REFRESH_WITHIN_MS = 2 * 60_000;
