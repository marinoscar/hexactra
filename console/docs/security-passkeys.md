# Threat model: Hexactra passkeys (epic E47)

Hexactra can hold a passkey for a site and sign in with it in the browser it drives ([decision record](../../docs/decisions/passkey-provider.md)). This page lists what could go wrong, what stops it, and what remains. It extends the secrets threat model ([security-secrets.md](security-secrets.md)): a passkey's private key is **Secret Material**, handled like a saved password.

## What is protected, and the rule that protects it

- **The private key.** It is made in the fabric, stored only as ciphertext in the owner's secrets provider (the built-in store's `passkey_credentials` table today), fetched by the fabric for one signature and wiped. It is never in the model's context, a step, a log, a span, an event, a screenshot, an operation result, an export or an MCP result. The console's list and remove routes never return it.
- **What a signature is good for.** One assertion, for one challenge the site issued, bound to the origin Chrome reported for the frame. The model chooses only which button to press.
- **Who decides.** Only the owner, signed in, creates a Hexactra passkey (a server-created high-risk confirmation per site). Only a run with saved sign-ins allowed may use one. Removing it in the console stops its use at once.

## Threats

| Threat | What stops it | What remains |
|---|---|---|
| **A hostile page asks for a signature for another site** (an RP ID it does not own) | WebAuthn's rule, applied by the fabric: the RP ID must equal the frame origin's host or be a registrable suffix of it, on `https` (or `http://localhost`); the origin is Chrome's, read by the extension from the frame, never from the page's message or the model. The provider matches the RP ID exactly and checks the origin against it again. | A page on a subdomain may ask for the parent domain's RP ID (`a.example.com` for `example.com`), as WebAuthn allows. A site that hosts untrusted subdomains under its RP ID exposes its own users to this with any authenticator. |
| **Phishing: a look-alike site** | The signature is over `clientDataJSON` holding the real origin, and the RP ID hash is of the real RP ID: a look-alike origin gets no matching passkey (lookup is by exact RP ID), and a relayed assertion fails the real site's origin check. | None beyond the above: this is why passkeys resist phishing. |
| **A page that makes the agent enrol a passkey for the attacker's site** | Enrolment asks the owner first, naming the site the browser reports; a passkey for an unknown site is visible on the owner's card and in the passkey list. | An owner who approves without reading. The card says the site in its first words. |
| **The page calls `navigator.credentials` on its own, or after the agent clicked** | The hook holds a request only on a tab the fabric armed in the last 15 seconds, for the kind it armed (`get` or `create`), once. Any other request runs the browser's own code. | A page could make its own request in the armed window after the agent's click; it is still the same tab and origin, and gets at most what the right site would. |
| **The hook is bypassed or replaced by the page** (a page script runs before ours, or keeps a reference to the original) | The MAIN-world script is registered at `document_start` in every frame; a page that bypasses it reaches Chrome's own WebAuthn, which never sees Hexactra's keys. Bypassing the hook gains nothing. | Nothing for the key. A page can make the agent's sign-in fail. |
| **The page forges a "pending request" message to the extension** | The extension takes the origin from the message's sender (`sender.origin`, the frame Chrome knows), not from the payload; the RP ID check runs against that origin. | A same-origin page script is that site; it can ask for its own site's signature, as above. |
| **Replay of an assertion** | Each assertion signs the site's fresh challenge; the counter increases on every use and is stored. | Sites that ignore the counter and the challenge are broken for every authenticator. |
| **A payment approved with a passkey** (Secure Payment Confirmation, a bank's step-up) | Never answered: a request carrying the `payment` extension passes to Chrome, armed or not, and the control plane refuses to sign one (E47.6). | The owner confirms the payment themselves (a scan, a takeover or their banking app). |
| **A compromised node** | The node never holds the key at rest; it sees only the finished assertion. | The node reports the frame's origin. A node that lies gets an assertion for a site of its choosing where the owner has a Hexactra passkey, as it gets a typed password today. This is why the node is the owner's own machine. |
| **A compromised console** | The console holds ciphertext; the data keys are the built-in store's, as for passwords. | With the store's keys (a deployment compromise) every passkey is readable, as every saved password is. |
| **A stolen or leaked key** | The owner removes it in the console and on the site; the site then refuses it. | Until removed on the site, the key signs in. The console's remove step says to remove it on the site. |
| **The model is told to sign in somewhere else** (prompt injection) | The model only names a button; the site is the one on screen; the passkey is chosen by RP ID; allowed sites (per task) still bound navigation. | Saved sign-ins plus a schedule can sign in with nobody watching, as with saved passwords ([VISION §27](../../VISION.MD#27-human-emulator-full-powers-epic-366)). |
| **The owner's own browsing is changed** | The hook is installed only while a remote session runs, and acts only on an armed tab. | None found. |

## What has not been proven

- Real sites: the acceptance run on a passkey-only site is the owner's (E47.7, #945).
- Vault custody (E47.3, #941) is blocked on Vault.
