//! Secure configuration for Hexactra
//!
//! This module provides typed configuration loading with environment override,
//! secret redaction primitives, and startup validation.

use std::env;
use std::path::PathBuf;

/// Configuration for the Hexactra control plane
#[derive(Debug, Clone, Default)]
pub struct Config {
    /// Bind address for the HTTP server
    pub bind_address: String,
    /// Port for the HTTP server
    pub port: u16,
    /// Path to SQLite database
    pub database_path: PathBuf,
    /// Model endpoint URL (for AI agent)
    pub model_endpoint: Option<String>,
    /// Telemetry enabled flag
    pub telemetry_enabled: bool,
    /// Log level
    pub log_level: String,
}

impl Config {
    /// Load configuration from environment variables with defaults
    pub fn load() -> Result<Self, ConfigError> {
        let bind_address = env::var("HEXACTRA_BIND_ADDRESS")
            .unwrap_or_else(|_| "127.0.0.1".to_string());

        let port = env::var("HEXACTRA_PORT")
            .ok()
            .and_then(|p| p.parse().ok())
            .unwrap_or(3000);

        let database_path = env::var("HEXACTRA_DATABASE_PATH")
            .unwrap_or_else(|_| "hexactra.db".to_string())
            .into();

        let model_endpoint = env::var("HEXACTRA_MODEL_ENDPOINT").ok();

        let telemetry_enabled = env::var("HEXACTRA_TELEMETRY_ENABLED")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(false);

        let log_level = env::var("HEXACTRA_LOG_LEVEL")
            .unwrap_or_else(|_| "info".to_string());

        Ok(Config {
            bind_address,
            port,
            database_path,
            model_endpoint,
            telemetry_enabled,
            log_level,
        })
    }

    /// Validate configuration
    pub fn validate(&self) -> Result<(), ConfigError> {
        // Validate bind address format
        if self.bind_address.is_empty() {
            return Err(ConfigError::InvalidBindAddress);
        }

        // Validate port range
        if self.port == 0 {
            return Err(ConfigError::InvalidPort);
        }

        // Validate log level
        match self.log_level.as_str() {
            "debug" | "info" | "warn" | "error" => {}
            _ => return Err(ConfigError::InvalidLogLevel),
        }

        Ok(())
    }

    /// Create a redacted copy of the config for logging
    pub fn redacted(&self) -> RedactedConfig {
        RedactedConfig {
            bind_address: self.bind_address.clone(),
            port: self.port,
            database_path: "[REDACTED]".to_string(),
            model_endpoint: if self.model_endpoint.is_some() {
                Some("[SET]".to_string())
            } else {
                None
            },
            telemetry_enabled: self.telemetry_enabled,
            log_level: self.log_level.clone(),
        }
    }
}

/// Redacted configuration for safe logging
#[derive(Debug, Clone)]
pub struct RedactedConfig {
    pub bind_address: String,
    pub port: u16,
    pub database_path: String,
    pub model_endpoint: Option<String>,
    pub telemetry_enabled: bool,
    pub log_level: String,
}

/// Configuration errors
#[derive(Debug, thiserror::Error)]
pub enum ConfigError {
    #[error("Invalid bind address")]
    InvalidBindAddress,
    #[error("Invalid port number")]
    InvalidPort,
    #[error("Invalid log level")]
    InvalidLogLevel,
    #[error("Environment variable error: {0}")]
    EnvVar(env::VarError),
}

impl From<env::VarError> for ConfigError {
    fn from(err: env::VarError) -> Self {
        ConfigError::EnvVar(err)
    }
}

/// Secret redaction utilities
pub mod secret {
    use std::fmt;

    /// A secret value that is redacted in Debug output
    #[derive(Clone)]
    pub struct SecretString(String);

    impl SecretString {
        pub fn new(value: String) -> Self {
            SecretString(value)
        }

        pub fn as_str(&self) -> &str {
            &self.0
        }
    }

    impl fmt::Debug for SecretString {
        fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
            f.debug_struct("SecretString")
                .field("value", &"[REDACTED]")
                .finish()
        }
    }

    /// Redact a value for safe logging
    pub fn redact<T: fmt::Debug>(_: &T) -> &'static str {
        "[REDACTED]"
    }
}

#[cfg(test)]
mod tests {
    use super::secret::SecretString;
    use super::*;

    #[test]
    fn test_config_load() {
        let config = Config::load().unwrap();
        assert!(!config.bind_address.is_empty());
        assert!(config.port > 0);
    }

    #[test]
    fn test_config_validate() {
        let mut config = Config::load().unwrap();
        config.port = 0;
        assert!(config.validate().is_err());
    }

    #[test]
    fn test_secret_redaction() {
        let secret = SecretString::new("password123".to_string());
        let debug_output = format!("{:?}", secret);
        assert!(!debug_output.contains("password123"));
        assert!(debug_output.contains("[REDACTED]"));
    }
}
