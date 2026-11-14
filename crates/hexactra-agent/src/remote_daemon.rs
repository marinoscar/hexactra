//! Host agent daemon in attach mode (#177).
//!
//! Registers with the control plane, long-polls for operations and runs each
//! one in the operator's own Chrome through the [`BrowserBridge`]. Chrome is
//! not launched here: the Hexactra extension, installed in the operator's
//! normal profile, connects to the bridge through the native messaging host.

use std::path::PathBuf;
use std::time::Duration;

use anyhow::{Context, Result};
use hexactra_client::{ClientError, HostClient};
use hexactra_core::remote::{OperationResult, RegisterHostRequest};
use uuid::Uuid;

use crate::browser_bridge::BrowserBridge;
use crate::launcher::{BrowserLauncher, LaunchConfig};

/// Daemon configuration.
#[derive(Debug, Clone)]
pub struct DaemonConfig {
    /// Control plane base URL, e.g. `http://127.0.0.1:8787`.
    pub control_url: String,
    /// Bearer token.
    pub token: String,
    /// Display name for this host.
    pub host_name: String,
    /// File that persists this host's id across restarts.
    pub host_id_file: Option<PathBuf>,
    /// Bridge socket path.
    pub bridge_socket: PathBuf,
    /// Long-poll duration.
    pub poll_wait: Duration,
    /// Launch mode: the agent starts and supervises the browser itself.
    pub launch: Option<LaunchConfig>,
    /// Start the browser at startup instead of on the first operation.
    pub launch_eagerly: bool,
    /// Web viewer URL for this host's browser (reported to the control plane).
    pub viewer_url: Option<String>,
}

fn load_host_id(file: &Option<PathBuf>) -> Option<Uuid> {
    let f = file.as_ref()?;
    std::fs::read_to_string(f).ok()?.trim().parse().ok()
}

fn save_host_id(file: &Option<PathBuf>, id: Uuid) {
    if let Some(f) = file {
        if let Some(dir) = f.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        if let Err(e) = std::fs::write(f, format!("{id}\n")) {
            tracing::warn!(error = %e, file = %f.display(), "could not persist host id");
        }
    }
}

async fn register(client: &HostClient, cfg: &DaemonConfig, previous: Option<Uuid>) -> Uuid {
    let mut backoff = Duration::from_secs(1);
    loop {
        let req = RegisterHostRequest {
            name: cfg.host_name.clone(),
            version: env!("CARGO_PKG_VERSION").to_string(),
            host_id: previous,
            viewer_url: cfg.viewer_url.clone(),
        };
        match client.register(&req).await {
            Ok(r) => {
                save_host_id(&cfg.host_id_file, r.host_id);
                tracing::info!(host_id = %r.host_id, url = %cfg.control_url, "registered with control plane");
                return r.host_id;
            }
            Err(e) => {
                tracing::warn!(error = %e, retry_in = ?backoff, "registration failed");
                tokio::time::sleep(backoff).await;
                backoff = (backoff * 2).min(Duration::from_secs(30));
            }
        }
    }
}

async fn report(client: &HostClient, host_id: Uuid, op_id: Uuid, result: &OperationResult) {
    for attempt in 0..3u32 {
        match client.report(host_id, op_id, result).await {
            Ok(()) => return,
            // 404/409: the control plane no longer wants this result.
            Err(e @ ClientError::Api { .. }) => {
                tracing::warn!(error = %e, %op_id, "result rejected");
                return;
            }
            Err(e) => {
                tracing::warn!(error = %e, %op_id, attempt, "reporting result failed");
                tokio::time::sleep(Duration::from_millis(500 * (attempt as u64 + 1))).await;
            }
        }
    }
}

/// Run until the process is stopped.
pub async fn run(cfg: DaemonConfig) -> Result<()> {
    let bridge = BrowserBridge::bind(&cfg.bridge_socket)
        .await
        .context("starting browser bridge")?;
    let client = HostClient::new(&cfg.control_url, &cfg.token).context("control plane URL")?;

    let launcher = cfg
        .launch
        .clone()
        .map(|l| BrowserLauncher::new(l, bridge.clone()));
    if let Some(l) = &launcher {
        l.spawn_idle_watcher();
        if cfg.launch_eagerly {
            if let Err(e) = l.ensure_running().await {
                tracing::error!(error = %e, "could not start the browser; will retry on the next operation");
            }
        }
    }

    let mut host_id = register(&client, &cfg, load_host_id(&cfg.host_id_file)).await;
    let mut backoff = Duration::from_secs(1);
    let mut was_connected = false;
    loop {
        let connected = bridge.is_connected();
        let on_demand = launcher.is_some();
        if connected != was_connected {
            tracing::info!(connected, "browser extension connection changed");
            was_connected = connected;
        }
        // Poll briefly while the extension is absent so the control plane
        // learns quickly when it connects.
        let wait = if connected || on_demand {
            cfg.poll_wait
        } else {
            Duration::from_secs(2)
        };
        match client.next_with(host_id, connected, on_demand, wait).await {
            Ok(Some(op)) => {
                backoff = Duration::from_secs(1);
                tracing::info!(op_id = %op.id, kind = op.action.kind(), "executing operation");
                let result = match &launcher {
                    Some(l) => match l.ensure_running().await {
                        Ok(()) => {
                            let r = bridge.execute(op.id, &op.action, op.deadline).await;
                            l.touch().await;
                            r
                        }
                        Err(e) => {
                            tracing::error!(error = %e, "browser unavailable");
                            hexactra_core::remote::OperationResult {
                                ok: false,
                                result: None,
                                error: Some(format!("browser unavailable: {e:#}")),
                            }
                        }
                    },
                    None => bridge.execute(op.id, &op.action, op.deadline).await,
                };
                tracing::info!(op_id = %op.id, ok = result.ok, "operation finished");
                report(&client, host_id, op.id, &result).await;
            }
            Ok(None) => backoff = Duration::from_secs(1),
            Err(ClientError::Api { status: 404, .. }) => {
                tracing::warn!(
                    "control plane does not know this host (restarted?); re-registering"
                );
                host_id = register(&client, &cfg, Some(host_id)).await;
            }
            Err(e) => {
                tracing::warn!(error = %e, retry_in = ?backoff, "polling failed");
                tokio::time::sleep(backoff).await;
                backoff = (backoff * 2).min(Duration::from_secs(30));
            }
        }
    }
}
