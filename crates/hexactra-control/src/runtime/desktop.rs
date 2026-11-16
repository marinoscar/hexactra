//! Remote desktop tunnels (#338, docs/nodes.md).
//!
//! A person views a node's desktop through the console. The fabric joins two
//! WebSockets and relays the raw desktop stream (RFB) between them:
//!
//! - **client leg** `GET /v1/desktop/{tunnel_id}/connect`: the console's
//!   viewer, authenticated by a single-use `hxd_` token that lasts 30 s.
//! - **host leg** `GET /v1/hosts/{host_id}/desktop/{tunnel_id}`: the node's
//!   agent, authenticated by its own host credential, dialed after it
//!   receives the [`HostCommand::OpenDesktop`] command.
//!
//! A node opens no inbound port: both legs are outbound HTTPS connections
//! to the fabric. Tokens are stored only as hashes and never logged.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use axum::extract::ws::{CloseFrame, Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Extension, Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use base64::Engine;
use chrono::Utc;
use futures_util::{SinkExt, StreamExt};
use hexactra_core::remote::{CreateDesktopSessionRequest, DesktopSession, HostCommand};
use serde_json::json;
use sha2::{Digest, Sha256};
use tokio::sync::oneshot;
use uuid::Uuid;

use super::api::{check_host, ApiState, AppError};
use super::credentials::Principal;

/// Close codes the fabric sends on a relayed tunnel.
pub mod close {
    /// The host did not connect in time.
    pub const HOST_TIMEOUT: u16 = 4504;
    /// Nothing moved for the idle limit.
    pub const IDLE: u16 = 4408;
    /// The tunnel reached its maximum duration.
    pub const MAX_DURATION: u16 = 4000;
    /// The other leg went away.
    pub const PEER_GONE: u16 = 1000;
    /// The viewer sent something that is not RFB.
    pub const PROTOCOL: u16 = 4400;
}

/// Largest message relayed in either direction.
pub const MAX_MESSAGE: usize = 1 << 20;
const TOKEN_TTL: Duration = Duration::from_secs(30);
const HOST_WAIT: Duration = Duration::from_secs(20);
const PING_EVERY: Duration = Duration::from_secs(20);

/// Limits, from the environment (`HEXACTRA_DESKTOP_*`).
#[derive(Debug, Clone, Copy)]
pub struct Limits {
    pub per_host: usize,
    pub global: usize,
    pub idle: Duration,
    pub max: Duration,
    pub host_wait: Duration,
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            per_host: 2,
            global: 50,
            idle: Duration::from_secs(15 * 60),
            max: Duration::from_secs(60 * 60),
            host_wait: HOST_WAIT,
        }
    }
}

impl Limits {
    pub fn from_env() -> Self {
        let n = |k: &str, d: u64| {
            std::env::var(k)
                .ok()
                .and_then(|v| v.parse::<u64>().ok())
                .filter(|v| *v > 0)
                .unwrap_or(d)
        };
        let d = Self::default();
        Self {
            per_host: n("HEXACTRA_DESKTOP_MAX_PER_HOST", d.per_host as u64) as usize,
            global: n("HEXACTRA_DESKTOP_MAX", d.global as u64) as usize,
            idle: Duration::from_secs(n("HEXACTRA_DESKTOP_IDLE_S", d.idle.as_secs())),
            max: Duration::from_secs(n("HEXACTRA_DESKTOP_MAX_S", d.max.as_secs())),
            host_wait: d.host_wait,
        }
    }
}

struct Tunnel {
    host_id: Uuid,
    token_hash: [u8; 32],
    /// The host leg hands its socket over here…
    host_tx: Option<oneshot::Sender<WebSocket>>,
    /// …and the client leg (once, with the token) waits on this.
    host_rx: Option<oneshot::Receiver<WebSocket>>,
    /// The client leg has used the token.
    claimed: bool,
    /// The console user the tunnel was opened for: only they may send
    /// input, and only while they hold the takeover lease (#342).
    actor_user_id: Option<String>,
}

/// Pending and active tunnels of this fabric (in memory: a tunnel lives on
/// the replica both legs reached; docs/nodes.md notes one replica).
#[derive(Clone)]
pub struct DesktopTunnels {
    inner: Arc<Mutex<HashMap<Uuid, Tunnel>>>,
    pub limits: Limits,
}

impl Default for DesktopTunnels {
    fn default() -> Self {
        Self::new(Limits::from_env())
    }
}

impl DesktopTunnels {
    pub fn new(limits: Limits) -> Self {
        Self {
            inner: Default::default(),
            limits,
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<Uuid, Tunnel>> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Tunnels for a host (pending or active).
    pub fn count(&self, host_id: Option<Uuid>) -> usize {
        self.lock()
            .values()
            .filter(|t| host_id.is_none_or(|h| t.host_id == h))
            .count()
    }

    fn remove(&self, id: Uuid) {
        self.lock().remove(&id);
    }
}

fn hash(token: &str) -> [u8; 32] {
    Sha256::digest(token.as_bytes()).into()
}

fn constant_eq(a: &[u8; 32], b: &[u8; 32]) -> bool {
    a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

fn new_token() -> String {
    use rand::RngCore;
    let mut b = [0u8; 32];
    rand::rngs::OsRng.fill_bytes(&mut b);
    format!(
        "hxd_{}",
        base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(b)
    )
}

fn err(status: StatusCode, code: &'static str, msg: impl Into<String>) -> AppError {
    AppError(status, code, msg.into())
}

/// `POST /v1/hosts/{id}/desktop-sessions`: reserve a tunnel, ask the host to
/// connect its desktop, return the single-use connect token.
#[utoipa::path(
    post,
    path = "/v1/hosts/{id}/desktop-sessions",
    tag = "desktop",
    params(("id" = Uuid, Path, description = "Host id")),
    request_body = CreateDesktopSessionRequest,
    responses(
        (status = 201, body = DesktopSession, description = "Connect within 30 seconds with the token"),
        (status = 404, description = "Unknown host"),
        (status = 409, description = "host_offline or desktop_unavailable"),
        (status = 429, description = "Too many open desktops"),
        (status = 401, description = "Missing or invalid token"),
        (status = 403, description = "Token not allowed here")
    )
)]
pub(super) async fn create_desktop_session(
    State(s): State<ApiState>,
    Path(host_id): Path<Uuid>,
    body: Option<Json<CreateDesktopSessionRequest>>,
) -> Result<Response, AppError> {
    let req = body.map(|Json(b)| b).unwrap_or_default();
    let host = s
        .store
        .list_hosts()
        .into_iter()
        .find(|h| h.id == host_id)
        .ok_or_else(|| err(StatusCode::NOT_FOUND, "not_found", "unknown host"))?;
    if !host.online {
        return Err(err(
            StatusCode::CONFLICT,
            "host_offline",
            format!(
                "host {} is offline (last seen {})",
                host.name, host.last_seen
            ),
        ));
    }
    if !host.desktop {
        return Err(err(
            StatusCode::CONFLICT,
            "desktop_unavailable",
            format!("host {} has no desktop to share", host.name),
        ));
    }
    let t = &s.desktop;
    let token = new_token();
    let tunnel_id = Uuid::new_v4();
    let expires_at = Utc::now() + chrono::Duration::from_std(TOKEN_TTL).expect("30 s");
    {
        let mut inner = t.lock();
        if inner.len() >= t.limits.global {
            return Err(err(
                StatusCode::TOO_MANY_REQUESTS,
                "too_many_desktops",
                "too many open desktops on this fabric",
            ));
        }
        if inner.values().filter(|x| x.host_id == host_id).count() >= t.limits.per_host {
            return Err(err(
                StatusCode::TOO_MANY_REQUESTS,
                "too_many_desktops",
                format!(
                    "host {} already has {} open desktops",
                    host.name, t.limits.per_host
                ),
            ));
        }
        let (tx, rx) = oneshot::channel();
        inner.insert(
            tunnel_id,
            Tunnel {
                host_id,
                token_hash: hash(&token),
                host_tx: Some(tx),
                host_rx: Some(rx),
                claimed: false,
                actor_user_id: req.actor.user_id.clone(),
            },
        );
    }
    let command = HostCommand::OpenDesktop {
        tunnel_id,
        expires_at,
        actor_display_name: req.actor.display_name.clone(),
    };
    if let Err(e) = s.store.enqueue_host_command(host_id, command, TOKEN_TTL) {
        t.remove(tunnel_id);
        return Err(e.into());
    }
    // An unclaimed tunnel expires with its token.
    {
        let t = t.clone();
        tokio::spawn(async move {
            tokio::time::sleep(TOKEN_TTL).await;
            let mut inner = t.lock();
            if inner.get(&tunnel_id).is_some_and(|x| !x.claimed) {
                inner.remove(&tunnel_id);
                drop(inner);
                super::metrics::desktop_failure("token_expired");
            }
        });
    }
    s.store.log.emit(
        "desktop.requested",
        json!({ "tunnel_id": tunnel_id, "host_id": host_id, "actor": req.actor }),
    );
    tracing::info!(%tunnel_id, %host_id, "desktop tunnel requested");
    Ok((
        StatusCode::CREATED,
        Json(DesktopSession {
            tunnel_id,
            host_id,
            connect_token: token,
            expires_at,
        }),
    )
        .into_response())
}

/// `GET /v1/desktop/{tunnel_id}/connect` (WebSocket): the viewer's leg.
#[utoipa::path(
    get,
    path = "/v1/desktop/{tunnel_id}/connect",
    tag = "desktop",
    security(),
    params(("tunnel_id" = Uuid, Path, description = "Tunnel id from POST /v1/hosts/{id}/desktop-sessions")),
    responses(
        (status = 101, description = "WebSocket upgrade: binary messages carry the desktop stream (RFB). `Authorization: Bearer hxd_…` (single use, 30 s). Close codes: 4504 the node did not connect, 4408 idle, 4000 maximum duration"),
        (status = 401, description = "Missing, invalid, used or expired desktop token")
    )
)]
pub(super) async fn client_connect(
    State(s): State<ApiState>,
    Path(tunnel_id): Path<Uuid>,
    headers: HeaderMap,
    ws: WebSocketUpgrade,
) -> Result<Response, AppError> {
    let presented = headers
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .map(str::trim)
        .filter(|v| v.starts_with("hxd_"))
        .ok_or_else(|| {
            err(
                StatusCode::UNAUTHORIZED,
                "unauthorized",
                "a desktop connect token is required",
            )
        })?;
    let presented = hash(presented);
    let (host_id, rx, actor) = {
        let mut inner = s.desktop.lock();
        let t = inner
            .get_mut(&tunnel_id)
            .filter(|t| constant_eq(&t.token_hash, &presented) && !t.claimed)
            .ok_or_else(|| {
                err(
                    StatusCode::UNAUTHORIZED,
                    "unauthorized",
                    "invalid, used or expired desktop token",
                )
            })?;
        t.claimed = true;
        (
            t.host_id,
            t.host_rx.take().expect("unclaimed tunnel has its receiver"),
            t.actor_user_id.clone(),
        )
    };
    let state = s.clone();
    Ok(ws
        .max_message_size(MAX_MESSAGE)
        .max_frame_size(MAX_MESSAGE)
        .on_upgrade(move |mut client| async move {
            let wait = state.desktop.limits.host_wait;
            match tokio::time::timeout(wait, rx).await {
                Ok(Ok(host)) => relay(state, tunnel_id, host_id, actor, client, host).await,
                _ => {
                    state.desktop.remove(tunnel_id);
                    super::metrics::desktop_failure("host_timeout");
                    tracing::warn!(%tunnel_id, %host_id, "the host did not connect its desktop in time");
                    let _ = client
                        .send(close_msg(close::HOST_TIMEOUT, "the node did not connect its desktop"))
                        .await;
                }
            }
        }))
}

/// `GET /v1/hosts/{host_id}/desktop/{tunnel_id}` (WebSocket): the node's leg.
#[utoipa::path(
    get,
    path = "/v1/hosts/{host_id}/desktop/{tunnel_id}",
    tag = "agent",
    params(
        ("host_id" = Uuid, Path, description = "This host's id"),
        ("tunnel_id" = Uuid, Path, description = "From the open_desktop host command")
    ),
    responses(
        (status = 101, description = "WebSocket upgrade: the agent relays its local desktop server's bytes as binary messages"),
        (status = 401, description = "Missing or invalid host credential"),
        (status = 403, description = "This credential belongs to another host"),
        (status = 404, description = "No such tunnel for this host"),
        (status = 409, description = "The tunnel already has its host")
    )
)]
pub(super) async fn host_connect(
    State(s): State<ApiState>,
    Extension(p): Extension<Principal>,
    Path((host_id, tunnel_id)): Path<(Uuid, Uuid)>,
    ws: WebSocketUpgrade,
) -> Result<Response, AppError> {
    check_host(p, host_id)?;
    let tx = {
        let mut inner = s.desktop.lock();
        let t = inner
            .get_mut(&tunnel_id)
            .filter(|t| t.host_id == host_id)
            .ok_or_else(|| {
                err(
                    StatusCode::NOT_FOUND,
                    "not_found",
                    "no such desktop tunnel for this host",
                )
            })?;
        t.host_tx.take().ok_or_else(|| {
            err(
                StatusCode::CONFLICT,
                "conflict",
                "this tunnel already has its host",
            )
        })?
    };
    Ok(ws
        .max_message_size(MAX_MESSAGE)
        .max_frame_size(MAX_MESSAGE)
        .on_upgrade(move |socket| async move {
            // The viewer's leg owns the relay; if it is gone, the socket closes here.
            if let Err(mut socket) = tx.send(socket) {
                let _ = socket
                    .send(close_msg(close::HOST_TIMEOUT, "the viewer is gone"))
                    .await;
            }
        }))
}

fn close_msg(code: u16, reason: &'static str) -> Message {
    Message::Close(Some(CloseFrame {
        code,
        reason: reason.into(),
    }))
}

/// Relays binary messages both ways until either side closes, nothing moves
/// for the idle limit, or the tunnel reaches its maximum duration.
async fn relay(
    s: ApiState,
    tunnel_id: Uuid,
    host_id: Uuid,
    actor: Option<String>,
    client: WebSocket,
    host: WebSocket,
) {
    let mut filter = super::takeover::RfbInputFilter::default();
    let may_input = |s: &ApiState| {
        actor
            .as_deref()
            .is_some_and(|a| s.store.takeover_holder(host_id).as_deref() == Some(a))
    };
    let started = Instant::now();
    let limits = s.desktop.limits;
    s.store.log.emit(
        "desktop.opened",
        json!({ "tunnel_id": tunnel_id, "host_id": host_id }),
    );
    super::metrics::desktop_opened();
    tracing::info!(%tunnel_id, %host_id, "desktop tunnel open");

    let (mut c_tx, mut c_rx) = client.split();
    let (mut h_tx, mut h_rx) = host.split();
    let (mut up, mut down) = (0u64, 0u64);
    let mut last = Instant::now();
    let mut ping = tokio::time::interval(PING_EVERY);
    ping.tick().await;
    let deadline = tokio::time::sleep(limits.max);
    tokio::pin!(deadline);

    let reason: &'static str = loop {
        let idle = tokio::time::sleep_until((last + limits.idle).into());
        tokio::select! {
            m = c_rx.next() => match m {
                Some(Ok(Message::Binary(b))) => {
                    up += b.len() as u64;
                    last = Instant::now();
                    // Watching is the default: input passes only with the lease.
                    match filter.feed(&b, may_input(&s)) {
                        Ok(pass) if pass.is_empty() => {}
                        Ok(pass) => {
                            if h_tx.send(Message::Binary(pass.into())).await.is_err() { break "host_closed"; }
                        }
                        Err(e) => {
                            tracing::warn!(%tunnel_id, error = %e, "closing a desktop tunnel: unexpected viewer message");
                            break "protocol_error";
                        }
                    }
                }
                Some(Ok(Message::Close(_))) | None | Some(Err(_)) => break "viewer_closed",
                Some(Ok(_)) => {}
            },
            m = h_rx.next() => match m {
                Some(Ok(Message::Binary(b))) => {
                    down += b.len() as u64;
                    last = Instant::now();
                    if c_tx.send(Message::Binary(b)).await.is_err() { break "viewer_closed"; }
                }
                Some(Ok(Message::Close(_))) | None | Some(Err(_)) => break "host_closed",
                Some(Ok(_)) => {}
            },
            _ = idle => break "idle",
            _ = &mut deadline => break "max_duration",
            _ = ping.tick() => {
                let _ = c_tx.send(Message::Ping(Default::default())).await;
                let _ = h_tx.send(Message::Ping(Default::default())).await;
            }
        }
    };
    let (code, text) = match reason {
        "idle" => (close::IDLE, "idle"),
        "max_duration" => (close::MAX_DURATION, "maximum duration reached"),
        "protocol_error" => (close::PROTOCOL, "unexpected viewer message"),
        _ => (close::PEER_GONE, "closed"),
    };
    let _ = c_tx.send(close_msg(code, text)).await;
    let _ = h_tx.send(close_msg(code, text)).await;
    s.desktop.remove(tunnel_id);
    let duration_ms = started.elapsed().as_millis() as u64;
    super::metrics::desktop_closed(reason, up, down, started.elapsed().as_secs_f64());
    s.store.log.emit(
        "desktop.closed",
        json!({
            "tunnel_id": tunnel_id,
            "host_id": host_id,
            "reason": reason,
            "bytes_up": up,
            "bytes_down": down,
            "duration_ms": duration_ms,
        }),
    );
    tracing::info!(%tunnel_id, %host_id, reason, bytes_up = up, bytes_down = down, duration_ms, "desktop tunnel closed");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tokens_are_random_prefixed_and_compared_in_constant_time() {
        let a = new_token();
        let b = new_token();
        assert!(a.starts_with("hxd_") && a.len() == 4 + 43);
        assert_ne!(a, b);
        assert!(constant_eq(&hash(&a), &hash(&a)));
        assert!(!constant_eq(&hash(&a), &hash(&b)));
    }

    #[test]
    fn limits_default() {
        let l = Limits::default();
        assert_eq!((l.per_host, l.global), (2, 50));
        assert_eq!(l.idle, Duration::from_secs(900));
    }
}
