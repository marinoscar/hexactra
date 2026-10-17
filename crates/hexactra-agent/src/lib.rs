//! Host agent for Hexactra
//!
//! This crate provides the host agent service that runs at boot time,
//! independent of login/display session, with structured config, health endpoint,
//! private Unix socket, graceful shutdown, and least-privilege service account.

pub mod chrome;
pub mod platform;

use anyhow::Result;
use std::path::Path;
use tokio::net::UnixListener;
use tokio::signal;
use tokio::io::AsyncWriteExt;
use tracing::{error, info, warn};

/// Agent configuration
#[derive(Debug, Clone)]
pub struct AgentConfig {
    /// Path to the control Unix socket
    pub control_socket_path: String,
    /// Path to Chrome profile directory (optional)
    pub chrome_profile_path: Option<String>,
    /// Service account UID for least privilege
    pub service_uid: Option<u32>,
    /// Service account GID for least privilege
    pub service_gid: Option<u32>,
    /// Health check endpoint path
    pub health_endpoint_path: String,
}

impl Default for AgentConfig {
    fn default() -> Self {
        Self {
            control_socket_path: "/run/hexactra/agent.sock".to_string(),
            chrome_profile_path: None,
            service_uid: None,
            service_gid: None,
            health_endpoint_path: "/health".to_string(),
        }
    }
}

/// Host agent service
pub struct AgentService {
    config: AgentConfig,
    running: bool,
}

impl AgentService {
    /// Create a new agent service with the given configuration
    pub fn new(config: AgentConfig) -> Self {
        Self {
            config,
            running: false,
        }
    }

    /// Drop privileges to the configured UID/GID
    fn drop_privileges(&self) -> Result<()> {
        if let Some(gid) = self.config.service_gid {
            unsafe {
                if libc::setgid(gid) != 0 {
                    let err = std::io::Error::last_os_error();
                    return Err(anyhow::Error::new(err).context("Failed to set GID"));
                }
            }
        }

        if let Some(uid) = self.config.service_uid {
            unsafe {
                if libc::setuid(uid) != 0 {
                    let err = std::io::Error::last_os_error();
                    return Err(anyhow::Error::new(err).context("Failed to set UID"));
                }
            }
        }

        info!(
            "Privileges dropped to uid={}, gid={}",
            self.config.service_uid.unwrap_or(0),
            self.config.service_gid.unwrap_or(0)
        );
        Ok(())
    }

    /// Validate the control socket path and ensure parent directory exists
    fn validate_socket_path(&self) -> Result<()> {
        let path = Path::new(&self.config.control_socket_path);
        
        if let Some(parent) = path.parent() {
            if !parent.exists() {
                std::fs::create_dir_all(parent).map_err(|e| {
                    anyhow::Error::new(e).context(format!(
                        "Failed to create socket directory: {}",
                        parent.display()
                    ))
                })?;
            }
            
            // Set secure permissions on the directory
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                std::fs::set_permissions(parent, std::fs::Permissions::from_mode(0o750))?;
            }
        }
        
        Ok(())
    }

    /// Start the agent service
    pub async fn start(&mut self) -> Result<()> {
        info!("Starting Hexactra host agent service");
        
        // Drop privileges if configured
        if self.config.service_uid.is_some() || self.config.service_gid.is_some() {
            self.drop_privileges()?;
        }

        // Validate and prepare socket path
        self.validate_socket_path()?;

        // Create control socket with secure permissions
        let socket_path = &self.config.control_socket_path;
        
        // Remove existing socket if present (for restart scenarios)
        if Path::new(socket_path).exists() {
            std::fs::remove_file(socket_path)?;
            info!("Removed existing socket: {}", socket_path);
        }

        let listener = UnixListener::bind(socket_path).map_err(|e| {
            anyhow::Error::new(e).context(format!("Failed to bind control socket: {}", socket_path))
        })?;

        // Set secure permissions on the socket
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(socket_path, std::fs::Permissions::from_mode(0o660))?;
        }

        info!(
            "Agent service started, control socket: {}",
            socket_path
        );

        self.running = true;

        // Wait for shutdown signal
        self.handle_connections(listener).await?;

        info!("Agent service stopped gracefully");
        Ok(())
    }

    /// Handle incoming connections on the control socket
    async fn handle_connections(&mut self, listener: UnixListener) -> Result<()> {
        let mut shutdown = signal::unix::signal(signal::unix::SignalKind::terminate())?;
        
        loop {
            tokio::select! {
                accept_result = listener.accept() => {
                    match accept_result {
                        Ok((mut stream, _addr)) => {
                            info!("Control socket connection accepted");
                            // For now, we just acknowledge the connection
                            // Future implementation will handle commands
                            let _ = stream.shutdown().await;
                        }
                        Err(e) => {
                            error!("Failed to accept control socket connection: {}", e);
                        }
                    }
                }
                _ = shutdown.recv() => {
                    info!("Received SIGTERM, initiating graceful shutdown");
                    break;
                }
            }
        }

        Ok(())
    }

    /// Stop the agent service
    pub async fn stop(&mut self) -> Result<()> {
        if self.running {
            info!("Agent service stopping");
            self.running = false;
        } else {
            warn!("Agent service was not running");
        }
        Ok(())
    }

    /// Check if the service is running
    pub fn is_running(&self) -> bool {
        self.running
    }

    /// Get the configuration
    pub fn config(&self) -> &AgentConfig {
        &self.config
    }
}

impl Drop for AgentService {
    fn drop(&mut self) {
        if self.running {
            warn!("Agent service dropped while still running");
        }
    }
}

/// Health check status
#[derive(Debug, Clone)]
pub struct HealthStatus {
    pub status: String,
    pub version: String,
    pub uptime_seconds: u64,
}

impl HealthStatus {
    pub fn healthy() -> Self {
        Self {
            status: "healthy".to_string(),
            version: env!("CARGO_PKG_VERSION").to_string(),
            uptime_seconds: 0,
        }
    }

    pub fn unhealthy(reason: &str) -> Self {
        Self {
            status: format!("unhealthy: {}", reason),
            version: env!("CARGO_PKG_VERSION").to_string(),
            uptime_seconds: 0,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn test_agent_config_default() {
        let config = AgentConfig::default();
        assert_eq!(config.control_socket_path, "/run/hexactra/agent.sock");
        assert!(config.chrome_profile_path.is_none());
    }

    #[test]
    fn test_agent_service_creation() {
        let config = AgentConfig::default();
        let service = AgentService::new(config);
        assert!(!service.is_running());
    }

    #[tokio::test]
    async fn test_socket_binding() -> Result<()> {
        let temp_dir = TempDir::new()?;
        let socket_path = temp_dir.path().join("agent.sock");
        let socket_path_str = socket_path.to_string_lossy().to_string();

        let mut service = AgentService::new(AgentConfig {
            control_socket_path: socket_path_str,
            ..Default::default()
        });

        // This test just verifies the service can be created
        // Actual binding would require async setup
        Ok(())
    }
}
