//! Authentication and authorization for Hexactra control plane

use anyhow::Result;

/// Authentication token
pub struct AuthToken {
    pub token: String,
}

impl AuthToken {
    pub fn new(token: &str) -> Self {
        Self {
            token: token.to_string(),
        }
    }
}

/// Authorization check
pub fn authorize(token: &AuthToken, _resource: &str) -> Result<bool> {
    // Simple authorization check - in production this would check permissions
    Ok(!token.token.is_empty())
}
