//! Session worker for Hexactra

use anyhow::Result;
use hexactra_core::{BrowserAction, GoalId, SessionId};
use tokio::sync::mpsc;

/// Worker configuration
#[derive(Debug, Clone)]
pub struct WorkerConfig {
    pub session_id: SessionId,
}

/// Session worker that executes browser actions
pub struct SessionWorker {
    config: WorkerConfig,
    action_tx: Option<mpsc::Sender<BrowserAction>>,
}

impl SessionWorker {
    pub fn new(config: WorkerConfig) -> Self {
        Self {
            config,
            action_tx: None,
        }
    }

    /// Start the worker
    pub async fn start(&mut self) -> Result<()> {
        tracing::info!("Starting worker for session: {:?}", self.config.session_id);
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
}
