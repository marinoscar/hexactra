// Whether an address is reachable from the internet as a hosted AI client
// needs it (#465): https, and a host name that is not loopback, a private or
// link-local address, or a name reserved for local networks.
import { isIP } from 'node:net';

const LOCAL_SUFFIXES = ['.local', '.localhost', '.internal', '.lan', '.home.arpa', '.intranet', '.corp'];

/** Whether `host` (a name or an IP literal) is private: loopback, RFC 1918, link-local, CGNAT (Tailscale), ULA, or a local name. */
export function isPrivateHost(rawHost: string): boolean {
  const host = rawHost.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (!host || host === 'localhost' || (!host.includes('.') && isIP(host) === 0)) return true;
  if (LOCAL_SUFFIXES.some((s) => host.endsWith(s))) return true;
  if (host.endsWith('.ts.net')) return true; // a tailnet name: reachable only inside the tailnet
  const v = isIP(host);
  if (v === 4) {
    const [a, b] = host.split('.').map(Number) as [number, number];
    return a === 10 || a === 127 || a === 0 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127);
  }
  if (v === 6) return host === '::1' || host === '::' || host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe80');
  return false;
}

/** Whether `url` is an https:// address on a public host. */
export function isPublicHttpsUrl(url: string | undefined | null): boolean {
  if (!url) return false;
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && !isPrivateHost(u.hostname);
  } catch {
    return false;
  }
}
