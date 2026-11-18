// TRUST_PROXY (#530): which proxies the API trusts for the caller's address.
// The parser feeds Fastify's `trustProxy` in createApp; an invalid value stops the boot.
import { DEFAULT_TRUST_PROXY, describeTrustProxy, parseTrustProxy } from '../src/config/trust-proxy';

describe('parseTrustProxy (#530)', () => {
  it('unset or empty: trust loopback, link-local and private ranges', () => {
    expect(DEFAULT_TRUST_PROXY).toBe('loopback,linklocal,uniquelocal');
    expect(parseTrustProxy(undefined)).toBe(DEFAULT_TRUST_PROXY);
    expect(parseTrustProxy('')).toBe(DEFAULT_TRUST_PROXY);
    expect(parseTrustProxy('   ')).toBe(DEFAULT_TRUST_PROXY);
    expect(describeTrustProxy(DEFAULT_TRUST_PROXY)).toMatch(/default/);
  });

  it('false (any case): off', () => {
    expect(parseTrustProxy('false')).toBe(false);
    expect(parseTrustProxy(' FALSE ')).toBe(false);
    expect(describeTrustProxy(false)).toMatch(/^off/);
  });

  it('a comma-separated list of IPs and CIDRs (and the named ranges) is passed through, trimmed', () => {
    expect(parseTrustProxy('172.18.0.0/16')).toBe('172.18.0.0/16');
    expect(parseTrustProxy('10.0.0.5, 172.18.0.0/16 ,fd00::/8,::1,loopback')).toBe('10.0.0.5,172.18.0.0/16,fd00::/8,::1,loopback');
    expect(parseTrustProxy('0.0.0.0/0')).toBe('0.0.0.0/0');
  });

  it('a hop count is refused: Fastify 5 ignores one (it cannot validate the immediate peer)', () => {
    expect(() => parseTrustProxy('1')).toThrow(/TRUST_PROXY=1: a hop count is not supported/);
    expect(() => parseTrustProxy('2')).toThrow(/hop count/);
  });

  it('invalid values stop the boot with a message naming the variable and the bad entry', () => {
    expect(() => parseTrustProxy('true')).toThrow(/TRUST_PROXY=true is not allowed/);
    expect(() => parseTrustProxy('nginx')).toThrow(/TRUST_PROXY has invalid entry "nginx"/);
    expect(() => parseTrustProxy('10.0.0.0/33')).toThrow(/"10\.0\.0\.0\/33"/);
    expect(() => parseTrustProxy('fd00::/129')).toThrow(/invalid entry/);
    expect(() => parseTrustProxy('10.0.0.1,,10.0.0.2')).toThrow(/invalid entry ""/);
    expect(() => parseTrustProxy('300.1.1.1, bogus')).toThrow(/invalid entries "300\.1\.1\.1", "bogus"/);
    expect(() => parseTrustProxy('10.0.0.0/abc')).toThrow(/invalid entry/);
  });
});
