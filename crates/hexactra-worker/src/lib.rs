//! Session worker for Hexactra

use anyhow::{Context, Result};
use chrono::{DateTime, Utc};
use hexactra_core::{BrowserAction, SessionId};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::time::Duration;
use tokio::sync::mpsc;
use tokio::net::UnixStream;
use tokio::io::AsyncWriteExt;
use uuid::Uuid;
use std::path::Path;
use hexactra_telemetry::{start_span, Metrics, track_action_executed, track_action_failed};

// Re-export secret transport for integration
pub use hexactra_core::secret_transport::{SecretStore, SecretTransport, SecretReference};

/// Worker configuration
#[derive(Debug, Clone)]
pub struct WorkerConfig {
    pub session_id: SessionId,
    pub control_socket: String,
    pub max_payload_size: usize,
    pub action_timeout: Duration,
}

impl Default for WorkerConfig {
    fn default() -> Self {
        Self {
            session_id: SessionId::new(),
            control_socket: "/tmp/hexactra-control.sock".to_string(),
            max_payload_size: 1024 * 1024, // 1 MB
            action_timeout: Duration::from_secs(30),
        }
    }
}

/// Worker state
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WorkerState {
    /// Worker is initializing
    Initializing,
    /// Worker is running and ready
    Running,
    /// Worker is paused
    Paused,
    /// Worker is stopping
    Stopping,
    /// Worker has stopped
    Stopped,
}

/// Action status
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ActionStatus {
    /// Action is queued
    Queued,
    /// Action is in progress
    InProgress,
    /// Action completed successfully
    Completed,
    /// Action failed
    Failed,
    /// Action timed out
    TimedOut,
    /// Action status is unknown (e.g., bridge crashed)
    Unknown,
    /// Action should be retried
    Retryable,
}

/// Result of an action with proper lifecycle tracking
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ActionResult {
    /// Unique action ID
    pub action_id: Uuid,
    /// Session ID
    pub session_id: SessionId,
    /// Status of the action
    pub status: ActionStatus,
    /// Error message if any
    pub error: Option<String>,
    /// Timestamp when action was created
    pub created_at: DateTime<Utc>,
    /// Timestamp when action was completed
    pub completed_at: Option<DateTime<Utc>>,
    /// Result data if successful
    pub data: Option<serde_json::Value>,
}

/// Pending operation tracking
#[derive(Debug, Clone)]
pub struct PendingOperation {
    pub action_id: Uuid,
    pub action: BrowserAction,
    pub status: ActionStatus,
    pub created_at: DateTime<Utc>,
    pub retry_count: u32,
    pub max_retries: u32,
}

/// Worker event for lifecycle management
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", content = "payload")]
pub enum WorkerEvent {
    /// Worker started
    Started { session_id: SessionId },
    /// Worker stopped
    Stopped { session_id: SessionId },
    /// Action completed
    ActionCompleted { result: ActionResult },
    /// Action failed
    ActionFailed { action_id: Uuid, error: String },
    /// Bridge connection lost
    BridgeLost,
    /// Bridge reconnected
    BridgeReconnected,
}

/// Session worker that executes browser actions with lifecycle management
pub struct SessionWorker {
    config: WorkerConfig,
    state: WorkerState,
    action_tx: Option<mpsc::Sender<BrowserAction>>,
    action_rx: Option<mpsc::Receiver<BrowserAction>>,
    pending_operations: HashMap<Uuid, PendingOperation>,
    completed_actions: Vec<ActionResult>,
    secret_transport: SecretTransport,
}

impl SessionWorker {
    pub fn new(config: WorkerConfig) -> Self {
        let (tx, rx) = mpsc::channel(100);
        Self {
            config,
            state: WorkerState::Initializing,
            action_tx: Some(tx),
            action_rx: Some(rx),
            pending_operations: HashMap::new(),
            completed_actions: Vec::new(),
            secret_transport: SecretTransport::new(),
        }
    }

    /// Start the worker
    pub async fn start(&mut self) -> Result<()> {
        if self.state != WorkerState::Initializing {
            return Err(anyhow::anyhow!("Worker already started or stopped"));
        }

        let _span = start_span("worker.start", &self.config.session_id.to_string());
        tracing::info!("Starting worker for session: {:?}", self.config.session_id);

        // Spawn the action handler task
        if let Some(rx) = self.action_rx.take() {
            let config = self.config.clone();
            tokio::spawn(Self::handle_actions(config, rx));
        }

        self.state = WorkerState::Running;
        Ok(())
    }

    /// Stop the worker
    pub async fn stop(&mut self) -> Result<()> {
        if self.state != WorkerState::Running {
            return Err(anyhow::anyhow!("Worker not running"));
        }

        let _span = start_span("worker.stop", &self.config.session_id.to_string());
        tracing::info!("Stopping worker for session: {:?}", self.config.session_id);

        // Wait for pending operations to complete or timeout
        self.wait_for_pending().await?;

        self.state = WorkerState::Stopped;
        Ok(())
    }

    /// Send an action to the worker
    pub async fn send_action(&mut self, action: BrowserAction) -> Result<Uuid> {
        let _span = start_span("worker.send_action", &self.config.session_id.to_string());
        let action_id = Uuid::new_v4();
        let action_clone = action.clone();
        
        if let Some(tx) = &self.action_tx {
            tx.send(action).await?;
        }
        
        // Track pending operation
        self.pending_operations.insert(
            action_id,
            PendingOperation {
                action_id,
                action: action_clone,
                status: ActionStatus::Queued,
                created_at: Utc::now(),
                retry_count: 0,
                max_retries: 3,
            },
        );

        Ok(action_id)
    }

    /// Handle actions from the channel
    async fn handle_actions(config: WorkerConfig, mut rx: mpsc::Receiver<BrowserAction>) {
        let metrics = Metrics::new();
        while let Some(action) = rx.recv().await {
            let _span = start_span("worker.handle_action", &config.session_id.to_string());
            tracing::info!("Handling action: {:?}", action);

            // Check if this is a Type action that might contain secrets
            match &action {
                BrowserAction::Type { selector, text } => {
                    // In production, the text would be a secret reference
                    // For now, we log that a type action was received (without the actual text)
                    tracing::debug!("Type action for selector: {}", selector);
                    // Note: The actual secret text should never be logged
                }
                _ => {
                    tracing::debug!("Action: {:?}", action);
                }
            }

            // Track action execution
            track_action_executed(&metrics);

            // TODO: Execute action via native messaging host
            // When executing Type actions, retrieve the secret from the transport
        }
    }

    /// Wait for pending operations to complete
    async fn wait_for_pending(&mut self) -> Result<()> {
        // Wait for all pending operations to complete or timeout
        let timeout = tokio::time::sleep(self.config.action_timeout);
        tokio::pin!(timeout);

        loop {
            if self.pending_operations.is_empty() {
                break;
            }

            tokio::select! {
                _ = &mut timeout => {
                    // Timeout - mark all pending operations as unknown
                    for (_op_id, op) in &mut self.pending_operations {
                        op.status = ActionStatus::Unknown;
                    }
                    break;
                }
            }
        }

        Ok(())
    }

    /// Mark an action as completed
    pub fn complete_action(&mut self, action_id: Uuid, status: ActionStatus, error: Option<String>) {
        if let Some(op) = self.pending_operations.remove(&action_id) {
            self.completed_actions.push(ActionResult {
                action_id,
                session_id: self.config.session_id,
                status,
                error,
                created_at: op.created_at,
                completed_at: Some(Utc::now()),
                data: None,
            });
        }
    }

    /// Reconcile pending operations after a crash/reconnect
    pub fn reconcile_pending(&mut self) {
        for (_id, op) in &mut self.pending_operations {
            // Mark as retryable after crash
            if op.retry_count < op.max_retries {
                op.status = ActionStatus::Retryable;
                op.retry_count += 1;
            } else {
                op.status = ActionStatus::Failed;
            }
        }
    }

    /// Get the current state
    pub fn state(&self) -> WorkerState {
        self.state.clone()
    }

    /// Get pending operations count
    pub fn pending_count(&self) -> usize {
        self.pending_operations.len()
    }

    /// Get completed actions
    pub fn completed_actions(&self) -> &[ActionResult] {
        &self.completed_actions
    }

    /// Store a secret for browser action (e.g., password/OTP input)
    /// The secret is stored in memory only and never persisted
    pub async fn store_secret(&self, value: String, ttl_minutes: i64) -> Result<SecretReference> {
        // Create a unique session/action context for this secret
        let session_id = self.config.session_id.as_uuid();
        let action_id = Uuid::new_v4();

        self.secret_transport
            .create_secret_reference(value, session_id, action_id, ttl_minutes)
            .await
            .map_err(|e| anyhow::anyhow!("Failed to store secret: {}", e))
    }

    /// Verify a secret reference is still valid before use
    pub async fn verify_secret(&self, ref_: &SecretReference) -> Result<bool> {
        self.secret_transport.verify_secret_reference(ref_).await
            .map_err(|e| anyhow::anyhow!("Failed to verify secret: {}", e))
    }

    /// Retrieve and consume a secret (removes it from store)
    pub async fn retrieve_secret(&self, ref_: &SecretReference) -> Result<Option<String>> {
        self.secret_transport.retrieve_secret_from_reference(ref_).await
            .map_err(|e| anyhow::anyhow!("Failed to retrieve secret: {}", e))
    }

    /// Cleanup expired secrets from the transport
    pub async fn cleanup_secrets(&self) -> Result<u64> {
        self.secret_transport.cleanup().await
            .map_err(|e| anyhow::anyhow!("Failed to cleanup secrets: {}", e))
    }
}

/// Native messaging bridge for connection management
pub struct NativeMessagingBridge {
    socket_path: String,
    connected: bool,
    reconnect_attempts: u32,
    max_reconnect_attempts: u32,
}

impl NativeMessagingBridge {
    pub fn new(socket_path: String) -> Self {
        Self {
            socket_path,
            connected: false,
            reconnect_attempts: 0,
            max_reconnect_attempts: 5,
        }
    }

    /// Connect to the native messaging host
    pub async fn connect(&mut self) -> Result<()> {
        // Wait for the socket to be available
        let mut attempts = 0;
        while !Path::new(&self.socket_path).exists() && attempts < 30 {
            tokio::time::sleep(Duration::from_millis(100)).await;
            attempts += 1;
        }

        if !Path::new(&self.socket_path).exists() {
            return Err(anyhow::anyhow!(
                "Native messaging host socket not found at {}",
                self.socket_path
            ));
        }

        let mut stream = UnixStream::connect(&self.socket_path).await?;
        
        // Send hello message
        let hello = serde_json::json!({
            "type": "hello",
            "version": "1.0.0"
        });
        let message = format!("{}\n", serde_json::to_string(&hello)?);
        stream.write_all(message.as_bytes()).await?;
        
        self.connected = true;
        self.reconnect_attempts = 0;
        Ok(())
    }

    /// Disconnect from the native messaging host
    pub fn disconnect(&mut self) {
        self.connected = false;
    }

    /// Check if the bridge is connected
    pub fn is_connected(&self) -> bool {
        self.connected
    }

    /// Try to reconnect
    pub async fn try_reconnect(&mut self) -> Result<()> {
        if self.reconnect_attempts >= self.max_reconnect_attempts {
            return Err(anyhow::anyhow!("Max reconnect attempts reached"));
        }

        self.disconnect();
        tokio::time::sleep(Duration::from_millis(100 * (self.reconnect_attempts + 1) as u64)).await;
        
        self.connect().await?;
        self.reconnect_attempts += 1;
        Ok(())
    }
}

impl Default for NativeMessagingBridge {
    fn default() -> Self {
        Self::new("/tmp/hexactra-control.sock".to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_worker_config_default() {
        let config = WorkerConfig::default();
        assert_eq!(config.max_payload_size, 1024 * 1024);
        assert_eq!(config.action_timeout, Duration::from_secs(30));
    }

    #[test]
    fn test_action_result() {
        let result = ActionResult {
            action_id: Uuid::new_v4(),
            session_id: SessionId::new(),
            status: ActionStatus::Completed,
            error: None,
            created_at: Utc::now(),
            completed_at: Some(Utc::now()),
            data: Some(serde_json::json!({"result": "success"})),
        };
        assert_eq!(result.status, ActionStatus::Completed);
        assert!(result.data.is_some());
    }

    #[test]
    fn test_pending_operation() {
        let op = PendingOperation {
            action_id: Uuid::new_v4(),
            action: BrowserAction::Screenshot,
            status: ActionStatus::Queued,
            created_at: Utc::now(),
            retry_count: 0,
            max_retries: 3,
        };
        assert_eq!(op.status, ActionStatus::Queued);
        assert_eq!(op.max_retries, 3);
    }

    #[test]
    fn test_worker_state() {
        let config = WorkerConfig::default();
        let worker = SessionWorker::new(config);
        
        // Initial state should be Initializing
        assert_eq!(worker.state(), WorkerState::Initializing);
    }

    #[test]
    fn test_action_status_serialization() {
        let status = ActionStatus::Retryable;
        let json = serde_json::to_string(&status).unwrap();
        assert_eq!(json, "\"retryable\"");
    }

    #[test]
    fn test_native_messaging_bridge_default() {
        let bridge = NativeMessagingBridge::default();
        assert!(!bridge.is_connected());
        assert_eq!(bridge.max_reconnect_attempts, 5);
    }

    #[tokio::test]
    async fn test_secret_storage_and_retrieval() {
        let config = WorkerConfig::default();
        let worker = SessionWorker::new(config);

        // Store a secret
        let secret_value = "test-password-123";
        let ref_ = worker.store_secret(secret_value.to_string(), 15).await.unwrap();

        // Verify the secret can be retrieved
        let retrieved = worker.retrieve_secret(&ref_).await.unwrap();
        assert_eq!(retrieved, Some(secret_value.to_string()));

        // Retrieve again should fail (single-use)
        let retrieved_again = worker.retrieve_secret(&ref_).await.unwrap();
        assert_eq!(retrieved_again, None);
    }

    #[tokio::test]
    async fn test_secret_verification() {
        let config = WorkerConfig::default();
        let worker = SessionWorker::new(config);

        // Store a secret
        let ref_ = worker.store_secret("verify-test".to_string(), 15).await.unwrap();

        // Verify should work
        assert!(worker.verify_secret(&ref_).await.unwrap());

        // Retrieve and verify again should fail
        worker.retrieve_secret(&ref_).await.unwrap();
        assert!(!worker.verify_secret(&ref_).await.unwrap());
    }

    #[tokio::test]
    async fn test_secret_cleanup() {
        let config = WorkerConfig::default();
        let worker = SessionWorker::new(config);

        // Store multiple secrets
        let _ref1 = worker.store_secret("secret1".to_string(), 15).await.unwrap();
        let _ref2 = worker.store_secret("secret2".to_string(), -1).await.unwrap(); // Expired

        // Cleanup should remove expired ones
        let removed = worker.cleanup_secrets().await.unwrap();
        assert!(removed >= 1);
    }
}
