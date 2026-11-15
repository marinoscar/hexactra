//! Scoped credentials for the `/v1` API (#210).
//!
//! | Kind | Prefix | May call |
//! |---|---|---|
//! | operator | (configured token) | everything, including `/v1/admin/*` |
//! | service | `hxs_` | client routes (sessions, actions, handoffs, webhooks, hosts list) and host enrollment |
//! | host | `hxh_` | only its own host routes (`register`, `next`, `result`) |
//! | enrollment | `hxe_` | only `POST /v1/hosts/enroll`, once, before it expires |
//!
//! Tokens are stored as SHA-256 digests only. A host credential is minted
//! when a host exchanges an enrollment token; revoking a host removes its
//! credential so it can no longer poll.

use std::sync::{Arc, Mutex};

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use uuid::Uuid;

/// Who is calling.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Principal {
    /// The deployment's operator token: full access.
    Operator,
    /// A service token (e.g. the Hexactra Console).
    Service(Uuid),
    /// A host agent's own credential.
    Host(Uuid),
}

impl Principal {
    /// Operator or service: may use client routes.
    pub fn is_client(self) -> bool {
        matches!(self, Principal::Operator | Principal::Service(_))
    }
}

/// A service token as listed (never includes the token).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ServiceTokenView {
    pub id: Uuid,
    pub name: String,
    pub created_at: DateTime<Utc>,
}

/// A pending host enrollment.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct EnrollmentView {
    pub id: Uuid,
    /// Suggested host name (the host may send its own).
    pub name: Option<String>,
    pub created_at: DateTime<Utc>,
    pub expires_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct ServiceTokenRecord {
    pub view: ServiceTokenView,
    pub digest: [u8; 32],
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct EnrollmentRecord {
    pub view: EnrollmentView,
    pub digest: [u8; 32],
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct HostCredentialRecord {
    pub host_id: Uuid,
    pub digest: [u8; 32],
    pub created_at: DateTime<Utc>,
}

/// Everything persisted for credentials (digests only).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub(crate) struct CredentialState {
    pub service: Vec<ServiceTokenRecord>,
    pub enrollments: Vec<EnrollmentRecord>,
    pub hosts: Vec<HostCredentialRecord>,
}

/// Credential store. Cheap to clone.
#[derive(Clone)]
pub struct Credentials {
    operator: Arc<[u8; 32]>,
    state: Arc<Mutex<CredentialState>>,
}

pub(super) fn digest(token: &str) -> [u8; 32] {
    Sha256::digest(token.as_bytes()).into()
}

fn ct_eq(a: &[u8; 32], b: &[u8; 32]) -> bool {
    a.iter()
        .zip(b.iter())
        .fold(0u8, |acc, (x, y)| acc | (x ^ y))
        == 0
}

fn mint(prefix: &str) -> String {
    format!("{prefix}{}", super::generate_token())
}

/// Credential errors.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum CredentialError {
    #[error("invalid, used or expired enrollment token")]
    InvalidEnrollment,
    #[error("{0} not found")]
    NotFound(&'static str),
    #[error("{0}")]
    Invalid(String),
}

impl Credentials {
    pub fn new(operator_token: &str) -> Self {
        Self {
            operator: Arc::new(digest(operator_token)),
            state: Arc::new(Mutex::new(CredentialState::default())),
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, CredentialState> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Snapshot for persistence.
    pub(super) fn export(&self) -> CredentialState {
        self.lock().clone()
    }

    /// Restore from persistence.
    pub(super) fn import(&self, s: CredentialState) {
        *self.lock() = s;
    }

    /// True if `token` is the operator token.
    pub fn is_operator(&self, token: &str) -> bool {
        ct_eq(&self.operator, &digest(token))
    }

    /// Resolve a bearer token to a principal.
    pub fn authenticate(&self, token: &str) -> Option<Principal> {
        let d = digest(token);
        if ct_eq(&self.operator, &d) {
            return Some(Principal::Operator);
        }
        let s = self.lock();
        if token.starts_with("hxs_") {
            return s
                .service
                .iter()
                .find(|r| ct_eq(&r.digest, &d))
                .map(|r| Principal::Service(r.view.id));
        }
        if token.starts_with("hxh_") {
            return s
                .hosts
                .iter()
                .find(|r| ct_eq(&r.digest, &d))
                .map(|r| Principal::Host(r.host_id));
        }
        None
    }

    // ------------------------------------------------------------ service

    pub fn create_service_token(
        &self,
        name: &str,
    ) -> Result<(ServiceTokenView, String), CredentialError> {
        let name = name.trim();
        if name.is_empty() || name.len() > 100 {
            return Err(CredentialError::Invalid(
                "name must be 1-100 characters".into(),
            ));
        }
        let token = mint("hxs_");
        let view = ServiceTokenView {
            id: Uuid::new_v4(),
            name: name.to_string(),
            created_at: Utc::now(),
        };
        self.lock().service.push(ServiceTokenRecord {
            view: view.clone(),
            digest: digest(&token),
        });
        Ok((view, token))
    }

    pub fn list_service_tokens(&self) -> Vec<ServiceTokenView> {
        self.lock().service.iter().map(|r| r.view.clone()).collect()
    }

    pub fn revoke_service_token(&self, id: Uuid) -> Result<(), CredentialError> {
        let mut s = self.lock();
        let before = s.service.len();
        s.service.retain(|r| r.view.id != id);
        if s.service.len() == before {
            return Err(CredentialError::NotFound("service token"));
        }
        Ok(())
    }

    // --------------------------------------------------------- enrollment

    /// Create a single-use enrollment token valid for `ttl`.
    pub fn create_enrollment(
        &self,
        name: Option<String>,
        ttl: std::time::Duration,
    ) -> Result<(EnrollmentView, String), CredentialError> {
        if let Some(n) = &name {
            if n.trim().is_empty() || n.len() > 128 {
                return Err(CredentialError::Invalid(
                    "name must be 1-128 characters".into(),
                ));
            }
        }
        let token = mint("hxe_");
        let now = Utc::now();
        let view = EnrollmentView {
            id: Uuid::new_v4(),
            name: name.map(|n| n.trim().to_string()),
            created_at: now,
            expires_at: now + chrono::Duration::from_std(ttl).unwrap_or_default(),
        };
        let mut s = self.lock();
        s.enrollments.retain(|e| e.view.expires_at > now);
        s.enrollments.push(EnrollmentRecord {
            view: view.clone(),
            digest: digest(&token),
        });
        Ok((view, token))
    }

    pub fn list_enrollments(&self) -> Vec<EnrollmentView> {
        let now = Utc::now();
        self.lock()
            .enrollments
            .iter()
            .filter(|e| e.view.expires_at > now)
            .map(|e| e.view.clone())
            .collect()
    }

    /// Consume an enrollment token and mint a host credential for a new host
    /// id. Returns `(host_id, host_token, suggested_name)`.
    pub fn enroll_host(
        &self,
        enrollment_token: &str,
    ) -> Result<(Uuid, String, Option<String>), CredentialError> {
        if !enrollment_token.starts_with("hxe_") {
            return Err(CredentialError::InvalidEnrollment);
        }
        let d = digest(enrollment_token);
        let now = Utc::now();
        let mut s = self.lock();
        let idx = s
            .enrollments
            .iter()
            .position(|e| ct_eq(&e.digest, &d) && e.view.expires_at > now)
            .ok_or(CredentialError::InvalidEnrollment)?;
        let e = s.enrollments.remove(idx);
        let host_id = Uuid::new_v4();
        let token = mint("hxh_");
        s.hosts.push(HostCredentialRecord {
            host_id,
            digest: digest(&token),
            created_at: now,
        });
        Ok((host_id, token, e.view.name))
    }

    /// Remove a host's credential.
    pub fn revoke_host(&self, host_id: Uuid) -> bool {
        let mut s = self.lock();
        let before = s.hosts.len();
        s.hosts.retain(|r| r.host_id != host_id);
        s.hosts.len() != before
    }

    /// Whether a host has an enrolled credential.
    pub fn host_enrolled(&self, host_id: Uuid) -> bool {
        self.lock().hosts.iter().any(|r| r.host_id == host_id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn principals_and_scopes() {
        let c = Credentials::new("operator-token-0123456789abcdef");
        assert_eq!(
            c.authenticate("operator-token-0123456789abcdef"),
            Some(Principal::Operator)
        );
        assert_eq!(c.authenticate("nope"), None);
        let (sv, st) = c.create_service_token("console").unwrap();
        assert!(st.starts_with("hxs_"));
        assert_eq!(c.authenticate(&st), Some(Principal::Service(sv.id)));
        assert!(!serde_json::to_string(&c.list_service_tokens())
            .unwrap()
            .contains(&st));
        c.revoke_service_token(sv.id).unwrap();
        assert_eq!(c.authenticate(&st), None);
    }

    #[test]
    fn enrollment_is_single_use_and_expires() {
        let c = Credentials::new("operator-token-0123456789abcdef");
        let (_, et) = c
            .create_enrollment(Some("vps".into()), Duration::from_secs(60))
            .unwrap();
        let (host_id, ht, name) = c.enroll_host(&et).unwrap();
        assert_eq!(name.as_deref(), Some("vps"));
        assert_eq!(c.authenticate(&ht), Some(Principal::Host(host_id)));
        assert_eq!(
            c.enroll_host(&et).unwrap_err(),
            CredentialError::InvalidEnrollment
        );
        // An enrollment token is not a bearer credential.
        assert_eq!(c.authenticate(&et), None);
        assert!(c.revoke_host(host_id));
        assert_eq!(c.authenticate(&ht), None);

        let (_, expired) = c.create_enrollment(None, Duration::ZERO).unwrap();
        assert_eq!(
            c.enroll_host(&expired).unwrap_err(),
            CredentialError::InvalidEnrollment
        );
    }

    #[test]
    fn state_round_trips_without_tokens() {
        let c = Credentials::new("operator-token-0123456789abcdef");
        let (_, st) = c.create_service_token("console").unwrap();
        let exported = serde_json::to_string(&c.export()).unwrap();
        assert!(!exported.contains(&st));
        let c2 = Credentials::new("operator-token-0123456789abcdef");
        c2.import(serde_json::from_str(&exported).unwrap());
        assert!(matches!(c2.authenticate(&st), Some(Principal::Service(_))));
    }
}
