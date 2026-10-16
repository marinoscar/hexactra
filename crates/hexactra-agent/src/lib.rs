//! Host agent for Hexactra

use anyhow::Result;
use tokio::net::UnixListener;

/// Agent configuration
#[derive(Debug, Clone)]
pub struct AgentConfig {
    pub control_socket_path: String,
    pub chrome_profile_path: Option<String>,
}

/// Host agent service
pub struct AgentService {
    config: AgentConfig,
}

impl AgentService {
    pub fn new(config: AgentConfig) -> Self {
        Self { config }
    }

    /// Start the agent service
    pub async fn start(&self) -> Result<()> {
        // Create control socket
        let _listener = UnixListener::bind(&self.config.control_socket_path)?;
        
        tracing::info!(
            "Agent service started, control socket: {}",
            self.config.control_socket_path
        );
        
        Ok(())
    }

    /// Stop the agent service
    pub async fn stop(&self) -> Result<()> {
        tracing::info!("Agent service stopped");
        Ok(())
    }
}
