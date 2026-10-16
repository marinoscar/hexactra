//! Authentication and authorization for Hexactra control plane
//!
//! This module provides scoped authentication with JWT tokens,
//! identity management for humans, clients, and hosts,
//! and fine-grained access control based on ownership and roles.

use anyhow::{anyhow, Result};
use chrono::{Duration, Utc};
use jsonwebtoken::{decode, encode, DecodingKey, EncodingKey, Header, Validation};
use serde::{Deserialize, Serialize};
use sha2::{Sha256, Digest};
use std::collections::HashSet;

/// Current protocol version for token validation
pub const PROTOCOL_VERSION: &str = "1.0.0";

/// Token validity duration (24 hours)
pub const TOKEN_VALIDITY: Duration = Duration::hours(24);

/// Token refresh window (2 hours before expiry)
pub const TOKEN_REFRESH_WINDOW: Duration = Duration::hours(2);

// ==================== Identity Types ====================

/// Unique identifier for any identity (human, client, or host)
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct IdentityId(pub uuid::Uuid);

impl IdentityId {
    pub fn new() -> Self {
        IdentityId(uuid::Uuid::new_v4())
    }

    pub fn from_uuid(uuid: uuid::Uuid) -> Self {
        IdentityId(uuid)
    }

    pub fn as_uuid(&self) -> uuid::Uuid {
        self.0
    }
}

impl std::fmt::Display for IdentityId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.0)
    }
}

impl From<IdentityId> for uuid::Uuid {
    fn from(id: IdentityId) -> Self {
        id.0
    }
}

/// Type of identity
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum IdentityType {
    Human,
    Client,
    Host,
}

impl std::fmt::Display for IdentityType {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            IdentityType::Human => write!(f, "human"),
            IdentityType::Client => write!(f, "client"),
            IdentityType::Host => write!(f, "host"),
        }
    }
}

/// Represents any identity in the system
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Identity {
    pub id: IdentityId,
    pub identity_type: IdentityType,
    pub name: String,
    pub created_at: chrono::DateTime<chrono::Utc>,
    pub updated_at: chrono::DateTime<chrono::Utc>,
}

// ==================== Scopes ====================

/// Scope for access tokens - defines what operations are allowed
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum Scope {
    // Profile scopes
    ProfilesRead,
    ProfilesWrite,
    
    // Session scopes
    SessionsRead,
    SessionsWrite,
    SessionsControl,  // Start/stop/restart sessions
    
    // Goal scopes
    GoalsRead,
    GoalsWrite,
    
    // Operation scopes
    OperationsRead,
    OperationsWrite,
    
    // Interaction request scopes (HITL)
    InteractionRead,
    InteractionWrite,
    
    // Host scopes
    HostsRead,
    HostsWrite,
    
    // Viewer scopes
    ViewerRead,
    
    // Admin scopes
    Admin,
}

impl std::fmt::Display for Scope {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Scope::ProfilesRead => write!(f, "profiles:read"),
            Scope::ProfilesWrite => write!(f, "profiles:write"),
            Scope::SessionsRead => write!(f, "sessions:read"),
            Scope::SessionsWrite => write!(f, "sessions:write"),
            Scope::SessionsControl => write!(f, "sessions:control"),
            Scope::GoalsRead => write!(f, "goals:read"),
            Scope::GoalsWrite => write!(f, "goals:write"),
            Scope::OperationsRead => write!(f, "operations:read"),
            Scope::OperationsWrite => write!(f, "operations:write"),
            Scope::InteractionRead => write!(f, "interaction:read"),
            Scope::InteractionWrite => write!(f, "interaction:write"),
            Scope::HostsRead => write!(f, "hosts:read"),
            Scope::HostsWrite => write!(f, "hosts:write"),
            Scope::ViewerRead => write!(f, "viewer:read"),
            Scope::Admin => write!(f, "admin"),
        }
    }
}

impl Scope {
    pub fn all() -> Vec<Scope> {
        vec![
            Scope::ProfilesRead,
            Scope::ProfilesWrite,
            Scope::SessionsRead,
            Scope::SessionsWrite,
            Scope::SessionsControl,
            Scope::GoalsRead,
            Scope::GoalsWrite,
            Scope::OperationsRead,
            Scope::OperationsWrite,
            Scope::InteractionRead,
            Scope::InteractionWrite,
            Scope::HostsRead,
            Scope::HostsWrite,
            Scope::ViewerRead,
            Scope::Admin,
        ]
    }

    pub fn from_str(s: &str) -> Option<Scope> {
        match s {
            "profiles:read" => Some(Scope::ProfilesRead),
            "profiles:write" => Some(Scope::ProfilesWrite),
            "sessions:read" => Some(Scope::SessionsRead),
            "sessions:write" => Some(Scope::SessionsWrite),
            "sessions:control" => Some(Scope::SessionsControl),
            "goals:read" => Some(Scope::GoalsRead),
            "goals:write" => Some(Scope::GoalsWrite),
            "operations:read" => Some(Scope::OperationsRead),
            "operations:write" => Some(Scope::OperationsWrite),
            "interaction:read" => Some(Scope::InteractionRead),
            "interaction:write" => Some(Scope::InteractionWrite),
            "hosts:read" => Some(Scope::HostsRead),
            "hosts:write" => Some(Scope::HostsWrite),
            "viewer:read" => Some(Scope::ViewerRead),
            "admin" => Some(Scope::Admin),
            _ => None,
        }
    }

    pub fn as_str(&self) -> &'static str {
        match self {
            Scope::ProfilesRead => "profiles:read",
            Scope::ProfilesWrite => "profiles:write",
            Scope::SessionsRead => "sessions:read",
            Scope::SessionsWrite => "sessions:write",
            Scope::SessionsControl => "sessions:control",
            Scope::GoalsRead => "goals:read",
            Scope::GoalsWrite => "goals:write",
            Scope::OperationsRead => "operations:read",
            Scope::OperationsWrite => "operations:write",
            Scope::InteractionRead => "interaction:read",
            Scope::InteractionWrite => "interaction:write",
            Scope::HostsRead => "hosts:read",
            Scope::HostsWrite => "hosts:write",
            Scope::ViewerRead => "viewer:read",
            Scope::Admin => "admin",
        }
    }
}

/// Set of scopes
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Scopes(HashSet<Scope>);

impl Scopes {
    pub fn new() -> Self {
        Scopes(HashSet::new())
    }

    pub fn with_scope(mut self, scope: Scope) -> Self {
        self.0.insert(scope);
        self
    }

    pub fn has(&self, scope: Scope) -> bool {
        self.0.contains(&scope)
    }

    pub fn has_all(&self, scopes: &[Scope]) -> bool {
        scopes.iter().all(|s| self.0.contains(s))
    }

    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }
}

impl Default for Scopes {
    fn default() -> Self {
        Self::new()
    }
}

// ==================== Access Token ====================

/// Claims embedded in JWT access tokens
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AccessTokenClaims {
    /// Unique identifier for the identity
    pub sub: String,
    /// Identity type (human, client, host)
    pub identity_type: String,
    /// Issued at timestamp
    pub iat: i64,
    /// Expiration timestamp
    pub exp: i64,
    /// Token version (for revocation)
    pub version: u64,
    /// Scopes granted to this token
    pub scopes: Vec<String>,
    /// Protocol version
    pub protocol_version: String,
}

/// Access token wrapper
#[derive(Debug, Clone)]
pub struct AccessToken {
    pub token: String,
    pub claims: AccessTokenClaims,
}

impl AccessToken {
    /// Create a new access token with the given claims
    pub fn new(claims: AccessTokenClaims, secret: &str) -> Result<Self> {
        let header = Header::new(jsonwebtoken::Algorithm::HS256);
        let token = encode(&header, &claims, &EncodingKey::from_secret(secret.as_bytes()))?;
        Ok(AccessToken { token, claims })
    }

    /// Validate and decode an access token
    pub fn validate(token: &str, secret: &str) -> Result<Self> {
        let validation = Validation::new(jsonwebtoken::Algorithm::HS256);
        let token_data = decode::<AccessTokenClaims>(
            token,
            &DecodingKey::from_secret(secret.as_bytes()),
            &validation,
        )?;
        
        // Verify protocol version
        if token_data.claims.protocol_version != PROTOCOL_VERSION {
            return Err(anyhow!("Protocol version mismatch"));
        }

        Ok(AccessToken {
            token: token.to_string(),
            claims: token_data.claims,
        })
    }

    /// Check if the token has the required scope
    pub fn has_scope(&self, scope: Scope) -> bool {
        self.claims.scopes.contains(&scope.as_str().to_string())
    }

    /// Check if the token has all required scopes
    pub fn has_all_scopes(&self, scopes: &[Scope]) -> bool {
        scopes.iter().all(|s| self.has_scope(*s))
    }

    /// Check if token is expired or expiring soon
    pub fn is_expired_or_expiring_soon(&self) -> bool {
        let now = Utc::now().timestamp();
        let threshold = self.claims.exp - TOKEN_REFRESH_WINDOW.num_seconds();
        now >= threshold
    }
}

// ==================== Authorization ====================

/// Resource type for authorization
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ResourceType {
    Profile,
    Session,
    Goal,
    Operation,
    Host,
    InteractionRequest,
}

/// Authorization context for access control decisions
#[derive(Debug, Clone)]
pub struct AuthContext {
    pub identity_id: IdentityId,
    pub identity_type: IdentityType,
    pub scopes: Scopes,
}

impl AuthContext {
    /// Check if the context has permission to perform an action on a resource
    pub fn authorize(&self, resource_type: ResourceType, action: &str) -> bool {
        // Admin has full access
        if self.scopes.has(Scope::Admin) {
            return true;
        }

        match (resource_type, action) {
            (ResourceType::Profile, "read") => self.scopes.has(Scope::ProfilesRead),
            (ResourceType::Profile, "write") => self.scopes.has(Scope::ProfilesWrite),
            (ResourceType::Session, "read") => self.scopes.has(Scope::SessionsRead),
            (ResourceType::Session, "write") => self.scopes.has(Scope::SessionsWrite),
            (ResourceType::Session, "control") => self.scopes.has(Scope::SessionsControl),
            (ResourceType::Goal, "read") => self.scopes.has(Scope::GoalsRead),
            (ResourceType::Goal, "write") => self.scopes.has(Scope::GoalsWrite),
            (ResourceType::Operation, "read") => self.scopes.has(Scope::OperationsRead),
            (ResourceType::Operation, "write") => self.scopes.has(Scope::OperationsWrite),
            (ResourceType::Host, "read") => self.scopes.has(Scope::HostsRead),
            (ResourceType::Host, "write") => self.scopes.has(Scope::HostsWrite),
            _ => false,
        }
    }

    /// Check if this identity owns the resource
    pub fn owns(&self, owner_id: &IdentityId) -> bool {
        self.identity_id == *owner_id
    }
}

// ==================== Host Enrollment ====================

/// Host enrollment request
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HostEnrollmentRequest {
    pub hostname: String,
    pub version: String,
    pub capabilities: Vec<String>,
}

/// Host enrollment response with short-lived token
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HostEnrollmentResponse {
    pub host_id: IdentityId,
    pub token: String,
    pub expires_at: chrono::DateTime<chrono::Utc>,
}

/// Host enrollment state
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HostEnrollmentState {
    pub host_id: IdentityId,
    pub hostname: String,
    pub version: String,
    pub capabilities: Vec<String>,
    pub token_hash: String,  // SHA256 hash of the enrollment token
    pub created_at: chrono::DateTime<chrono::Utc>,
    pub expires_at: chrono::DateTime<chrono::Utc>,
}

impl HostEnrollmentState {
    /// Create a new enrollment state with a token
    pub fn new(request: &HostEnrollmentRequest, secret: &str) -> Result<Self> {
        let host_id = IdentityId::new();
        let now = Utc::now();
        let expires_at = now + TOKEN_VALIDITY;

        // Create enrollment token (short-lived, for initial registration only)
        let claims = AccessTokenClaims {
            sub: host_id.to_string(),
            identity_type: IdentityType::Host.to_string(),
            iat: now.timestamp(),
            exp: expires_at.timestamp(),
            version: 1,
            scopes: vec![Scope::HostsWrite.as_str().to_string()],
            protocol_version: PROTOCOL_VERSION.to_string(),
        };

        let token = AccessToken::new(claims, secret)?;

        // Compute token hash for storage (never store raw token)
        let token_hash = format!("sha256:{}", hex::encode(Sha256::digest(token.token.as_bytes())));

        Ok(HostEnrollmentState {
            host_id,
            hostname: request.hostname.clone(),
            version: request.version.clone(),
            capabilities: request.capabilities.clone(),
            token_hash,
            created_at: now,
            expires_at,
        })
    }

    /// Verify that a token matches the stored hash
    pub fn verify_token(&self, token: &str) -> bool {
        let token_hash = format!("sha256:{}", hex::encode(Sha256::digest(token.as_bytes())));
        token_hash == self.token_hash
    }

    /// Check if enrollment is still valid
    pub fn is_valid(&self) -> bool {
        Utc::now() < self.expires_at
    }
}

// ==================== Token Revocation ====================

/// Token revocation list entry
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RevokedToken {
    pub token_hash: String,
    pub revoked_at: chrono::DateTime<chrono::Utc>,
    pub expires_at: chrono::DateTime<chrono::Utc>,  // Original token expiry
}

impl RevokedToken {
    /// Create a new revocation entry
    pub fn new(token: &AccessToken) -> Self {
        let token_hash = format!("sha256:{}", hex::encode(Sha256::digest(token.token.as_bytes())));
        RevokedToken {
            token_hash,
            revoked_at: Utc::now(),
            expires_at: chrono::DateTime::<chrono::Utc>::from_timestamp(
                token.claims.exp,
                0,
            ).unwrap(),
        }
    }

    /// Check if this revocation entry is still relevant (before original expiry)
    pub fn is_still_revoked(&self) -> bool {
        Utc::now() < self.expires_at
    }
}

// ==================== Main Authorization Function ====================

/// Token secret key - in production, this should come from environment/config
static mut TOKEN_SECRET: Option<String> = None;

/// Set the token secret key
pub fn set_token_secret(secret: &str) {
    unsafe {
        TOKEN_SECRET = Some(secret.to_string());
    }
}

/// Get the token secret key
pub fn get_token_secret() -> Result<String> {
    unsafe {
        TOKEN_SECRET.clone()
            .ok_or_else(|| anyhow!("Token secret not configured"))
    }
}

/// Create a new access token for an identity
pub fn create_token(
    identity_id: IdentityId,
    identity_type: IdentityType,
    scopes: Scopes,
) -> Result<AccessToken> {
    let secret = get_token_secret()?;
    let now = Utc::now();
    let expires_at = now + TOKEN_VALIDITY;

    let claims = AccessTokenClaims {
        sub: identity_id.to_string(),
        identity_type: identity_type.to_string(),
        iat: now.timestamp(),
        exp: expires_at.timestamp(),
        version: 1,
        scopes: scopes.0.iter().map(|s| s.as_str().to_string()).collect(),
        protocol_version: PROTOCOL_VERSION.to_string(),
    };

    AccessToken::new(claims, &secret)
}

/// Validate an access token and return the auth context
pub fn validate_token(token: &str) -> Result<AuthContext> {
    let secret = get_token_secret()?;
    let access_token = AccessToken::validate(token, &secret)?;

    // Parse scopes from claims
    let mut scopes = Scopes::new();
    for scope_str in &access_token.claims.scopes {
        if let Some(scope) = Scope::from_str(scope_str) {
            scopes = scopes.with_scope(scope);
        }
    }

    // Parse identity type
    let identity_type = match access_token.claims.identity_type.as_str() {
        "human" => IdentityType::Human,
        "client" => IdentityType::Client,
        "host" => IdentityType::Host,
        _ => return Err(anyhow!("Unknown identity type: {}", access_token.claims.identity_type)),
    };

    // Parse identity ID
    let identity_id_str = &access_token.claims.sub;
    let identity_id = IdentityId::from_uuid(
        uuid::Uuid::parse_str(identity_id_str)
            .map_err(|_| anyhow!("Invalid identity ID: {}", identity_id_str))?,
    );

    Ok(AuthContext {
        identity_id,
        identity_type,
        scopes,
    })
}

/// Check if a token is authorized for a resource and action
pub fn authorize(token: &str, resource_type: ResourceType, action: &str) -> Result<bool> {
    let auth_context = validate_token(token)?;
    Ok(auth_context.authorize(resource_type, action))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_scope_display() {
        assert_eq!(Scope::ProfilesRead.as_str(), "profiles:read");
        assert_eq!(Scope::ProfilesWrite.as_str(), "profiles:write");
        assert_eq!(Scope::SessionsControl.as_str(), "sessions:control");
    }

    #[test]
    fn test_scope_from_str() {
        assert_eq!(Scope::from_str("profiles:read"), Some(Scope::ProfilesRead));
        assert_eq!(Scope::from_str("invalid:scope"), None);
    }

    #[test]
    fn test_token_creation_and_validation() {
        let secret = "test-secret-key";
        set_token_secret(secret);

        let identity_id = IdentityId::new();
        let scopes = Scopes::new()
            .with_scope(Scope::ProfilesRead)
            .with_scope(Scope::SessionsRead);

        let token = create_token(identity_id, IdentityType::Human, scopes.clone()).unwrap();

        // Validate the token
        let auth_context = validate_token(&token.token).unwrap();

        assert_eq!(auth_context.identity_id, identity_id);
        assert_eq!(auth_context.identity_type, IdentityType::Human);
        assert!(auth_context.scopes.has(Scope::ProfilesRead));
        assert!(auth_context.scopes.has(Scope::SessionsRead));
    }

    #[test]
    fn test_authorization() {
        let secret = "test-secret-key";
        set_token_secret(secret);

        let identity_id = IdentityId::new();
        let scopes = Scopes::new()
            .with_scope(Scope::ProfilesRead)
            .with_scope(Scope::SessionsWrite);

        let token = create_token(identity_id, IdentityType::Human, scopes).unwrap();

        // Should be authorized for read profiles
        assert!(authorize(&token.token, ResourceType::Profile, "read").unwrap());

        // Should be authorized for write sessions
        assert!(authorize(&token.token, ResourceType::Session, "write").unwrap());

        // Should NOT be authorized for admin
        assert!(!authorize(&token.token, ResourceType::Host, "admin").unwrap());
    }

    #[test]
    fn test_host_enrollment() {
        let secret = "test-secret-key";
        
        let request = HostEnrollmentRequest {
            hostname: "test-host".to_string(),
            version: "1.0.0".to_string(),
            capabilities: vec!["chrome".to_string(), "desktop".to_string()],
        };

        let enrollment = HostEnrollmentState::new(&request, secret).unwrap();

        assert!(enrollment.is_valid());
        assert_eq!(enrollment.hostname, "test-host");
        assert_eq!(enrollment.version, "1.0.0");

        // Test token verification
        let claims = AccessTokenClaims {
            sub: enrollment.host_id.to_string(),
            identity_type: IdentityType::Host.to_string(),
            iat: enrollment.created_at.timestamp(),
            exp: enrollment.expires_at.timestamp(),
            version: 1,
            scopes: vec![Scope::HostsWrite.as_str().to_string()],
            protocol_version: PROTOCOL_VERSION.to_string(),
        };

        // Recreate token for verification
        let encoding_key = EncodingKey::from_secret(secret.as_bytes());
        let header = Header::new(jsonwebtoken::Algorithm::HS256);
        let token = encode(&header, &claims, &encoding_key).unwrap();

        assert!(enrollment.verify_token(&token));
    }
}
