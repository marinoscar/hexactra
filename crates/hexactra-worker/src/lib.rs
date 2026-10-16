//! Session worker for Hexactra

use anyhow::{Context, Result};
use hexactra_core::{BrowserAction, SessionId};
use tokio::sync::mpsc;
use tokio::net::UnixStream;
use tokio::io::AsyncWriteExt;
use std::path::Path;
use uuid::Uuid;

/// Worker configuration
#[derive(Debug, Clone)]
pub struct WorkerConfig {
    pub session_id: SessionId,
    pub control_socket: String,
}

/// Session worker that executes browser actions
pub struct SessionWorker {
    config: WorkerConfig,
    action_tx: Option<mpsc::Sender<BrowserAction>>,
    action_rx: Option<mpsc::Receiver<BrowserAction>>,
}

impl SessionWorker {
    pub fn new(config: WorkerConfig) -> Self {
        let (tx, rx) = mpsc::channel(100);
        Self {
            config,
            action_tx: Some(tx),
            action_rx: Some(rx),
        }
    }

    /// Start the worker
    pub async fn start(&mut self) -> Result<()> {
        tracing::info!("Starting worker for session: {:?}", self.config.session_id);

        // Spawn the action handler task
        if let Some(rx) = self.action_rx.take() {
            let config = self.config.clone();
            tokio::spawn(Self::handle_actions(config, rx));
        }

        Ok(())
    }

    /// Stop the worker
    pub async fn stop(&self) -> Result<()> {
        tracing::info!("Stopping worker for session: {:?}", self.config.session_id);
        Ok(())
    }

    /// Send an action to the worker
    pub async fn send_action(&self, action: BrowserAction) -> Result<()> {
        if let Some(tx) = &self.action_tx {
            tx.send(action).await?;
        }
        Ok(())
    }

    /// Handle actions from the channel
    async fn handle_actions(_config: WorkerConfig, mut rx: mpsc::Receiver<BrowserAction>) {
        while let Some(action) = rx.recv().await {
            tracing::info!("Handling action: {:?}", action);
            // TODO: Execute action via native messaging host
        }
    }

    /// Connect to the native messaging host via Unix socket
    pub async fn connect_to_native_host(&self) -> Result<UnixStream> {
        let path = Path::new(&self.config.control_socket);
        
        // Wait for the socket to be available
        let mut attempts = 0;
        while !path.exists() && attempts < 30 {
            tokio::time::sleep(tokio::time::Duration::from_millis(100)).await;
            attempts += 1;
        }

        if !path.exists() {
            return Err(anyhow::anyhow!(
                "Native messaging host socket not found at {}",
                self.config.control_socket
            ));
        }

        UnixStream::connect(path).await.context("Failed to connect to native messaging host")
    }
}

/// BrowserDriver trait for platform-specific browser control
pub trait BrowserDriver {
    /// Get the driver name
    fn name(&self) -> &str;

    /// Initialize the driver
    fn initialize(&mut self) -> Result<()>;

    /// Cleanup the driver
    fn cleanup(&mut self) -> Result<()>;

    /// Execute a browser action
    fn execute(&mut self, action: BrowserAction) -> Result<BrowserObservation>;

    /// Check if the driver is ready
    fn is_ready(&self) -> bool;
}

/// Observation from a browser action
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BrowserObservation {
    /// Navigation completed successfully
    Navigate { url: String },
    /// Element clicked successfully
    Click { selector: String },
    /// Text typed successfully
    Type { selector: String, text: String },
    /// Value retrieved successfully
    GetValue { selector: String, value: String },
    /// Screenshot captured (as artifact handle)
    Screenshot { artifact_id: Uuid },
    /// Script executed successfully
    ExecuteScript { result: serde_json::Value },
    /// Element found
    WaitForElement { selector: String, found: bool },
    /// Navigation history action completed
    History { action: String },
    /// Page refreshed
    Refresh,
    /// Error observation
    Error { message: String },
}

/// Native messaging host driver
pub struct NativeMessagingDriver {
    socket_path: String,
    connected: bool,
}

impl NativeMessagingDriver {
    pub fn new(socket_path: String) -> Self {
        Self {
            socket_path,
            connected: false,
        }
    }

    /// Connect to the native messaging host
    pub async fn connect(&mut self) -> Result<()> {
        let mut stream = UnixStream::connect(&self.socket_path).await?;
        
        // Send hello message
        let hello = serde_json::json!({
            "type": "hello",
            "version": "1.0.0"
        });
        let message = format!("{}\n", serde_json::to_string(&hello)?);
        stream.write_all(message.as_bytes()).await?;
        
        self.connected = true;
        Ok(())
    }

    /// Disconnect from the native messaging host
    pub fn disconnect(&mut self) {
        self.connected = false;
    }
}

impl BrowserDriver for NativeMessagingDriver {
    fn name(&self) -> &str {
        "native-messaging"
    }

    fn initialize(&mut self) -> Result<()> {
        tracing::info!("Initializing native messaging driver");
        Ok(())
    }

    fn cleanup(&mut self) -> Result<()> {
        tracing::info!("Cleaning up native messaging driver");
        self.disconnect();
        Ok(())
    }

    fn execute(&mut self, action: BrowserAction) -> Result<BrowserObservation> {
        if !self.connected {
            return Err(anyhow::anyhow!("Not connected to native messaging host"));
        }

        // Convert action to message
        let message = serde_json::to_string(&action)?;
        
        // TODO: Send message via Unix socket
        tracing::debug!("Sending action to native host: {}", message);

        // Return success observation
        match action {
            BrowserAction::Navigate { url } => Ok(BrowserObservation::Navigate { url }),
            BrowserAction::Click { selector } => Ok(BrowserObservation::Click { selector }),
            BrowserAction::Type { selector, text } => Ok(BrowserObservation::Type { selector, text }),
            BrowserAction::GetValue { selector } => Ok(BrowserObservation::GetValue { selector, value: String::new() }),
            BrowserAction::Screenshot => Ok(BrowserObservation::Screenshot { artifact_id: Uuid::new_v4() }),
            BrowserAction::ExecuteScript { script: _ } => Ok(BrowserObservation::ExecuteScript { result: serde_json::Value::Null }),
            BrowserAction::WaitForElement { selector, timeout_ms: _ } => Ok(BrowserObservation::WaitForElement { selector, found: true }),
            BrowserAction::Back => Ok(BrowserObservation::History { action: "back".to_string() }),
            BrowserAction::Forward => Ok(BrowserObservation::History { action: "forward".to_string() }),
            BrowserAction::Refresh => Ok(BrowserObservation::Refresh),
        }
    }

    fn is_ready(&self) -> bool {
        self.connected
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_worker_config() {
        let config = WorkerConfig {
            session_id: SessionId::new(),
            control_socket: "/tmp/test.sock".to_string(),
        };
        assert_eq!(config.control_socket, "/tmp/test.sock");
    }

    #[test]
    fn test_browser_observation() {
        let obs = BrowserObservation::Navigate { url: "https://example.com".to_string() };
        // Just verify the observation can be created
        match obs {
            BrowserObservation::Navigate { url } => assert_eq!(url, "https://example.com"),
            _ => panic!("Unexpected variant"),
        }
    }

    #[test]
    fn test_native_messaging_driver_name() {
        let driver = NativeMessagingDriver::new("/tmp/test.sock".to_string());
        assert_eq!(driver.name(), "native-messaging");
    }
}
