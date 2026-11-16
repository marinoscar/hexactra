//! Takeover (#342, docs/nodes.md): a person takes control of a host's
//! desktop, and the agent pauses.
//!
//! - One lease per host (the whole desktop), held by one person, for at most
//!   10 minutes at a time and renewed while they watch.
//! - While it is held, new browser actions on that host answer
//!   `409 takeover_active` (an agent waits and retries); an action already
//!   running finishes.
//! - Watching is the default: on a desktop tunnel the fabric parses the
//!   viewer's RFB stream and drops keyboard, pointer and clipboard messages
//!   unless that viewer holds the lease.

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::json;
use uuid::Uuid;

use super::api::{ApiState, AppError};
use super::store::{RuntimeStore, StoreError};

pub const DEFAULT_TTL_S: u64 = 300;
pub const MAX_TTL_S: u64 = 600;

/// Who holds a lease.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, utoipa::ToSchema)]
pub struct TakeoverActor {
    /// The console user; a desktop tunnel opened for the same user may send input.
    pub user_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, utoipa::ToSchema)]
pub struct Lease {
    pub lease_id: Uuid,
    pub host_id: Uuid,
    pub actor: TakeoverActor,
    pub started_at: DateTime<Utc>,
    pub expires_at: DateTime<Utc>,
}

/// `POST /v1/hosts/{id}/takeover`
#[derive(Debug, Clone, Deserialize, utoipa::ToSchema)]
pub struct TakeoverRequest {
    pub actor: TakeoverActor,
    #[serde(default)]
    pub ttl_s: Option<u64>,
}

/// `POST /v1/hosts/{id}/takeover/{lease_id}/renew`
#[derive(Debug, Clone, Default, Deserialize, utoipa::ToSchema)]
pub struct RenewRequest {
    #[serde(default)]
    pub ttl_s: Option<u64>,
}

fn ttl(s: Option<u64>) -> chrono::Duration {
    chrono::Duration::seconds(s.unwrap_or(DEFAULT_TTL_S).clamp(10, MAX_TTL_S) as i64)
}

impl RuntimeStore {
    /// Takes (or, for the same person, extends) the host's lease.
    pub fn take_over(
        &self,
        host_id: Uuid,
        actor: TakeoverActor,
        ttl_s: Option<u64>,
    ) -> Result<Lease, StoreError> {
        if actor.user_id.trim().is_empty() || actor.user_id.len() > 128 {
            return Err(StoreError::Invalid("actor.user_id is required".into()));
        }
        let now = Utc::now();
        let mut inner = self.lock();
        let host = inner
            .hosts
            .get_mut(&host_id)
            .ok_or(StoreError::NotFound("host"))?;
        if let Some(l) = host.takeover.as_ref().filter(|l| l.expires_at > now) {
            if l.actor.user_id != actor.user_id {
                return Err(StoreError::TakeoverHeld(
                    l.actor
                        .display_name
                        .clone()
                        .unwrap_or_else(|| "someone else".into()),
                ));
            }
        }
        let lease = Lease {
            lease_id: host
                .takeover
                .as_ref()
                .filter(|l| l.expires_at > now && l.actor.user_id == actor.user_id)
                .map(|l| l.lease_id)
                .unwrap_or_else(Uuid::new_v4),
            host_id,
            actor,
            started_at: now,
            expires_at: now + ttl(ttl_s),
        };
        host.takeover = Some(lease.clone());
        drop(inner);
        self.log.emit("takeover.started", json!(lease));
        tracing::info!(%host_id, lease_id = %lease.lease_id, "takeover started");
        Ok(lease)
    }

    pub fn renew_takeover(
        &self,
        host_id: Uuid,
        lease_id: Uuid,
        ttl_s: Option<u64>,
    ) -> Result<Lease, StoreError> {
        let now = Utc::now();
        let mut inner = self.lock();
        let host = inner
            .hosts
            .get_mut(&host_id)
            .ok_or(StoreError::NotFound("host"))?;
        let l = host
            .takeover
            .as_mut()
            .filter(|l| l.lease_id == lease_id && l.expires_at > now)
            .ok_or(StoreError::NotFound("takeover lease"))?;
        l.expires_at = now + ttl(ttl_s);
        let lease = l.clone();
        drop(inner);
        self.log.emit("takeover.renewed", json!(lease));
        Ok(lease)
    }

    pub fn release_takeover(&self, host_id: Uuid, lease_id: Uuid) -> Result<(), StoreError> {
        let mut inner = self.lock();
        let host = inner
            .hosts
            .get_mut(&host_id)
            .ok_or(StoreError::NotFound("host"))?;
        match host.takeover.take() {
            Some(l) if l.lease_id == lease_id => {
                drop(inner);
                self.log.emit(
                    "takeover.released",
                    json!({ "host_id": host_id, "lease_id": lease_id, "reason": "released" }),
                );
                tracing::info!(%host_id, %lease_id, "takeover released");
                Ok(())
            }
            other => {
                host.takeover = other;
                Err(StoreError::NotFound("takeover lease"))
            }
        }
    }

    /// The user holding the host's live lease, if any.
    pub fn takeover_holder(&self, host_id: Uuid) -> Option<String> {
        let inner = self.lock();
        inner
            .hosts
            .get(&host_id)?
            .takeover
            .as_ref()
            .filter(|l| l.expires_at > Utc::now())
            .map(|l| l.actor.user_id.clone())
    }

    /// The host's live lease, if any.
    pub fn takeover(&self, host_id: Uuid) -> Option<Lease> {
        let inner = self.lock();
        inner
            .hosts
            .get(&host_id)?
            .takeover
            .clone()
            .filter(|l| l.expires_at > Utc::now())
    }
}

/// `POST /v1/hosts/{id}/takeover`
#[utoipa::path(
    post,
    path = "/v1/hosts/{id}/takeover",
    tag = "desktop",
    params(("id" = Uuid, Path, description = "Host id")),
    request_body = TakeoverRequest,
    responses(
        (status = 201, body = Lease, description = "The person controls the desktop; new actions on this host answer 409 takeover_active"),
        (status = 404, description = "Unknown host"),
        (status = 409, description = "takeover_held: someone else controls it"),
        (status = 401, description = "Missing or invalid token"),
        (status = 403, description = "Token not allowed here")
    )
)]
pub(super) async fn take_over(
    State(s): State<ApiState>,
    Path(host_id): Path<Uuid>,
    Json(req): Json<TakeoverRequest>,
) -> Result<Response, AppError> {
    let lease = s.store.take_over(host_id, req.actor, req.ttl_s)?;
    Ok((StatusCode::CREATED, Json(lease)).into_response())
}

/// `POST /v1/hosts/{id}/takeover/{lease_id}/renew`
#[utoipa::path(
    post,
    path = "/v1/hosts/{id}/takeover/{lease_id}/renew",
    tag = "desktop",
    params(("id" = Uuid, Path, description = "Host id"), ("lease_id" = Uuid, Path, description = "Lease id")),
    request_body = RenewRequest,
    responses((status = 200, body = Lease), (status = 404, description = "No such live lease"))
)]
pub(super) async fn renew(
    State(s): State<ApiState>,
    Path((host_id, lease_id)): Path<(Uuid, Uuid)>,
    body: Option<Json<RenewRequest>>,
) -> Result<Json<Lease>, AppError> {
    let ttl = body.and_then(|Json(b)| b.ttl_s);
    Ok(Json(s.store.renew_takeover(host_id, lease_id, ttl)?))
}

/// `DELETE /v1/hosts/{id}/takeover/{lease_id}`
#[utoipa::path(
    delete,
    path = "/v1/hosts/{id}/takeover/{lease_id}",
    tag = "desktop",
    params(("id" = Uuid, Path, description = "Host id"), ("lease_id" = Uuid, Path, description = "Lease id")),
    responses((status = 204, description = "Released: the agent continues"), (status = 404, description = "No such lease"))
)]
pub(super) async fn release(
    State(s): State<ApiState>,
    Path((host_id, lease_id)): Path<(Uuid, Uuid)>,
) -> Result<StatusCode, AppError> {
    s.store.release_takeover(host_id, lease_id)?;
    Ok(StatusCode::NO_CONTENT)
}

/// `GET /v1/hosts/{id}/takeover`: the live lease, or 404.
#[utoipa::path(
    get,
    path = "/v1/hosts/{id}/takeover",
    tag = "desktop",
    params(("id" = Uuid, Path, description = "Host id")),
    responses((status = 200, body = Lease), (status = 404, description = "Nobody controls it"))
)]
pub(super) async fn current(
    State(s): State<ApiState>,
    Path(host_id): Path<Uuid>,
) -> Result<Json<Lease>, AppError> {
    s.store.takeover(host_id).map(Json).ok_or_else(|| {
        AppError(
            StatusCode::NOT_FOUND,
            "not_found",
            "nobody controls this desktop".into(),
        )
    })
}

// ------------------------------------------------------------------ RFB input filter

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Phase {
    Version,
    Security,
    VncAuth,
    ClientInit,
    Messages,
}

/// Parses the viewer→node half of an RFB stream and drops input (key,
/// pointer, clipboard) unless allowed. Messages may arrive split across or
/// joined within WebSocket frames.
#[derive(Debug)]
pub struct RfbInputFilter {
    buf: Vec<u8>,
    phase: Phase,
    /// Input messages dropped so far.
    pub dropped: u64,
}

impl Default for RfbInputFilter {
    fn default() -> Self {
        Self {
            buf: Vec::new(),
            phase: Phase::Version,
            dropped: 0,
        }
    }
}

/// Largest clipboard text accepted from a viewer.
const MAX_CUT_TEXT: usize = 1 << 20;

impl RfbInputFilter {
    /// Bytes the next complete unit needs, or `None` until more arrive.
    /// `Err` for a message type this filter does not know.
    fn needed(&self) -> Result<Option<(usize, bool)>, String> {
        let b = &self.buf;
        let have = |n: usize| b.len() >= n;
        Ok(match self.phase {
            Phase::Version => have(12).then_some((12, false)),
            Phase::Security => have(1).then_some((1, false)),
            Phase::VncAuth => have(16).then_some((16, false)),
            Phase::ClientInit => have(1).then_some((1, false)),
            Phase::Messages => {
                let Some(&t) = b.first() else { return Ok(None) };
                let fixed = |n: usize, input: bool| have(n).then_some((n, input));
                match t {
                    0 => fixed(20, false), // SetPixelFormat
                    2 => {
                        // SetEncodings: 4 + 4n
                        if !have(4) {
                            None
                        } else {
                            let n = u16::from_be_bytes([b[2], b[3]]) as usize;
                            fixed(4 + 4 * n, false)
                        }
                    }
                    3 => fixed(10, false), // FramebufferUpdateRequest
                    4 => fixed(8, true),   // KeyEvent
                    5 => fixed(6, true),   // PointerEvent
                    6 => {
                        // ClientCutText: 8 + len
                        if !have(8) {
                            None
                        } else {
                            let len = u32::from_be_bytes([b[4], b[5], b[6], b[7]]) as usize;
                            if len > MAX_CUT_TEXT {
                                return Err(format!("clipboard text of {len} bytes is too large"));
                            }
                            fixed(8 + len, true)
                        }
                    }
                    150 => fixed(10, false), // EnableContinuousUpdates
                    248 => {
                        // ClientFence: 9 + len
                        if !have(9) {
                            None
                        } else {
                            fixed(9 + b[8] as usize, false)
                        }
                    }
                    250 => fixed(4, true), // xvp (power actions)
                    251 => {
                        // SetDesktopSize: 8 + 16n
                        if !have(8) {
                            None
                        } else {
                            fixed(8 + 16 * b[6] as usize, true)
                        }
                    }
                    255 => {
                        // QEMU client message: only the extended key event.
                        if !have(2) {
                            None
                        } else if b[1] == 0 {
                            fixed(12, true)
                        } else {
                            return Err(format!("unsupported QEMU message {}", b[1]));
                        }
                    }
                    other => return Err(format!("unknown RFB client message type {other}")),
                }
            }
        })
    }

    /// Feeds viewer bytes; returns those to forward to the node.
    pub fn feed(&mut self, data: &[u8], input_allowed: bool) -> Result<Vec<u8>, String> {
        self.buf.extend_from_slice(data);
        let mut out = Vec::with_capacity(data.len());
        while let Some((n, input)) = self.needed()? {
            let unit: Vec<u8> = self.buf.drain(..n).collect();
            self.phase = match self.phase {
                Phase::Version => Phase::Security,
                Phase::Security if unit[0] == 2 => Phase::VncAuth,
                Phase::Security | Phase::VncAuth => Phase::ClientInit,
                Phase::ClientInit | Phase::Messages => Phase::Messages,
            };
            if input && !input_allowed {
                self.dropped += 1;
            } else {
                out.extend_from_slice(&unit);
            }
        }
        Ok(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn handshake() -> Vec<u8> {
        let mut v = b"RFB 003.008\n".to_vec();
        v.push(1); // security type None
        v.push(1); // ClientInit shared
        v
    }

    const POINTER: [u8; 6] = [5, 1, 0, 10, 0, 20];
    const KEY: [u8; 8] = [4, 1, 0, 0, 0, 0, 0xff, 0x0d];
    const FB_REQ: [u8; 10] = [3, 1, 0, 0, 0, 0, 7, 128, 4, 56];

    #[test]
    fn forwards_the_handshake_and_display_requests_but_drops_input_without_the_lease() {
        let mut f = RfbInputFilter::default();
        assert_eq!(f.feed(&handshake(), false).unwrap(), handshake());
        let mut msg = FB_REQ.to_vec();
        msg.extend(POINTER);
        msg.extend(KEY);
        msg.extend([6, 0, 0, 0, 0, 0, 0, 3, b'a', b'b', b'c']); // clipboard
        assert_eq!(f.feed(&msg, false).unwrap(), FB_REQ.to_vec());
        assert_eq!(f.dropped, 3);
        // With the lease, everything passes.
        assert_eq!(f.feed(&msg, true).unwrap(), msg);
    }

    #[test]
    fn handles_messages_split_across_frames() {
        let mut f = RfbInputFilter::default();
        let mut all = handshake();
        all.extend(POINTER);
        all.extend([2, 0, 0, 2, 0, 0, 0, 7, 0xff, 0xff, 0xfe, 0xfc]); // SetEncodings (2)
        all.extend(KEY);
        let mut out = Vec::new();
        for b in &all {
            out.extend(f.feed(&[*b], true).unwrap());
        }
        assert_eq!(out, all);
        let mut f = RfbInputFilter::default();
        let mut out = Vec::new();
        for chunk in all.chunks(5) {
            out.extend(f.feed(chunk, false).unwrap());
        }
        let mut expected = handshake();
        expected.extend([2, 0, 0, 2, 0, 0, 0, 7, 0xff, 0xff, 0xfe, 0xfc]);
        assert_eq!(out, expected);
    }

    #[test]
    fn knows_extensions_and_refuses_unknown_messages() {
        let mut f = RfbInputFilter::default();
        f.feed(&handshake(), false).unwrap();
        // EnableContinuousUpdates, ClientFence (2-byte payload) pass; QEMU key and resize are input.
        let cu = [150, 1, 0, 0, 0, 0, 7, 128, 4, 56];
        let fence = [248, 0, 0, 0, 0, 0, 0, 0, 2, 9, 9];
        let qemu_key = [255, 0, 0, 1, 0, 0, 0xff, 0x0d, 0, 0, 0, 28];
        let mut msg = cu.to_vec();
        msg.extend(fence);
        msg.extend(qemu_key);
        let mut expected = cu.to_vec();
        expected.extend(fence);
        assert_eq!(f.feed(&msg, false).unwrap(), expected);
        assert!(f.feed(&[42], false).unwrap_err().contains("unknown"));
    }

    #[test]
    fn vnc_auth_response_is_part_of_the_handshake() {
        let mut f = RfbInputFilter::default();
        let mut v = b"RFB 003.008\n".to_vec();
        v.push(2);
        v.extend([7u8; 16]);
        v.push(1);
        v.extend(POINTER);
        let mut expected = v.clone();
        expected.truncate(v.len() - POINTER.len());
        assert_eq!(f.feed(&v, false).unwrap(), expected);
    }

    #[test]
    fn refuses_huge_clipboard_text() {
        let mut f = RfbInputFilter::default();
        f.feed(&handshake(), true).unwrap();
        assert!(f.feed(&[6, 0, 0, 0, 0x10, 0, 0, 0], true).is_err());
    }
}
