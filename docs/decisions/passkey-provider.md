# Decision record: Hexactra is a passkey provider for its own browser

Issue #939 (epic E47, #925). Decided 2026-11-25.

## Context

More sites sign in with **passkeys only**. A passkey is a key pair on a device; the site sends a challenge and the device signs it after a user-presence check. A password can be typed; a passkey cannot. Before E47 the agent had two ways through a passkey prompt:

- a **takeover**: the owner opens the node's desktop and touches their own authenticator there;
- a **scan** (#924): the owner scans Chrome's "use a phone or tablet" QR code with their phone, which works only when the phone is within Bluetooth range of the node.

An unattended scheduled run that meets a passkey therefore waits for a person, often one who is not at home. Password managers solve this by acting as a **passkey provider**: their extension answers the site's WebAuthn request with a key from their vault. Hexactra already has an extension in the browser, a fabric that types secrets the model never sees, and a secrets provider contract (E37). E47 makes Hexactra a passkey provider for the browser it drives, and only for that browser.

## Decisions

1. **The owner adds Hexactra as one more passkey, per site.** Sites allow several passkeys per account. The owner keeps their own (phone, laptop, security key); Hexactra's is an extra one, made in the node's browser with the owner's approval, and removable from the console and from the site.
2. **The extension answers WebAuthn only when the fabric arms the tab.** A MAIN-world script wraps `navigator.credentials.get` and `create`. For each call it asks the extension; the extension holds the call only if the control plane **armed that tab for that kind of request** within the last 15 seconds (`webauthn_arm`), and only for a `publicKey` request without the `payment` extension. Every other call runs the browser's own code unchanged: the owner's browsing, a conditional (autofill) request, a request on a tab nobody armed. A held call not resolved within 15 seconds is passed to the browser. **Rejected:** Chrome's DevTools virtual authenticator (it needs the debugging port, which clients never reach and which would answer every request of every page); a native platform authenticator on the node (OS-specific, needs a PIN or biometrics the node cannot give).
3. **The fabric makes and uses the key.** The control plane (Rust) reads the held request from the extension (`webauthn_pending`): the **origin Chrome reports for the frame**, the RP ID, the challenge, the allowed credential ids, the user. It checks the RP ID against the origin with WebAuthn's rule (the RP ID equals the origin's host or is a registrable suffix of it, and the scheme is `https`, or `http://localhost`). It builds `clientDataJSON` itself from the browser's origin and the challenge, builds `authenticatorData` (the RP ID's SHA-256, flags user-present and user-verified, a signature counter), signs with **ES256 (P-256)**, wipes the key and sends the credential back (`webauthn_resolve`). The model names only the button to press: never an origin, an RP ID, a credential or a key.
4. **Attestation `none`, AAGUID zero.** Hexactra makes no claim about the authenticator's make; a site that demands an attested authenticator refuses Hexactra's passkey, and the owner keeps theirs.
5. **User verification.** The fabric reports `uv` as set: the owner verified the person ahead of time by enrolling the passkey and allowing saved sign-ins for the task. The docs say that the site will treat Hexactra as a verified device, and that removing the passkey ends that.
6. **Key custody follows the owner's secrets provider.**
   - **Built-in store:** the private key (PKCS#8) is kept as ciphertext in a console table, `passkey_credentials`, under the built-in store's cipher (the same data keys as its logins). The fabric fetches it on the store's internal route with the owner-bound `sct_` credential, for one signature, exactly as it fetches a password for one typing action. The public key, credential id, user handle and account name are kept beside it in plain text: they are not secret, and the list page needs them.
   - **Vault:** blocked on `marinoscar/vault` (E47.3, #941). The preferred design there is that Vault signs and the key never leaves it. Until then a Vault owner is told that passkeys need the built-in store.
   - The key never enters the console's Node process except as ciphertext and on the store's release and save routes (the same residual as a password with the built-in store).
7. **Enrolment needs the owner's approval, every time.** `add_passkey` first asks the owner a high-risk confirmation, created by the server, naming the site the browser is on; only that answer, given signed in, lets the fabric create the key. No saved approval, task setting, memory, Knowledge Graph procedure or MCP call can create one.
8. **Sign-in uses the saved sign-ins switch.** A run may sign in with a Hexactra passkey only where it may use saved logins (`savedLogins`, E37.3). Off by default; a run with it off is byte-identical.
9. **A payment assertion is never made** (E47.6, #944). A request with the `payment` extension (Secure Payment Confirmation) or a `PaymentRequest` for `secure-payment-confirmation` passes to the browser untouched, armed or not, and the control plane refuses to sign one. The owner confirms a payment themselves. This is stricter than the card rule of E37.7: no saved approval covers it.
10. **Removal.** The console lists the owner's Hexactra passkeys (site, account, created, last used) and removes one: the ciphertext is deleted, and the owner is told to remove it on the site too, because the site still lists the public key.

## How this answers the epic's open questions

| Question (#925) | Answer |
|---|---|
| Where is the key generated and where does signing happen? | In the fabric for the built-in store; in Vault for Vault when it can (E47.3). |
| How does the extension answer WebAuthn? | A MAIN-world wrapper of `navigator.credentials`, active only on an armed tab, holding one request for the fabric. |
| User verification | `uv` set, by the owner's enrolment and the task's saved sign-ins switch; documented. |
| Attestation | `none`. |
| Synced passkeys in the node's Google Password Manager | Out of scope: they need Chrome's own UI and a PIN; the owner can still use a takeover or a scan. |
| Discoverable credentials and the account picker | The fabric picks by RP ID and the allowed credential ids; several matching accounts make the tool refuse and the agent ask the owner which (a choice question), never pick one. |

## Consequences

- A compromised node can obtain a signature for any site its owner has a Hexactra passkey for, by lying about the origin (the same trust as typing a password: the node reports the tab's URL).
- A page on the right site sees a valid assertion, as it would from any authenticator; that is signing in.
- The owner's own passkeys are untouched; removing Hexactra's is the owner's single switch.
- Details and residual risks: [console/docs/security-passkeys.md](../../console/docs/security-passkeys.md).
