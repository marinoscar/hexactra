// A credential given in words (E46.39): "The password is hunter2-Secret-9931", "PIN: 4821", "use API key abc123", "the code is 551203". The
// value patterns (`defaultIsSensitive`, the console's sensitive-pattern table) catch shapes such as cards and tokens; this catches a credential
// word followed by a value. A plain mention without a value ("Sign-in asks for a one-time code", "the PIN pad is at the bottom") is a fact
// about the site and passes. Every pattern is bounded (no super-linear input). Pure: no I/O.

/** A credential word: password, passcode, passphrase, PIN, one-time code, OTP, verification code, security answer, API key, token, secret. */
const WORD =
  '(?:pass(?:word|wd|code|phrase)|pwd|pin(?:\\s+(?:code|number))?|one[\\s-]?time\\s+(?:pass)?(?:code|password)|otp(?:\\s+code)?|verification\\s+code|security\\s+(?:answer|code)|(?:2fa|mfa|totp|sms)\\s+code|api[\\s_-]?key|access\\s+(?:key|token)|private\\s+key|token|secret)';

/** A bare "code", unless it is a kind of code that is not a credential (a promo, postal or error code). */
const BARE_CODE = '(?<!(?:promo|promotion|discount|coupon|voucher|gift|zip|postal|post|area|country|error|status|sort|bank|swift|product|source|qr|bar)[\\s-])code';

/** The separators between a word and its value: "is", "was", ":", "=", or plain space. */
const PHRASE = new RegExp(`\\b(?:(${WORD})|(${BARE_CODE}))\\b(\\s*[:=]|\\s+(?:is|was|reads)\\b)?\\s*(["'“”‘’\`]?)([^\\s"'“”‘’\`,;]{1,200})`, 'gi');

/** Words that follow "the password is" without being a value. */
const NOT_A_VALUE = new Set(
  (
    'a an the at in on under below above by from for to of with via then and or only not never always also still now required needed optional sent ' +
    'shown hidden masked asked requested entered typed reset changed expired case case-sensitive valid invalid field box pad page screen prompt step form input entry manager rules policy length digits characters letters texted emailed'
  ).split(' '),
);

/** Whether a token is a value: it has a digit (four characters or more, three after "is", ":" or "="), or is quoted, or mixes letters with symbols, or is not an ordinary word after an explicit separator. */
function isValue(token: string, explicit: boolean, quoted: boolean, strong: boolean): boolean {
  const t = token.replace(/[.!?)…]+$/u, '');
  if (t.length === 0) return false;
  if (NOT_A_VALUE.has(t.toLowerCase())) return false;
  if (/\d/.test(t)) return t.length >= (explicit ? 3 : 4);
  if (quoted) return t.length >= 3;
  if (/[A-Za-z]/.test(t) && /[^A-Za-z'-]/.test(t)) return true;
  // A plain word: a value only after "is"/":"/"=" and only for a word whose value is itself the secret (a password, an answer, a key).
  return explicit && strong && t.length >= 3;
}

/** Words whose value, even an ordinary word, is the secret (a password or a security answer can be a dictionary word). */
const STRONG = /^(?:pass(?:word|wd|phrase)|pwd|security\s+answer|secret|api[\s_-]?key|private\s+key)$/i;

/** Whether text names a credential and gives its value. Never throws. */
export function hasCredentialPhrase(text: string): boolean {
  if (typeof text !== 'string' || text.length === 0) return false;
  const s = text.length > 10_000 ? text.slice(0, 10_000) : text;
  for (const m of s.matchAll(PHRASE)) {
    const word = (m[1] ?? m[2] ?? '').replace(/\s+/g, ' ');
    const sep = (m[3] ?? '').trim();
    const explicit = sep.length > 0;
    const quoted = (m[4] ?? '').length > 0;
    // A bare "code" needs an explicit separator ("the code is 551203", "code: 551203"); "a code 2 minutes later" is not a value.
    if (m[2] && !explicit && !quoted) continue;
    if (isValue(m[5] ?? '', explicit, quoted, STRONG.test(word))) return true;
  }
  return false;
}
