// Whether a value looks like secret material. The host passes its own predicate (the console binds its sensitive-pattern table); this default is
// a conservative fallback so a host that passes nothing still refuses the obvious cases. Every pattern is bounded (no super-linear input).

export type SensitivePredicate = (value: string) => boolean;

function luhn(digits: string): boolean {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let n = digits.charCodeAt(digits.length - 1 - i) - 48;
    if (i % 2 === 1) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
  }
  return sum % 10 === 0;
}

const CARD = /(?:\d[ -]?){12,18}\d/g;
const IBAN = /\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){2,7}(?: ?[A-Z0-9]{1,4})?\b/;
const TOKEN_PREFIX = /\b(?:pat_|oat_|ort_|oac_|nod_|hxs_|hxe_|hxh_|whsec_|sk-|sk_live_|sk_test_|ghp_|gho_|github_pat_|xox[abpr]-|AKIA|ASIA|AIza)[A-Za-z0-9_-]{8,200}/;
const JWT = /\beyJ[A-Za-z0-9_-]{8,2000}\.[A-Za-z0-9_-]{8,2000}\.[A-Za-z0-9_-]{8,2000}/;
const PEM = /-----BEGIN [A-Z ]{0,40}PRIVATE KEY-----/;
const SSN = /\b\d{3}-\d{2}-\d{4}\b/;
const LONG_SECRET = /\b[A-Za-z0-9+/_-]{40,500}={0,2}(?![A-Za-z0-9+/_=-])/;

/** The default predicate: card numbers (Luhn), IBANs, known token prefixes, JWTs, private keys, US SSNs and long opaque strings. */
export const defaultIsSensitive: SensitivePredicate = (value) => {
  if (typeof value !== 'string' || value.length === 0) return false;
  const text = value.length > 100_000 ? value.slice(0, 100_000) : value;
  for (const m of text.matchAll(CARD)) {
    const d = m[0].replace(/\D/g, '');
    if (d.length >= 13 && d.length <= 19 && luhn(d)) return true;
  }
  if (IBAN.test(text) || TOKEN_PREFIX.test(text) || JWT.test(text) || PEM.test(text) || SSN.test(text)) return true;
  const long = LONG_SECRET.exec(text);
  // A long run of letters and digits with both, not a plain word or a path: an opaque key.
  return long !== null && /\d/.test(long[0]) && /[A-Za-z]/.test(long[0]) && !/^[a-z]+$/i.test(long[0]);
};
