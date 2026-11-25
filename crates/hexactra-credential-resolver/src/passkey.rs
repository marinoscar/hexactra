//! Passkeys (epic E47, #940): what a provider stores for a Hexactra passkey,
//! and WebAuthn's rule for which origin may use which RP ID.
//!
//! A passkey is a P-256 key pair the fabric makes in the browser it drives.
//! The provider keeps the private key (PKCS#8 DER) and gives it to the fabric
//! for one signature, as it gives a password for one typing action: it is a
//! [`SecretValue`], wiped when dropped. Everything else here (the credential
//! id, the user handle, the account name, the public key) is not secret.

use std::fmt;

use crate::{Origin, OwnerId, SecretValue};

/// The longest RP ID accepted (a DNS name).
pub const MAX_RP_ID: usize = 253;

/// Whether `origin` may use a passkey of `rp_id` (WebAuthn §5.1.3 / §5.1.4.1:
/// the RP ID is the origin's host or a registrable suffix of it). The origin
/// must be `https`, or `http` on `localhost`; the RP ID may not be a public
/// suffix (`com`, `co.uk`) and never an IP literal unless it is the origin's
/// own host.
pub fn rp_id_allowed(rp_id: &str, origin: &Origin) -> bool {
    let rp = rp_id.trim().to_ascii_lowercase();
    if rp.is_empty() || rp.len() > MAX_RP_ID || rp != rp_id || rp.ends_with('.') {
        return false;
    }
    let host = origin.host();
    if origin.scheme() == "http" && host != "localhost" {
        return false;
    }
    if rp == host {
        return true;
    }
    // A parent domain: the host ends with ".<rp>", and <rp> is at least the
    // host's registrable domain (never a bare public suffix).
    let Some(registrable) = origin.registrable_domain() else {
        return false;
    };
    host.ends_with(&format!(".{rp}"))
        && (rp == registrable || rp.ends_with(&format!(".{registrable}")))
}

/// One passkey a provider holds for an owner, as a lookup returns it: never
/// the private key.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PasskeySummary {
    /// The provider's id for it.
    pub id: String,
    /// The WebAuthn credential id, base64url without padding.
    pub credential_id: String,
    /// The site's user handle, base64url without padding.
    pub user_handle: String,
    /// The account's name as the site gave it at enrolment (not secret).
    pub user_name: String,
    /// The RP ID it was made for.
    pub rp_id: String,
    /// The signature counter last used.
    pub sign_count: u32,
}

/// A passkey the fabric made, to be kept by the provider (E47.4). The private
/// key is a [`SecretValue`]: the caller wipes it after the call.
pub struct NewPasskey {
    pub owner: OwnerId,
    pub rp_id: String,
    /// The origin of the page it was made on, as the browser reported it.
    pub origin: Origin,
    pub credential_id: String,
    pub user_handle: String,
    pub user_name: String,
    /// The COSE public key, base64url without padding (not secret).
    pub public_key: String,
    /// PKCS#8 DER.
    pub private_key: SecretValue,
    pub run_id: Option<String>,
    pub client_label: Option<String>,
}

impl fmt::Debug for NewPasskey {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("NewPasskey")
            .field("owner", &self.owner)
            .field("rp_id", &self.rp_id)
            .field("origin", &self.origin.to_string())
            .field("credential_id", &self.credential_id)
            .field("private_key", &"[secret]")
            .finish_non_exhaustive()
    }
}

/// The private key of one passkey, for one signature, bound to the RP ID and
/// the page's origin.
#[derive(Debug, Clone)]
pub struct PasskeyRelease {
    pub owner: OwnerId,
    pub item_id: String,
    pub rp_id: String,
    /// The origin the browser reported for the page asking, read just now.
    pub origin: Origin,
    pub run_id: Option<String>,
    pub client_label: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn o(s: &str) -> Origin {
        Origin::from_browser_url(s).unwrap()
    }

    #[test]
    fn the_rp_id_is_the_host_or_a_registrable_parent() {
        assert!(rp_id_allowed(
            "login.example.com",
            &o("https://login.example.com/x")
        ));
        assert!(rp_id_allowed(
            "example.com",
            &o("https://login.example.com/x")
        ));
        assert!(rp_id_allowed(
            "example.co.uk",
            &o("https://a.b.example.co.uk/")
        ));
        // A public suffix, another site, a child of the host, a look-alike.
        assert!(!rp_id_allowed("com", &o("https://login.example.com/")));
        assert!(!rp_id_allowed("co.uk", &o("https://example.co.uk/")));
        assert!(!rp_id_allowed("evil.com", &o("https://login.example.com/")));
        assert!(!rp_id_allowed(
            "a.login.example.com",
            &o("https://login.example.com/")
        ));
        assert!(!rp_id_allowed(
            "ample.com",
            &o("https://login.example.com/")
        ));
        assert!(!rp_id_allowed(
            "example.com",
            &o("https://example.com.evil.com/")
        ));
        // Not normalised by us: the page must give it as WebAuthn requires.
        assert!(!rp_id_allowed("Example.com", &o("https://example.com/")));
        assert!(!rp_id_allowed("", &o("https://example.com/")));
    }

    #[test]
    fn http_only_on_localhost() {
        assert!(rp_id_allowed("localhost", &o("http://localhost:8080/")));
        assert!(!rp_id_allowed("127.0.0.1", &o("http://127.0.0.1:8080/")));
    }

    #[test]
    fn a_new_passkey_never_prints_its_key() {
        let n = NewPasskey {
            owner: OwnerId::new("00000000-0000-4000-8000-000000000001").unwrap(),
            rp_id: "example.com".into(),
            origin: o("https://example.com/"),
            credential_id: "Y3JlZA".into(),
            user_handle: "dXNlcg".into(),
            user_name: "person".into(),
            public_key: "cGs".into(),
            private_key: SecretValue::from_string("PRIVATE-KEY-MARKER".into()),
            run_id: None,
            client_label: None,
        };
        assert!(!format!("{n:?}").contains("PRIVATE-KEY-MARKER"));
    }
}
