//! The secrets provider contract (epic #579, issue #590).
//!
//! A stored secret gets from a provider (Vault, the built-in store) into a
//! page like this: the agent names **which** item and field ("the password of
//! this login"); the fabric asks the owner's [`SecretsProvider`] for the value
//! with the page's origin, types it with trusted input and wipes it. The model,
//! the console's database, logs, traces, screenshots and exports never hold it.
//!
//! This crate is the contract and nothing else: the trait, its request and
//! error types, [`Origin`], [`SecretValue`], a hardened [`http`] client builder
//! for provider implementations, and (behind the `test-provider` feature, and
//! in this crate's own tests) a fixed-fixture [`test_provider::TestProvider`].
//! The control plane (`hexactra-control`) holds the per-owner registry and
//! runs the actions.
//!
//! What this crate replaced: the earlier scaffolding (`CredentialScope`,
//! `SecretHandle`, `ScopedCredentialResolver`, `CredentialVault`, a mock
//! vault) modelled opaque one-time handles and a vault that returned whole JSON
//! credentials. Nothing used it, and "return the whole credential" is exactly
//! what this contract forbids, so it was removed rather than built beside.

pub mod http;
mod origin;
#[cfg(any(test, feature = "test-provider"))]
pub mod test_provider;
mod value;

use std::fmt;
use std::time::Duration;

use async_trait::async_trait;
use chrono::{DateTime, Utc};

pub use hexactra_core::remote::{ItemKind, ItemSummary, MatchKind, SecretField, SecretPurpose};
pub use origin::{Origin, OriginError};
pub use value::SecretValue;

/// Whose items a provider may touch: the console's user id of the session's
/// owner. Not secret.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct OwnerId(String);

impl OwnerId {
    /// 1-128 characters, no control characters.
    pub fn new(id: impl Into<String>) -> Result<Self, String> {
        let id = id.into();
        if id.trim().is_empty() || id.len() > 128 || id.chars().any(char::is_control) {
            return Err("owner id must be 1-128 characters without control characters".into());
        }
        Ok(Self(id))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for OwnerId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

/// One field of one item, for one purpose, bound to the page's origin.
#[derive(Debug, Clone)]
pub struct ReleaseRequest {
    pub owner: OwnerId,
    pub item_id: String,
    pub field: SecretField,
    /// The top-level origin the browser reported, read just now.
    pub origin: Origin,
    pub purpose: SecretPurpose,
    /// The run the call belongs to (audit).
    pub run_id: Option<String>,
    /// What the owner sees as the app (audit).
    pub client_label: Option<String>,
}

/// A one-time code for one item, bound to the page's origin.
#[derive(Debug, Clone)]
pub struct CodeRequest {
    pub owner: OwnerId,
    pub item_id: String,
    pub origin: Origin,
    pub purpose: SecretPurpose,
    pub run_id: Option<String>,
    pub client_label: Option<String>,
}

/// Why a provider did not answer.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum ProviderError {
    /// One variant for missing, not the owner's and not opened to the agent:
    /// a caller cannot tell which.
    #[error("no such item")]
    NotFound,
    /// The page's origin is not exactly one of the item's.
    #[error("the page's origin is not one of the item's")]
    OriginMismatch,
    /// The provider's kill switch is off.
    #[error("the provider is switched off")]
    Disabled,
    #[error("rate limited; retry in {} s", retry_after.as_secs())]
    RateLimited { retry_after: Duration },
    /// Could not be reached, timed out, or answered something unusable.
    #[error("the provider is unavailable")]
    Unavailable,
    /// The token was refused: the owner must connect the provider again.
    #[error("the provider refused the token; reconnect it")]
    Unauthorized,
    /// The provider refused for its own reason (a short machine code, never
    /// a message from the provider's body).
    #[error("the provider refused: {0}")]
    Refused(String),
}

impl ProviderError {
    /// The fabric's failure code for this error
    /// (`hexactra_core::remote::provider_error_codes`).
    pub fn code(&self) -> &'static str {
        use hexactra_core::remote::provider_error_codes as c;
        match self {
            ProviderError::NotFound => c::NOT_FOUND,
            ProviderError::OriginMismatch => c::ORIGIN_MISMATCH,
            ProviderError::Disabled => c::DISABLED,
            ProviderError::RateLimited { .. } => c::RATE_LIMITED,
            ProviderError::Unavailable => c::UNAVAILABLE,
            ProviderError::Unauthorized => c::UNAUTHORIZED,
            ProviderError::Refused(_) => c::REFUSED,
        }
    }
}

/// A place secrets live: Vault, the built-in store, a test fixture.
///
/// Implementations must hold the rules of Vault's "Holding a value": memory
/// only, never in a log line, span, metric label, event or error message, no
/// caching of responses, a short timeout (use [`http::client`]).
#[async_trait]
pub trait SecretsProvider: Send + Sync {
    /// `vault`, `builtin`, `test`: the id actions name.
    fn id(&self) -> &str;

    /// Items the owner opened to the agent for this origin, exact matches
    /// first. Never a value.
    async fn lookup(
        &self,
        owner: &OwnerId,
        origin: &Origin,
        kind: ItemKind,
    ) -> Result<Vec<ItemSummary>, ProviderError>;

    /// One field of one item, for one purpose, bound to the origin. The
    /// origin must equal one of the item's exactly, or this is
    /// [`ProviderError::OriginMismatch`].
    async fn release(&self, req: ReleaseRequest) -> Result<SecretValue, ProviderError>;

    /// A one-time code and when it expires.
    async fn one_time_code(
        &self,
        req: CodeRequest,
    ) -> Result<(SecretValue, DateTime<Utc>), ProviderError>;
}
