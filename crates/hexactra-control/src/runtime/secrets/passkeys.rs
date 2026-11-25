//! Hexactra passkeys (epic E47, #942): the control plane answers a page's
//! WebAuthn request with a passkey from the owner's secrets provider.
//!
//! `passkey_sign_in` and `passkey_create` are provider actions: the control
//! plane runs them itself. It arms the tab (`webauthn_arm`: the extension
//! holds that tab's next `get` or `create` for 15 s), presses the button the
//! model named, reads the held request (`webauthn_pending`, with the origin
//! **Chrome** reports for the tab), and checks the RP ID against that origin
//! with WebAuthn's rule. Then:
//!
//! * sign-in: the provider's passkeys for the RP ID (filtered by the page's
//!   allowed credential ids); exactly one is used. Its private key is released
//!   for this one signature, the counter goes up, `clientDataJSON` is built
//!   here from the browser's origin and the page's challenge, and the ES256
//!   signature over `authenticatorData || SHA-256(clientDataJSON)` answers the
//!   page (`webauthn_resolve`). The key is wiped when the call ends.
//! * create: a P-256 key pair is made here, kept by the provider (the private
//!   key as PKCS#8, never anywhere else), and a `none` attestation answers the
//!   page.
//!
//! A request carrying the `payment` extension (Secure Payment Confirmation)
//! is never answered (E47.6): it goes to the browser untouched. So does every
//! request the control plane refuses. Results carry no key, signature or
//! challenge.

use base64::engine::general_purpose::URL_SAFE_NO_PAD as B64;
use base64::Engine as _;
use hexactra_core::remote::{provider_error_codes as code, RemoteAction, WebauthnKind};
use hexactra_credential_resolver::{
    rp_id_allowed, NewPasskey, Origin, OwnerId, PasskeyRelease, PasskeySummary, ProviderError,
    SecretValue,
};
use p256::ecdsa::signature::Signer;
use p256::ecdsa::{Signature, SigningKey};
use p256::pkcs8::{DecodePrivateKey, EncodePrivateKey, EncodePublicKey};
use rand::RngCore;
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use super::{provider_fail, Fail, Run};

/// How long the control plane waits for the page's WebAuthn call after the click.
const PENDING_WAIT_MS: u64 = 8_000;
/// COSE algorithm ES256.
const ES256: i64 = -7;
/// Flags: user present (UP) and user verified (UV).
const FLAGS_UP_UV: u8 = 0x05;
/// Flags: UP, UV and attested credential data (AT).
const FLAGS_UP_UV_AT: u8 = 0x45;

/// Failure codes of the passkey actions (besides the provider's).
pub mod codes {
    /// The button did not lead to a WebAuthn request on this tab.
    pub const NO_REQUEST: &str = "no_request";
    /// The owner has no Hexactra passkey this page may use.
    pub const NO_PASSKEY: &str = "no_passkey";
    /// Several of the owner's passkeys fit: the owner chooses, not the fabric.
    pub const SEVERAL_PASSKEYS: &str = "several_passkeys";
    /// A payment approval (Secure Payment Confirmation): never made by Hexactra.
    pub const PAYMENT_REFUSED: &str = "payment_refused";
    /// The page asks for a key type Hexactra does not make (only ES256).
    pub const UNSUPPORTED_ALGORITHM: &str = "unsupported_algorithm";
    /// The site already has this owner's Hexactra passkey.
    pub const ALREADY_REGISTERED: &str = "already_registered";
    /// The request the page made is not usable (bad challenge, missing user).
    pub const INVALID_REQUEST: &str = "invalid_request";
}

/// A WebAuthn request the extension holds, as it reports it.
#[derive(Debug, Deserialize)]
struct Held {
    id: String,
    kind: WebauthnKind,
    /// The tab's origin, as Chrome reports it (the extension reads it from the
    /// tab, never from the page's message).
    origin: String,
    rp_id: String,
    /// base64url
    challenge: String,
    #[serde(default)]
    allow_credentials: Vec<String>,
    #[serde(default)]
    exclude_credentials: Vec<String>,
    #[serde(default)]
    user: Option<HeldUser>,
    #[serde(default)]
    algorithms: Vec<i64>,
    #[serde(default)]
    payment: bool,
}

#[derive(Debug, Deserialize)]
struct HeldUser {
    /// base64url
    id: String,
    #[serde(default)]
    name: String,
}

// ------------------------------------------------------------- byte formats

/// `clientDataJSON` (WebAuthn §5.8.1), built here from the browser's origin.
fn client_data_json(kind: WebauthnKind, challenge_b64: &str, origin: &Origin) -> Vec<u8> {
    let ty = match kind {
        WebauthnKind::Get => "webauthn.get",
        WebauthnKind::Create => "webauthn.create",
    };
    // Field order as browsers write it; `crossOrigin` false: the request is the top frame's.
    format!(
        "{{\"type\":\"{ty}\",\"challenge\":\"{challenge_b64}\",\"origin\":{},\"crossOrigin\":false}}",
        serde_json::to_string(&origin.to_string()).unwrap_or_default()
    )
    .into_bytes()
}

/// `authenticatorData` for an assertion: RP ID hash, flags, counter.
fn assertion_auth_data(rp_id: &str, sign_count: u32) -> Vec<u8> {
    let mut out = Vec::with_capacity(37);
    out.extend_from_slice(&Sha256::digest(rp_id.as_bytes()));
    out.push(FLAGS_UP_UV);
    out.extend_from_slice(&sign_count.to_be_bytes());
    out
}

/// A minimal CBOR writer: what an attestation object and a COSE key need.
struct Cbor(Vec<u8>);

impl Cbor {
    fn head(&mut self, major: u8, n: u64) {
        let m = major << 5;
        if n < 24 {
            self.0.push(m | n as u8);
        } else if n < 0x100 {
            self.0.extend_from_slice(&[m | 24, n as u8]);
        } else if n < 0x1_0000 {
            self.0.push(m | 25);
            self.0.extend_from_slice(&(n as u16).to_be_bytes());
        } else {
            self.0.push(m | 26);
            self.0.extend_from_slice(&(n as u32).to_be_bytes());
        }
    }
    fn int(&mut self, v: i64) {
        if v >= 0 {
            self.head(0, v as u64);
        } else {
            self.head(1, (-1 - v) as u64);
        }
    }
    fn bytes(&mut self, b: &[u8]) {
        self.head(2, b.len() as u64);
        self.0.extend_from_slice(b);
    }
    fn text(&mut self, t: &str) {
        self.head(3, t.len() as u64);
        self.0.extend_from_slice(t.as_bytes());
    }
    fn map(&mut self, len: u64) {
        self.head(5, len);
    }
}

/// The COSE_Key of a P-256 public key (RFC 9053), keys in CTAP2 canonical order.
fn cose_key(key: &SigningKey) -> Vec<u8> {
    let point = key.verifying_key().to_encoded_point(false);
    let mut c = Cbor(Vec::with_capacity(77));
    c.map(5);
    c.int(1); // kty
    c.int(2); // EC2
    c.int(3); // alg
    c.int(ES256);
    c.int(-1); // crv
    c.int(1); // P-256
    c.int(-2); // x
    c.bytes(point.x().map(|x| x.as_slice()).unwrap_or_default());
    c.int(-3); // y
    c.bytes(point.y().map(|y| y.as_slice()).unwrap_or_default());
    c.0
}

/// `authenticatorData` for a new credential: flags UP|UV|AT, counter 0, AAGUID
/// zero (attestation `none`), the credential id and its COSE key.
fn creation_auth_data(rp_id: &str, credential_id: &[u8], cose: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(37 + 18 + credential_id.len() + cose.len());
    out.extend_from_slice(&Sha256::digest(rp_id.as_bytes()));
    out.push(FLAGS_UP_UV_AT);
    out.extend_from_slice(&0u32.to_be_bytes());
    out.extend_from_slice(&[0u8; 16]);
    out.extend_from_slice(&(credential_id.len() as u16).to_be_bytes());
    out.extend_from_slice(credential_id);
    out.extend_from_slice(cose);
    out
}

/// The attestation object of a `none` attestation (keys in canonical order).
fn attestation_object(auth_data: &[u8]) -> Vec<u8> {
    let mut c = Cbor(Vec::with_capacity(auth_data.len() + 32));
    c.map(3);
    c.text("fmt");
    c.text("none");
    c.text("attStmt");
    c.map(0);
    c.text("authData");
    c.bytes(auth_data);
    c.0
}

/// ES256 over `authenticatorData || SHA-256(clientDataJSON)`, DER-encoded.
fn sign(key: &SigningKey, auth_data: &[u8], client_data: &[u8]) -> Vec<u8> {
    let mut msg = Vec::with_capacity(auth_data.len() + 32);
    msg.extend_from_slice(auth_data);
    msg.extend_from_slice(&Sha256::digest(client_data));
    let sig: Signature = key.sign(&msg);
    sig.to_der().as_bytes().to_vec()
}

/// The signing key in a released PKCS#8 value; the copy p256 makes is its own
/// zeroizing scalar.
fn key_from(value: &SecretValue) -> Result<SigningKey, Fail> {
    value
        .expose(SigningKey::from_pkcs8_der)
        .map_err(|_| Fail::new(code::UNAVAILABLE, "the provider gave an unusable passkey"))
}

fn b64(b: &[u8]) -> String {
    B64.encode(b)
}

fn valid_b64(s: &str, max: usize) -> bool {
    !s.is_empty() && s.len() <= max && B64.decode(s).is_ok()
}

// ------------------------------------------------------------------ actions

impl Run {
    /// Arm the tab, press the button, read the request the page made.
    async fn held_request(
        &mut self,
        kind: WebauthnKind,
        selector: String,
        tab_id: Option<i64>,
    ) -> Result<(Held, Origin, i64), Fail> {
        let (_, tab) = self.read_origin(tab_id).await?;
        self.op(
            RemoteAction::WebauthnArm {
                kind,
                tab_id: Some(tab),
            },
            code::UNAVAILABLE,
        )
        .await?;
        self.op(
            RemoteAction::Click {
                selector,
                tab_id: Some(tab),
            },
            code::TYPING_FAILED,
        )
        .await?;
        let done = self
            .op(
                RemoteAction::WebauthnPending {
                    tab_id: Some(tab),
                    wait_ms: PENDING_WAIT_MS,
                },
                code::UNAVAILABLE,
            )
            .await?;
        let req = done
            .result
            .as_ref()
            .and_then(|r| r.get("request"))
            .cloned()
            .unwrap_or(Value::Null);
        // The held request carries the page's challenge: it does not stay readable.
        self.store.discard_result(done.id);
        if req.is_null() {
            return Err(Fail::new(
                codes::NO_REQUEST,
                "the page did not ask for a passkey after the click",
            ));
        }
        let held: Held = serde_json::from_value(req).map_err(|_| {
            Fail::new(
                codes::INVALID_REQUEST,
                "the page's passkey request is not usable",
            )
        })?;
        let origin = match Origin::from_browser_url(&held.origin) {
            Ok(o) => o,
            Err(_) => {
                self.pass(&held, tab).await;
                return Err(Fail::new(
                    code::ORIGIN_UNAVAILABLE,
                    "the page's origin cannot be used",
                ));
            }
        };
        self.audit.origin = Some(origin.to_string());
        if held.kind != kind {
            self.pass(&held, tab).await;
            return Err(Fail::new(
                codes::INVALID_REQUEST,
                "the page made another kind of passkey request",
            ));
        }
        // E47.6: a payment approval is the owner's, never Hexactra's.
        if held.payment {
            self.pass(&held, tab).await;
            return Err(Fail::new(
                codes::PAYMENT_REFUSED,
                "this passkey request approves a payment: the owner must confirm it themselves",
            ));
        }
        if !rp_id_allowed(&held.rp_id, &origin) {
            self.pass(&held, tab).await;
            return Err(Fail::new(
                code::ORIGIN_MISMATCH,
                "the page asked for a passkey of another site",
            ));
        }
        if !valid_b64(&held.challenge, 1024) {
            self.pass(&held, tab).await;
            return Err(Fail::new(
                codes::INVALID_REQUEST,
                "the page's challenge is not usable",
            ));
        }
        Ok((held, origin, tab))
    }

    /// Give the held request to the browser untouched (best effort).
    async fn pass(&self, held: &Held, tab: i64) {
        if let Ok(done) = self
            .op(
                RemoteAction::WebauthnResolve {
                    request_id: held.id.clone(),
                    tab_id: Some(tab),
                    credential: None,
                    passthrough: true,
                },
                code::UNAVAILABLE,
            )
            .await
        {
            self.store.discard_result(done.id);
        }
    }

    async fn answer(&self, held: &Held, tab: i64, credential: Value) -> Result<(), Fail> {
        let done = self
            .op(
                RemoteAction::WebauthnResolve {
                    request_id: held.id.clone(),
                    tab_id: Some(tab),
                    credential: Some(credential),
                    passthrough: false,
                },
                code::UNAVAILABLE,
            )
            .await?;
        // The credential holds the signature: the operation does not keep it.
        self.store.discard_result(done.id);
        Ok(())
    }

    fn owner_id(&self) -> Result<OwnerId, Fail> {
        OwnerId::new(self.owner.clone().unwrap_or_default())
            .map_err(|m| Fail::new(code::NO_PROVIDER, m))
    }

    /// `passkey_sign_in`.
    pub(super) async fn passkey_sign_in(
        &mut self,
        selector: String,
        provider: Option<String>,
        tab_id: Option<i64>,
    ) -> Result<Value, Fail> {
        let (pid, prov) = self
            .providers
            .resolve(self.owner.as_deref(), provider.as_deref())?;
        self.audit.provider = Some(pid);
        self.audit.purpose = Some("passkey");
        let owner = self.owner_id()?;
        let (held, origin, tab) = self
            .held_request(WebauthnKind::Get, selector, tab_id)
            .await?;
        let left = self.remaining()?;
        let found =
            match tokio::time::timeout(left, prov.passkey_lookup(&owner, &held.rp_id, &origin))
                .await
            {
                Ok(Ok(v)) => v,
                other => {
                    self.pass(&held, tab).await;
                    return Err(match other {
                        Ok(Err(e)) => provider_fail(e),
                        _ => provider_fail(ProviderError::Unavailable),
                    });
                }
            };
        let usable: Vec<PasskeySummary> = found
            .into_iter()
            .filter(|p| p.rp_id == held.rp_id)
            .filter(|p| {
                held.allow_credentials.is_empty()
                    || held.allow_credentials.contains(&p.credential_id)
            })
            .collect();
        self.audit.count = Some(usable.len());
        let chosen = match usable.as_slice() {
            [one] => one.clone(),
            [] => {
                self.pass(&held, tab).await;
                return Err(Fail::new(
                    codes::NO_PASSKEY,
                    "the owner has no Hexactra passkey for this site: the browser shows its own passkey prompt",
                ));
            }
            _ => {
                self.pass(&held, tab).await;
                return Err(Fail::new(
                    codes::SEVERAL_PASSKEYS,
                    "the owner has several Hexactra passkeys for this site: ask the owner which account to use",
                ));
            }
        };
        self.audit.item_id = Some(chosen.id.clone());
        let release = PasskeyRelease {
            owner: owner.clone(),
            item_id: chosen.id.clone(),
            rp_id: held.rp_id.clone(),
            origin: origin.clone(),
            run_id: self.audit.run_id.clone(),
            client_label: self.audit.client_label.clone(),
        };
        let left = self.remaining()?;
        let value = match tokio::time::timeout(left, prov.passkey_release(release)).await {
            Ok(Ok(v)) => v,
            other => {
                self.pass(&held, tab).await;
                return Err(match other {
                    Ok(Err(e)) => provider_fail(e),
                    _ => provider_fail(ProviderError::Unavailable),
                });
            }
        };
        let counter = chosen.sign_count.saturating_add(1);
        let client_data = client_data_json(WebauthnKind::Get, &held.challenge, &origin);
        let auth_data = assertion_auth_data(&held.rp_id, counter);
        let signature = {
            let key = match key_from(&value) {
                Ok(k) => k,
                Err(f) => {
                    self.pass(&held, tab).await;
                    return Err(f);
                }
            };
            sign(&key, &auth_data, &client_data)
            // `key` and `value` are wiped here and at the end of the call.
        };
        drop(value);
        self.audit.released = true;
        let credential = json!({
            "id": chosen.credential_id,
            "type": "public-key",
            "authenticator_attachment": "platform",
            "response": {
                "client_data_json": b64(&client_data),
                "authenticator_data": b64(&auth_data),
                "signature": b64(&signature),
                "user_handle": chosen.user_handle,
            },
        });
        self.answer(&held, tab, credential).await?;
        // The counter is best effort: a missed update never undoes a sign-in.
        let _ = tokio::time::timeout(
            self.remaining().unwrap_or_default(),
            prov.passkey_used(&owner, &chosen.id, counter),
        )
        .await;
        Ok(json!({ "signed_in": true, "rp_id": held.rp_id }))
    }

    /// `passkey_create`.
    pub(super) async fn passkey_create(
        &mut self,
        selector: String,
        provider: Option<String>,
        tab_id: Option<i64>,
    ) -> Result<Value, Fail> {
        let (pid, prov) = self
            .providers
            .resolve(self.owner.as_deref(), provider.as_deref())?;
        self.audit.provider = Some(pid);
        self.audit.purpose = Some("passkey");
        let owner = self.owner_id()?;
        let (held, origin, tab) = self
            .held_request(WebauthnKind::Create, selector, tab_id)
            .await?;
        let user = match held.user.as_ref() {
            Some(u) if valid_b64(&u.id, 128) => u,
            _ => {
                self.pass(&held, tab).await;
                return Err(Fail::new(
                    codes::INVALID_REQUEST,
                    "the page's passkey request names no account",
                ));
            }
        };
        if !held.algorithms.is_empty() && !held.algorithms.contains(&ES256) {
            self.pass(&held, tab).await;
            return Err(Fail::new(
                codes::UNSUPPORTED_ALGORITHM,
                "the site does not accept the passkey type Hexactra makes (ES256)",
            ));
        }
        // A site that already has one of this owner's Hexactra passkeys lists it as excluded.
        if !held.exclude_credentials.is_empty() {
            let left = self.remaining()?;
            if let Ok(Ok(mine)) =
                tokio::time::timeout(left, prov.passkey_lookup(&owner, &held.rp_id, &origin)).await
            {
                if mine
                    .iter()
                    .any(|p| held.exclude_credentials.contains(&p.credential_id))
                {
                    self.pass(&held, tab).await;
                    return Err(Fail::new(
                        codes::ALREADY_REGISTERED,
                        "this account on the site already has a Hexactra passkey",
                    ));
                }
            }
        }
        let key = SigningKey::random(&mut rand::rngs::OsRng);
        let mut raw_id = [0u8; 16];
        rand::rngs::OsRng.fill_bytes(&mut raw_id);
        let credential_id = b64(&raw_id);
        let cose = cose_key(&key);
        let spki = key
            .verifying_key()
            .to_public_key_der()
            .map_err(|_| Fail::new("internal", "could not encode the public key"))?;
        let pkcs8 = key
            .to_pkcs8_der()
            .map_err(|_| Fail::new("internal", "could not encode the passkey"))?;
        let new = NewPasskey {
            owner: owner.clone(),
            rp_id: held.rp_id.clone(),
            origin: origin.clone(),
            credential_id: credential_id.clone(),
            user_handle: user.id.clone(),
            user_name: user.name.chars().take(200).collect(),
            public_key: b64(&cose),
            private_key: SecretValue::new(pkcs8.as_bytes().to_vec()),
            run_id: self.audit.run_id.clone(),
            client_label: self.audit.client_label.clone(),
        };
        drop(pkcs8);
        drop(key);
        let left = self.remaining()?;
        let saved = match tokio::time::timeout(left, prov.passkey_save(new)).await {
            Ok(Ok(id)) => id,
            other => {
                // Nothing kept: the site gets nothing either.
                self.pass(&held, tab).await;
                return Err(match other {
                    Ok(Err(e)) => provider_fail(e),
                    _ => provider_fail(ProviderError::Unavailable),
                });
            }
        };
        self.audit.item_id = Some(saved);
        self.audit.released = true;
        let client_data = client_data_json(WebauthnKind::Create, &held.challenge, &origin);
        let auth_data = creation_auth_data(&held.rp_id, &raw_id, &cose);
        let credential = json!({
            "id": credential_id,
            "type": "public-key",
            "authenticator_attachment": "platform",
            "response": {
                "client_data_json": b64(&client_data),
                "attestation_object": b64(&attestation_object(&auth_data)),
                "authenticator_data": b64(&auth_data),
                "public_key": b64(spki.as_bytes()),
                "public_key_algorithm": ES256,
                "transports": ["internal"],
            },
        });
        self.answer(&held, tab, credential).await?;
        Ok(
            json!({ "created": true, "rp_id": held.rp_id, "user_name": user.name.chars().take(200).collect::<String>() }),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use p256::ecdsa::signature::Verifier;
    use p256::ecdsa::VerifyingKey;

    fn origin(s: &str) -> Origin {
        Origin::from_browser_url(s).unwrap()
    }

    #[test]
    fn client_data_names_the_browser_origin_and_the_challenge() {
        let cd = client_data_json(
            WebauthnKind::Get,
            "Y2hhbGxlbmdl",
            &origin("https://login.example.com/path"),
        );
        let v: Value = serde_json::from_slice(&cd).unwrap();
        assert_eq!(v["type"], "webauthn.get");
        assert_eq!(v["challenge"], "Y2hhbGxlbmdl");
        assert_eq!(v["origin"], "https://login.example.com");
        assert_eq!(v["crossOrigin"], false);
        let cd = client_data_json(WebauthnKind::Create, "YQ", &origin("https://example.com"));
        assert_eq!(
            serde_json::from_slice::<Value>(&cd).unwrap()["type"],
            "webauthn.create"
        );
    }

    #[test]
    fn assertion_auth_data_is_the_rp_hash_flags_and_counter() {
        let a = assertion_auth_data("example.com", 7);
        assert_eq!(a.len(), 37);
        assert_eq!(&a[..32], Sha256::digest(b"example.com").as_slice());
        assert_eq!(a[32], 0x05);
        assert_eq!(&a[33..], &[0, 0, 0, 7]);
    }

    #[test]
    fn a_signature_verifies_with_the_public_key_and_survives_pkcs8() {
        let key = SigningKey::random(&mut rand::rngs::OsRng);
        let der = key.to_pkcs8_der().unwrap();
        let back = key_from(&SecretValue::new(der.as_bytes().to_vec())).unwrap();
        let auth = assertion_auth_data("example.com", 1);
        let cd = client_data_json(WebauthnKind::Get, "YQ", &origin("https://example.com"));
        let sig = sign(&back, &auth, &cd);
        let mut msg = auth.clone();
        msg.extend_from_slice(&Sha256::digest(&cd));
        let parsed = Signature::from_der(&sig).unwrap();
        VerifyingKey::from(&key).verify(&msg, &parsed).unwrap();
        // Another message does not verify.
        assert!(VerifyingKey::from(&key).verify(b"other", &parsed).is_err());
    }

    #[test]
    fn the_cose_key_and_attestation_object_have_the_ctap2_layout() {
        let key = SigningKey::random(&mut rand::rngs::OsRng);
        let cose = cose_key(&key);
        // map(5) {1: 2, 3: -7, -1: 1, -2: bstr(32), -3: bstr(32)}
        assert_eq!(&cose[..7], &[0xa5, 0x01, 0x02, 0x03, 0x26, 0x20, 0x01]);
        assert_eq!(&cose[7..9], &[0x21, 0x58]);
        assert_eq!(cose[9], 32);
        assert_eq!(cose[42], 0x22);
        assert_eq!(cose.len(), 77);
        let auth = creation_auth_data("example.com", &[9u8; 16], &cose);
        assert_eq!(auth[32], 0x45);
        assert_eq!(&auth[33..37], &[0, 0, 0, 0]);
        assert_eq!(&auth[37..53], &[0u8; 16]);
        assert_eq!(&auth[53..55], &[0, 16]);
        assert_eq!(&auth[55..71], &[9u8; 16]);
        assert_eq!(&auth[71..], cose.as_slice());
        let att = attestation_object(&auth);
        // {"fmt": "none", "attStmt": {}, "authData": bstr}
        assert_eq!(att[0], 0xa3);
        assert_eq!(&att[1..5], b"\x63fmt");
        assert_eq!(&att[5..10], b"\x64none");
        assert_eq!(&att[10..18], b"\x67attStmt");
        assert_eq!(att[18], 0xa0);
        assert_eq!(&att[19..28], b"\x68authData");
        assert_eq!(&att[28..30], &[0x58, auth.len() as u8]);
        assert_eq!(&att[30..], auth.as_slice());
    }

    #[test]
    fn cbor_heads_cover_every_length_class() {
        let mut c = Cbor(Vec::new());
        c.int(23);
        c.int(24);
        c.int(300);
        c.int(70_000);
        c.int(-7);
        c.int(-25);
        assert_eq!(
            c.0,
            vec![0x17, 0x18, 24, 0x19, 0x01, 0x2c, 0x1a, 0x00, 0x01, 0x11, 0x70, 0x26, 0x38, 24]
        );
    }
}
