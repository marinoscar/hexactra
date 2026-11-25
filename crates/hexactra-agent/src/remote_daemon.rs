//! Host agent daemon in attach mode (#177).
//!
//! Registers with the control plane, long-polls for operations and runs each
//! one in the operator's own Chrome through the [`BrowserBridge`]. Chrome is
//! not launched here: the Hexactra extension, installed in the operator's
//! normal profile, connects to the bridge through the native messaging host.

use std::future::Future;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, Result};
use hexactra_client::{ClientError, HostClient, HostPollStatus};
use hexactra_core::remote::{
    DispatchedCommand, DispatchedOperation, HostCommand, HostWork, OperationResult,
    ProfileStatusReport, RegisterHostRequest, DEFAULT_PROFILE,
};
use tracing::Instrument;
use uuid::Uuid;

use crate::browser_bridge::BrowserBridge;
use crate::desktop_tunnel::DesktopBridge;
use crate::pool::{BrowserPool, PoolConfig};
use crate::signin::{SigninCheck, SigninTracker};

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
    /// How this host runs its browsers (reported to the control plane).
    pub mode: Option<hexactra_core::remote::HostMode>,
    /// The local desktop server the fabric may relay to (#338).
    pub desktop: Option<crate::desktop::DesktopTarget>,
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
            mode: cfg.mode,
            desktop: cfg.desktop.is_some(),
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
        navigation_blocked: Vec::new(),
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

/// Send one sign-in report. Returns whether it was accepted. The body holds
/// account emails, so only the profile count and the HTTP status are
/// logged; a failure is logged once per streak (`was_failing`).
async fn send_signin_report(
    client: &HostClient,
    host_id: Uuid,
    report: &ProfileStatusReport,
    was_failing: bool,
) -> bool {
    let profiles = report.profiles.len();
    let status = match tokio::time::timeout(
        Duration::from_secs(10),
        client.report_profile_status(host_id, report),
    )
    .await
    {
        Ok(Ok(())) => {
            tracing::debug!(profiles, "reported profile sign-in status");
            return true;
        }
        Ok(Err(e)) => e.status(),
        Err(_) => None,
    };
    if was_failing {
        tracing::debug!(profiles, status = ?status, "reporting profile sign-in status failed again");
    } else {
        tracing::warn!(profiles, status = ?status, "reporting profile sign-in status failed; will retry");
    }
    false
}

/// Report the profiles' sign-in status (E48, #928): whenever a check
/// changes a status, and with the cached status at least every `every` (a
/// poll cycle). `tick` runs the checks that are due and returns the
/// report. Runs beside the poll loop, so a slow or failing report never
/// delays polling.
async fn signin_reporter<F, Fut>(
    client: HostClient,
    current: CurrentHost,
    tracker: Arc<SigninTracker>,
    every: Duration,
    mut tick: F,
) where
    F: FnMut() -> Fut,
    Fut: Future<Output = ProfileStatusReport>,
{
    let mut failing = false;
    loop {
        let report = tick().await;
        let host_id = *current.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(host_id) = host_id {
            failing = !send_signin_report(&client, host_id, &report, failing).await;
        }
        tokio::select! {
            _ = tracker.changed() => {}
            _ = tokio::time::sleep(every) => {}
        }
    }
}

/// Attach mode's sign-in checks: the one `default` profile is the
/// operator's own Chrome, whose profile directory the agent does not know,
/// so only the extension's live check applies (offline is `unknown`).
fn spawn_attach_signin(
    bridge: &BrowserBridge,
    client: &HostClient,
    current: &CurrentHost,
    every: Duration,
) {
    let tracker = Arc::new(SigninTracker::new());
    {
        let tracker = tracker.clone();
        bridge.on_signin(Arc::new(move |c| tracker.set_live(DEFAULT_PROFILE, c)));
    }
    let bridge = bridge.clone();
    let t = tracker.clone();
    tokio::spawn(signin_reporter(
        client.clone(),
        current.clone(),
        tracker,
        every,
        move || {
            let bridge = bridge.clone();
            let t = t.clone();
            async move {
                let profiles = vec![DEFAULT_PROFILE.to_string()];
                let running = if bridge.is_connected() {
                    profiles.clone()
                } else {
                    vec![]
                };
                let now = tokio::time::Instant::now();
                let work = t.observe(&profiles, &running, now);
                for name in &work.offline {
                    t.browser_stopped(name);
                    t.set_offline(name, SigninCheck::unknown());
                }
                for name in &work.live {
                    if bridge.request_signin_check().await {
                        t.asked(name, now);
                    }
                }
                t.report(&profiles, &running)
            }
        },
    ));
}

/// Handles [`HostCommand::OpenDesktop`] in either mode: connects the local
/// desktop to the fabric, reporting `desktop_unavailable`, `desktop_busy`,
/// `vnc_unavailable` or `tunnel_failed` when it cannot.
fn spawn_open_desktop(
    desktop: &DesktopBridge,
    client: &HostClient,
    host_id: Uuid,
    command: DispatchedCommand,
) {
    let HostCommand::OpenDesktop {
        tunnel_id,
        actor_display_name,
        ..
    } = command.command
    else {
        return;
    };
    let desktop = desktop.clone();
    let client = client.clone();
    tokio::spawn(async move {
        let result = match desktop
            .open_for(host_id, tunnel_id, actor_display_name.as_deref())
            .await
        {
            Ok(()) => OperationResult {
                navigation_blocked: Vec::new(),
                ok: true,
                result: Some(serde_json::json!({ "tunnel_id": tunnel_id })),
                error: None,
            },
            Err(e) => {
                tracing::warn!(%tunnel_id, error = %e, "could not open the desktop");
                failure(e.to_string())
            }
        };
        report_command(&client, host_id, command.id, &result).await;
    });
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
    let desktop = DesktopBridge::new(cfg.desktop.clone(), &cfg.control_url, &cfg.token);
    let mut host_id = register(&client, &cfg, load_host_id(&cfg.host_id_file)).await;
    set_current(&current, host_id);
    spawn_attach_signin(&bridge, &client, &current, cfg.poll_wait);
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
            Ok(Some(HostWork::Command { command }))
                if matches!(command.command, HostCommand::OpenDesktop { .. }) =>
            {
                backoff = Duration::from_secs(1);
                spawn_open_desktop(&desktop, &client, host_id, command);
            }
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
                    let result = if op.action.is_desktop() && !op.allowed_domains.is_empty() {
                        failure(crate::pool::DESKTOP_REFUSED)
                    } else if op.action.is_desktop() {
                        // The node's OS desktop (#366): the agent drives it itself,
                        // in attach mode (attended nodes) as in launch mode.
                        let left = (op.deadline - chrono::Utc::now())
                            .to_std()
                            .unwrap_or(Duration::ZERO)
                            .max(Duration::from_secs(1));
                        hexactra_desktop_input::xdotool::execute(&op.action, left).await
                    } else if op.profile != DEFAULT_PROFILE {
                        failure(format!(
                            "this host attaches to one browser (profile {DEFAULT_PROFILE:?}); profile {:?} is not available here",
                            op.profile
                        ))
                    } else {
                        bridge
                            .execute_in(op.id, &op.action, op.deadline, &op.allowed_domains)
                            .await
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
    let desktop = DesktopBridge::new(cfg.desktop.clone(), &cfg.control_url, &cfg.token);
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
    {
        // Every profile's offline check runs on the first round (agent start).
        let pool = pool.clone();
        tokio::spawn(signin_reporter(
            client.clone(),
            current.clone(),
            pool.signin().clone(),
            cfg.poll_wait.min(Duration::from_secs(10)),
            move || {
                let pool = pool.clone();
                async move { pool.signin_tick().await }
            },
        ));
    }
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
            Ok(Some(HostWork::Command { command }))
                if matches!(command.command, HostCommand::OpenDesktop { .. }) =>
            {
                backoff = Duration::from_secs(1);
                spawn_open_desktop(&desktop, &client, host_id, command);
            }
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
                        .execute_in(&op.profile, op.id, &op.action, op.deadline, &op.allowed_domains)
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

#[cfg(test)]
mod tests {
    use super::*;
    use hexactra_core::bridge::{read_frame, write_frame};
    use hexactra_core::remote::SigninState;
    use serde_json::{json, Value};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::{TcpListener, UnixStream};
    use tokio::sync::mpsc;

    /// A control plane that records every request's path and JSON body and
    /// answers `status`.
    async fn fake_control(status: u16) -> (String, mpsc::UnboundedReceiver<(String, Value)>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let (tx, rx) = mpsc::unbounded_channel();
        tokio::spawn(async move {
            loop {
                let Ok((mut s, _)) = listener.accept().await else {
                    return;
                };
                let tx = tx.clone();
                tokio::spawn(async move {
                    let mut buf = Vec::new();
                    let mut chunk = [0u8; 4096];
                    loop {
                        let head_end = buf.windows(4).position(|w| w == b"\r\n\r\n");
                        if let Some(end) = head_end {
                            let head = String::from_utf8_lossy(&buf[..end]).to_string();
                            let len: usize = head
                                .lines()
                                .find_map(|l| {
                                    let (k, v) = l.split_once(':')?;
                                    k.eq_ignore_ascii_case("content-length")
                                        .then(|| v.trim().parse().ok())?
                                })
                                .unwrap_or(0);
                            if buf.len() >= end + 4 + len {
                                let path = head
                                    .lines()
                                    .next()
                                    .and_then(|l| l.split(' ').nth(1))
                                    .unwrap_or("")
                                    .to_string();
                                let body = serde_json::from_slice(&buf[end + 4..end + 4 + len])
                                    .unwrap_or(Value::Null);
                                let _ = tx.send((path, body));
                                let reply = format!(
                                    "HTTP/1.1 {status} X\r\ncontent-type: application/json\r\ncontent-length: 2\r\nconnection: close\r\n\r\n{{}}"
                                );
                                let _ = s.write_all(reply.as_bytes()).await;
                                return;
                            }
                        }
                        match s.read(&mut chunk).await {
                            Ok(0) | Err(_) => return,
                            Ok(n) => buf.extend_from_slice(&chunk[..n]),
                        }
                    }
                });
            }
        });
        (url, rx)
    }

    async fn next_report(rx: &mut mpsc::UnboundedReceiver<(String, Value)>) -> (String, Value) {
        tokio::time::timeout(Duration::from_secs(10), rx.recv())
            .await
            .expect("no report reached the control plane")
            .unwrap()
    }

    #[tokio::test]
    async fn the_extensions_status_reaches_the_agent_and_is_reported() {
        let (url, mut reports) = fake_control(204).await;
        let client = HostClient::new(&url, "t").unwrap();
        let host = Uuid::new_v4();
        let current: CurrentHost = Default::default();
        set_current(&current, host);
        let dir = tempfile::tempdir().unwrap();
        let sock = dir.path().join("b.sock");
        let bridge = BrowserBridge::bind(&sock).await.unwrap();
        spawn_attach_signin(&bridge, &client, &current, Duration::from_millis(100));

        // Nothing connected yet: the default profile is unknown.
        let (path, body) = next_report(&mut reports).await;
        assert_eq!(path, format!("/v1/hosts/{host}/profile-status"));
        assert_eq!(body["profiles"][0]["name"], "default");
        assert_eq!(body["profiles"][0]["signin"], "unknown");

        // The extension connects (through the native host) and is asked to
        // check; its answer is reported at once, not on the next cycle.
        let mut ext = UnixStream::connect(&sock).await.unwrap();
        write_frame(&mut ext, br#"{"type":"hello","version":"t"}"#, 1 << 20)
            .await
            .unwrap();
        let asked = loop {
            let f = tokio::time::timeout(Duration::from_secs(10), read_frame(&mut ext, 1 << 20))
                .await
                .expect("the agent never asked for a check")
                .unwrap()
                .unwrap();
            let v: Value = serde_json::from_slice(&f).unwrap();
            if v["type"] == "check_signin" {
                break v;
            }
        };
        assert_eq!(asked, json!({"type": "check_signin"}));
        // Cached reports keep coming every cycle; wait for the live result.
        let status = json!({"type": "profile_status", "signin": "expired",
            "accounts": [{"provider": "google", "email": "owner@example.com", "state": "expired"}]});
        write_frame(&mut ext, status.to_string().as_bytes(), 1 << 20)
            .await
            .unwrap();
        loop {
            let (_, body) = next_report(&mut reports).await;
            if body["profiles"][0]["signin"] == "expired" {
                assert_eq!(
                    body["profiles"][0]["accounts"],
                    json!([{"provider": "google", "email": "owner@example.com", "state": "expired"}])
                );
                assert!(body["profiles"][0]["checked_at"].is_string());
                break;
            }
        }
    }

    #[tokio::test]
    async fn a_failing_report_does_not_stop_reporting() {
        let (url, mut reports) = fake_control(500).await;
        let client = HostClient::new(&url, "t").unwrap();
        let current: CurrentHost = Default::default();
        set_current(&current, Uuid::new_v4());
        let tracker = Arc::new(SigninTracker::new());
        let t = tracker.clone();
        tokio::spawn(signin_reporter(
            client,
            current,
            tracker,
            Duration::from_millis(50),
            move || {
                let t = t.clone();
                async move {
                    t.set_offline("default", SigninCheck::unknown());
                    t.report(&["default".to_string()], &[])
                }
            },
        ));
        // Rejected every time, and still sent again on every cycle.
        for _ in 0..3 {
            let (_, body) = next_report(&mut reports).await;
            assert_eq!(body["profiles"][0]["signin"], SigninState::Unknown.as_str());
        }
    }
}
