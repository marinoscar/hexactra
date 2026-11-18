// Which proxies the API trusts for the caller's address (#530). The API always
// sits behind the stack's own nginx, so without this Fastify's `request.ip` is
// nginx's container address and every per-address limit (the unauthenticated
// MCP limit, the platform OAuth server's authorize and register limits, the
// link-share miss throttle) counts every caller in one bucket.
//
// `TRUST_PROXY` (infra/compose/app.env.example), read once at boot by createApp:
//   unset or empty   trust loopback, link-local and private ranges (the stack's
//                    nginx, a tunnel or proxy on the same private network)
//   false            trust no proxy: request.ip is the TCP peer
//   a list           comma-separated IPs or CIDRs (and the named ranges
//                    loopback, linklocal, uniquelocal), passed to Fastify
// Anything else (`true`, a hop count, a malformed address) stops the boot:
// `true` would let any caller choose its bucket with X-Forwarded-For, and
// Fastify 5 ignores a hop count (it cannot validate the immediate peer).
import { isIP } from 'node:net';

/** The ranges trusted by default: proxy-addr's named ranges, which Fastify expands. */
export const DEFAULT_TRUST_PROXY = 'loopback,linklocal,uniquelocal';

/** The named ranges proxy-addr understands. */
const NAMED_RANGES = new Set(['loopback', 'linklocal', 'uniquelocal']);

/** What Fastify's `trustProxy` receives: `false` (off) or a comma-separated list. */
export type TrustProxySetting = false | string;

function validEntry(entry: string): boolean {
  if (NAMED_RANGES.has(entry)) return true;
  const slash = entry.indexOf('/');
  const address = slash === -1 ? entry : entry.slice(0, slash);
  const family = isIP(address);
  if (family === 0) return false;
  if (slash === -1) return true;
  const prefix = entry.slice(slash + 1);
  if (!/^\d{1,3}$/.test(prefix)) return false;
  return Number(prefix) <= (family === 4 ? 32 : 128);
}

/**
 * Parses `TRUST_PROXY` into Fastify's `trustProxy` option. Throws an `Error`
 * naming the variable and the bad value, so a typo stops the API at boot
 * instead of silently trusting the wrong peers.
 */
export function parseTrustProxy(raw: string | undefined): TrustProxySetting {
  const value = (raw ?? '').trim();
  if (value === '') return DEFAULT_TRUST_PROXY;
  if (value.toLowerCase() === 'false') return false;
  const help = 'use empty (trust loopback and private ranges), false, or a comma-separated list of IP addresses or CIDRs';
  if (value.toLowerCase() === 'true') {
    throw new Error(`TRUST_PROXY=true is not allowed: it would let any caller choose its address with X-Forwarded-For; ${help}`);
  }
  if (/^\d+$/.test(value)) {
    throw new Error(`TRUST_PROXY=${value}: a hop count is not supported (Fastify 5 cannot validate the immediate peer with one); ${help}`);
  }
  const entries = value.split(',').map((e) => e.trim());
  const bad = entries.filter((e) => !validEntry(e));
  if (bad.length > 0) {
    throw new Error(`TRUST_PROXY has invalid entr${bad.length === 1 ? 'y' : 'ies'} ${bad.map((b) => `"${b}"`).join(', ')}; ${help}`);
  }
  return entries.join(',');
}

/** A one-line description of the effective setting (the boot log and the Doctor). */
export function describeTrustProxy(setting: TrustProxySetting): string {
  if (setting === false) return 'off: the caller address is the TCP peer (the stack\'s nginx)';
  if (setting === DEFAULT_TRUST_PROXY) return 'loopback, link-local and private ranges (the default)';
  return setting;
}
