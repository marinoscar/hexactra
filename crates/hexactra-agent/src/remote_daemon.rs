//! Host agent daemon in attach mode (#177).
//!
//! Registers with the control plane, long-polls for operations and runs each
//! one in the operator's own Chrome through the [`BrowserBridge`]. Chrome is
//! not launched here: the Hexactra extension, installed in the operator's
//! normal profile, connects to the bridge through the native messaging host.

use std::path::PathBuf;
use std::time::Duration;

use anyhow::{Context, Result};
use hexactra_client::{ClientError, HostClient, HostPollStatus};
use hexactra_core::remote::{
    DispatchedCommand, DispatchedOperation, HostCommand, HostWork, OperationResult,
    RegisterHostRequest, DEFAULT_PROFILE,
};
use tracing::Instrument;
use uuid::Uuid;

use crate::browser_bridge::BrowserBridge;
use crate::pool::{BrowserPool, PoolConfig};

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
    /// Launch mode: the agent starts and supervises one browser per profile.
    pub launch: Option<PoolConfig>,
    /// Start the default profile's browser at startup instead of on the
    /// first operation.
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

/// Span for one operation, continuing the trace that queued it (#215).
fn op_span(op: &DispatchedOperation) -> tracing::Span {
    let span = tracing::info_span!(
        "operation.execute",
        otel.name = %format!("execute {}", op.action.kind()),
        op_id = %op.id,
        kind = op.action.kind(),
        profile = %op.profile,
    );
    hexactra_otel::set_parent_from_traceparent(&span, op.traceparent.as_deref());
    span
}

fn command_span(c: &DispatchedCommand) -> tracing::Span {
    let span = tracing::info_span!(
        "host_command.execute",
        otel.name = %format!("host command {}", c.command.kind()),
        command_id = %c.id,
        kind = c.command.kind(),
    );
    hexactra_otel::set_parent_from_traceparent(&span, c.traceparent.as_deref());
    span
}

/// Why an attach-mode host cannot run a host command.
pub fn attach_mode_refusal(command: &HostCommand) -> String {
    format!(
        "{}: this host attaches to a Chrome you run yourself, so it cannot manage profiles or browsers; run the agent in launch mode (--browser) or manage the browser on that machine",
        command.kind()
    )
}

async fn report_command(client: &HostClient, host_id: Uuid, id: Uuid, result: &OperationResult) {
    for attempt in 0..3u32 {
        match client.report_command(host_id, id, result).await {
            Ok(()) => return,
            Err(e @ ClientError::Api { .. }) => {
                tracing::warn!(error = %e, command_id = %id, "command result rejected");
                return;
            }
            Err(e) => {
                tracing::warn!(error = %e, command_id = %id, attempt, "reporting command result failed");
                tokio::time::sleep(Duration::from_millis(500 * (attempt as u64 + 1))).await;
            }
        }
    }
}

/// Run until the process is stopped.
pub async fn run(cfg: DaemonConfig) -> Result<()> {
    let client = HostClient::new(&cfg.control_url, &cfg.token).context("control plane URL")?;
    match cfg.launch.clone() {
        Some(pool_cfg) => run_launch_mode(cfg, client, pool_cfg).await,
        None => run_attach_mode(cfg, client).await,
    }
}

fn failure(msg: impl Into<String>) -> OperationResult {
    OperationResult {
        ok: false,
        result: None,
        error: Some(msg.into()),
    }
}

async fn wait_for_stop_signal() {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{signal, SignalKind};
        let mut term = signal(SignalKind::terminate()).expect("SIGTERM handler");
        tokio::select! {
            _ = term.recv() => {}
            _ = tokio::signal::ctrl_c() => {}
        }
    }
    #[cfg(not(unix))]
    let _ = tokio::signal::ctrl_c().await;
}

/// The host id this agent is registered as (for the shutdown notice).
type CurrentHost = std::sync::Arc<std::sync::Mutex<Option<Uuid>>>;

fn set_current(c: &CurrentHost, id: Uuid) {
    *c.lock().unwrap_or_else(|e| e.into_inner()) = Some(id);
}

/// Tell the control plane this host is going away, so sessions are not
/// routed to it while its last poll is still fresh.
async fn announce_offline(client: &HostClient, current: &CurrentHost) {
    let id = *current.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(id) = id {
        let _ = tokio::time::timeout(Duration::from_secs(3), client.offline(id)).await;
    }
}

/// Attach mode: one browser (the operator's own Chrome) = the `default` profile.
async fn run_attach_mode(cfg: DaemonConfig, client: HostClient) -> Result<()> {
    let current: CurrentHost = Default::default();
    {
        let client = client.clone();
        let current = current.clone();
        tokio::spawn(async move {
            wait_for_stop_signal().await;
            tracing::info!("stopping");
            announce_offline(&client, &current).await;
            hexactra_otel::shutdown();
            std::process::exit(0);
        });
    }
    let bridge = BrowserBridge::bind(&cfg.bridge_socket)
        .await
        .context("starting browser bridge")?;
    let mut host_id = register(&client, &cfg, load_host_id(&cfg.host_id_file)).await;
    set_current(&current, host_id);
    let mut backoff = Duration::from_secs(1);
    let mut was_connected = false;
    loop {
        let connected = bridge.is_connected();
        if connected != was_connected {
            tracing::info!(connected, "browser extension connection changed");
            was_connected = connected;
        }
        // Poll briefly while the extension is absent so the control plane
        // learns quickly when it connects.
        let wait = if connected {
            cfg.poll_wait
        } else {
            Duration::from_secs(2)
        };
        let status = HostPollStatus {
            browser_connected: connected,
            on_demand: false,
            accepts_commands: true,
            profiles: Some((
                vec![DEFAULT_PROFILE.to_string()],
                if connected {
                    vec![DEFAULT_PROFILE.to_string()]
                } else {
                    vec![]
                },
            )),
        };
        match client.poll(host_id, &status, wait).await {
            Ok(Some(HostWork::Command { command })) => {
                backoff = Duration::from_secs(1);
                tracing::info!(command_id = %command.id, kind = command.command.kind(), "refusing host command");
                let result = failure(attach_mode_refusal(&command.command));
                report_command(&client, host_id, command.id, &result).await;
            }
            Ok(Some(HostWork::Operation(op))) => {
                backoff = Duration::from_secs(1);
                let span = op_span(&op);
                async {
                    tracing::info!(op_id = %op.id, kind = op.action.kind(), "executing operation");
                    let result = if op.profile != DEFAULT_PROFILE {
                        failure(format!(
                            "this host attaches to one browser (profile {DEFAULT_PROFILE:?}); profile {:?} is not available here",
                            op.profile
                        ))
                    } else {
                        bridge.execute(op.id, &op.action, op.deadline).await
                    };
                    tracing::info!(op_id = %op.id, ok = result.ok, "operation finished");
                    report(&client, host_id, op.id, &result).await;
                }
                .instrument(span)
                .await;
            }
            Ok(None) => backoff = Duration::from_secs(1),
            Err(ClientError::Api { status: 404, .. }) => {
                tracing::warn!(
                    "control plane does not know this host (restarted?); re-registering"
                );
                host_id = register(&client, &cfg, Some(host_id)).await;
                set_current(&current, host_id);
            }
            Err(e) => {
                tracing::warn!(error = %e, retry_in = ?backoff, "polling failed");
                tokio::time::sleep(backoff).await;
                backoff = (backoff * 2).min(Duration::from_secs(30));
            }
        }
    }
}

/// Launch mode: a pool of browsers, one per profile, started on demand.
/// Operations run as separate tasks so profiles work in parallel.
async fn run_launch_mode(
    cfg: DaemonConfig,
    client: HostClient,
    pool_cfg: PoolConfig,
) -> Result<()> {
    let pool = BrowserPool::new(pool_cfg)?;
    let current: CurrentHost = Default::default();
    {
        // On SIGTERM/SIGINT (docker stop, reboot, Ctrl-C) close every
        // browser through its extension before exiting.
        let pool = pool.clone();
        let client = client.clone();
        let current = current.clone();
        tokio::spawn(async move {
            wait_for_stop_signal().await;
            tracing::info!("stopping: closing browsers");
            announce_offline(&client, &current).await;
            pool.shutdown().await;
            hexactra_otel::shutdown();
            std::process::exit(0);
        });
    }
    if cfg.launch_eagerly {
        if let Err(e) = pool.start(DEFAULT_PROFILE, Duration::from_secs(60)).await {
            tracing::error!(error = %e, "could not start the browser; will retry on the next operation");
        }
    }
    let mut host_id = register(&client, &cfg, load_host_id(&cfg.host_id_file)).await;
    set_current(&current, host_id);
    let mut backoff = Duration::from_secs(1);
    loop {
        let status = HostPollStatus {
            browser_connected: pool.any_connected().await,
            on_demand: true,
            accepts_commands: true,
            profiles: Some((pool.profiles(), pool.running().await)),
        };
        // Short polls keep the reported running profiles fresh.
        let wait = cfg.poll_wait.min(Duration::from_secs(10));
        match client.poll(host_id, &status, wait).await {
            Ok(Some(HostWork::Command { command })) => {
                backoff = Duration::from_secs(1);
                tracing::info!(command_id = %command.id, kind = command.command.kind(), profile = ?command.command.profile(), "running host command");
                let pool = pool.clone();
                let client = client.clone();
                let span = command_span(&command);
                tokio::spawn(async move {
                    let result = pool.run_command(&command.command, command.deadline).await;
                    tracing::info!(command_id = %command.id, ok = result.ok, error = ?result.error, "host command finished");
                    report_command(&client, host_id, command.id, &result).await;
                }.instrument(span));
            }
            Ok(Some(HostWork::Operation(op))) => {
                backoff = Duration::from_secs(1);
                tracing::info!(op_id = %op.id, kind = op.action.kind(), profile = %op.profile, "executing operation");
                let pool = pool.clone();
                let client = client.clone();
                let span = op_span(&op);
                tokio::spawn(async move {
                    let result = pool
                        .execute(&op.profile, op.id, &op.action, op.deadline)
                        .await;
                    if let Some(e) = &result.error {
                        if e.starts_with("browser unavailable") {
                            tracing::error!(error = %e, profile = %op.profile, "browser unavailable");
                        }
                    }
                    tracing::info!(op_id = %op.id, ok = result.ok, "operation finished");
                    report(&client, host_id, op.id, &result).await;
                }.instrument(span));
            }
            Ok(None) => backoff = Duration::from_secs(1),
            Err(ClientError::Api { status: 404, .. }) => {
                tracing::warn!(
                    "control plane does not know this host (restarted?); re-registering"
                );
                host_id = register(&client, &cfg, Some(host_id)).await;
                set_current(&current, host_id);
            }
            Err(e) => {
                tracing::warn!(error = %e, retry_in = ?backoff, "polling failed");
                tokio::time::sleep(backoff).await;
                backoff = (backoff * 2).min(Duration::from_secs(30));
            }
        }
    }
}
