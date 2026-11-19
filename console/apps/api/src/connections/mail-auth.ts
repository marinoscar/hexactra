// Reading the receiving server's sender-authentication result out of an `Authentication-Results` header (RFC 8601), for the mail
// trigger (E39.8, #605). An adapter calls `senderAuthFrom` with the header value(s) of a message and the address of its `From`,
// and puts the answer in `MailMessage.senderAuth`; the trigger refuses a `fail`.
//
// What counts, and its limits (docs/connections.md, "Start a task from an email"):
//   * `pass`    DMARC passed, or DKIM passed for a domain aligned with the From domain, or SPF passed for a domain aligned with it.
//               "Aligned" is relaxed: the same domain, or one a subdomain of the other. It means the From domain's own
//               infrastructure sent or signed the message; it does not mean the person is who they say they are.
//   * `fail`    DMARC failed, or nothing passed aligned and a DKIM or SPF result failed (or softfailed).
//   * `unknown` no header, no usable result, or nothing aligned and nothing failed. A message whose domain publishes no policy lands
//               here, as does a provider that does not expose the header at all.
// Only the topmost header counts when several are given: the receiving server prepends its own, so an earlier one is the sender's
// and can say anything. An adapter passes `trusted` to also require the header's `authserv-id` (the server's name) to be its own.
export type SenderAuth = 'pass' | 'fail' | 'unknown';

const domainOf = (address: string | null | undefined): string | null => {
  const at = (address ?? '').lastIndexOf('@');
  const d = at >= 0 ? (address ?? '').slice(at + 1).trim().toLowerCase().replace(/^<|>$/g, '') : '';
  return d || null;
};

/** The same domain, or one a subdomain of the other (relaxed alignment, as DMARC's default). */
export function aligned(a: string | null, b: string | null): boolean {
  if (!a || !b) return false;
  return a === b || a.endsWith(`.${b}`) || b.endsWith(`.${a}`);
}

interface MethodResult {
  method: string;
  result: string;
  props: Map<string, string>;
}

/** `dkim=pass header.d=example.test header.s=sel` and the like, from the part after the `authserv-id`. */
function parseResults(rest: string): MethodResult[] {
  const out: MethodResult[] = [];
  // Comments in parentheses can hold anything (including semicolons): drop them first.
  const clean = rest.replace(/\((?:[^()]|\([^()]*\))*\)/g, ' ');
  for (const part of clean.split(';')) {
    const m = /^\s*([a-z][a-z0-9-]*)\s*=\s*([a-z]+)\b(.*)$/is.exec(part);
    if (!m) continue;
    const props = new Map<string, string>();
    for (const p of m[3]!.matchAll(/([a-z][a-z0-9._-]*)\s*=\s*("[^"]*"|[^\s;]+)/gi)) props.set(p[1]!.toLowerCase(), p[2]!.replace(/^"|"$/g, '').trim());
    out.push({ method: m[1]!.toLowerCase(), result: m[2]!.toLowerCase(), props });
  }
  return out;
}

export interface SenderAuthOptions {
  /** Only a header whose `authserv-id` this accepts counts (the provider's own server). Default: any. */
  trusted?: (authservId: string) => boolean;
}

export function senderAuthFrom(header: string | readonly string[] | null | undefined, fromAddress: string | null | undefined, opts: SenderAuthOptions = {}): SenderAuth {
  const first = (Array.isArray(header) ? header[0] : header) as string | null | undefined;
  const fromDomain = domainOf(fromAddress);
  if (!first || typeof first !== 'string' || !fromDomain) return 'unknown';
  const semi = first.indexOf(';');
  const authservId = (semi < 0 ? first : first.slice(0, semi)).trim().split(/\s+/)[0]?.toLowerCase() ?? '';
  if (opts.trusted && !opts.trusted(authservId)) return 'unknown';
  const results = parseResults(semi < 0 ? '' : first.slice(semi + 1));
  if (results.length === 0) return 'unknown';

  const dmarc = results.find((r) => r.method === 'dmarc');
  if (dmarc?.result === 'pass') return 'pass';
  if (dmarc?.result === 'fail') return 'fail';

  let passed = false;
  let failed = false;
  for (const r of results) {
    if (r.method === 'dkim') {
      const d = (r.props.get('header.d') ?? domainOf(r.props.get('header.i')) ?? '').toLowerCase().replace(/^@/, '');
      if (r.result === 'pass' && aligned(d || null, fromDomain)) passed = true;
      else if (r.result === 'fail') failed = true;
    } else if (r.method === 'spf') {
      const d = domainOf(r.props.get('smtp.mailfrom')) ?? (r.props.get('smtp.helo') ?? '').toLowerCase();
      if (r.result === 'pass' && aligned(d || null, fromDomain)) passed = true;
      else if (r.result === 'fail' || r.result === 'softfail') failed = true;
    }
  }
  if (passed) return 'pass';
  return failed ? 'fail' : 'unknown';
}
