//! Human handoff (#189): an agent pauses a session until a human acts.
//!
//! Each handoff has a single-use response token (stored as a SHA-256 digest)
//! that any channel can present to answer it without the API token. Secret
//! inputs (one-time codes) are held only until the API caller claims them.

use std::time::Duration;

use chrono::{DateTime, Utc};
use hexactra_core::remote::{
    CreateHandoffRequest, HandoffInput, HandoffOutcome, HandoffResponse, HandoffStatus,
    HandoffView, RemoteSessionStatus, RespondHandoffRequest, DEFAULT_HANDOFF_TIMEOUT_MS,
    MAX_HANDOFF_VALUE,
};
use sha2::{Digest, Sha256};
use tokio::sync::watch;
use uuid::Uuid;

use super::store::{Inner, RuntimeStore, StoreError};

/// Event published to webhook dispatchers and other listeners.
#[derive(Debug, Clone)]
pub struct RuntimeEvent {
    pub id: Uuid,
    /// `handoff.created`, `handoff.resolved`, `handoff.cancelled`, `handoff.expired`.
    pub kind: &'static str,
    pub created_at: DateTime<Utc>,
    pub handoff: HandoffView,
    /// Only on `handoff.created`: the token channels use to answer.
    pub response_token: Option<String>,
}

impl RuntimeEvent {
    fn new(kind: &'static str, handoff: HandoffView, response_token: Option<String>) -> Self {
        Self {
            id: Uuid::new_v4(),
            kind,
            created_at: Utc::now(),
            handoff,
            response_token,
        }
    }
}

/// A handoff as persisted: the view and the response-token digest. A
/// secret answer waiting to be claimed is deliberately not persisted.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub(crate) struct HandoffRecord {
    pub view: HandoffView,
    pub token_digest: Option<[u8; 32]>,
}

pub(super) struct HandoffEntry {
    view: HandoffView,
    token_digest: Option<[u8; 32]>,
    secret_value: Option<String>,
    tx: watch::Sender<HandoffStatus>,
}

fn digest(token: &str) -> [u8; 32] {
    Sha256::digest(token.as_bytes()).into()
}

fn ct_eq(a: &[u8; 32], b: &[u8; 32]) -> bool {
    a.iter()
        .zip(b.iter())
        .fold(0u8, |acc, (x, y)| acc | (x ^ y))
        == 0
}

/// Who is answering.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Responder<'a> {
    /// Holder of the API token.
    Operator,
    /// Holder of the handoff's response token.
    Token(&'a str),
}

impl RuntimeStore {
    /// Publish a handoff event to webhooks and the event log. The event-log
    /// copy is content-free (no prompt, no answer, no token).
    pub(super) fn publish(&self, ev: RuntimeEvent) {
        let h = &ev.handoff;
        self.log.emit(
            ev.kind,
            serde_json::json!({
                "handoff_id": h.id,
                "session_id": h.session_id,
                "host_id": h.host_id,
                "profile": h.profile,
                "kind": h.kind,
                "input": h.input,
                "status": h.status,
            }),
        );
        let _ = self.events.send(ev);
    }

    /// Subscribe to runtime events (handoff lifecycle).
    pub fn subscribe_events(&self) -> tokio::sync::broadcast::Receiver<RuntimeEvent> {
        self.events.subscribe()
    }

    pub(super) fn pending_handoff(inner: &Inner, session_id: Uuid) -> Option<Uuid> {
        inner
            .handoffs
            .values()
            .find(|h| h.view.session_id == session_id && h.view.status == HandoffStatus::Pending)
            .map(|h| h.view.id)
    }

    pub(super) fn cancel_session_handoffs(
        inner: &mut Inner,
        session_id: Uuid,
        now: DateTime<Utc>,
    ) -> Vec<RuntimeEvent> {
        let mut events = Vec::new();
        for h in inner.handoffs.values_mut() {
            if h.view.session_id == session_id && h.view.status == HandoffStatus::Pending {
                h.view.status = HandoffStatus::Cancelled;
                h.view.resolved_at = Some(now);
                h.token_digest = None;
                let _ = h.tx.send(HandoffStatus::Cancelled);
                events.push(RuntimeEvent::new("handoff.cancelled", h.view.clone(), None));
            }
        }
        events
    }

    /// Open a handoff on a session. Returns the view and the response token.
    pub fn create_handoff(
        &self,
        session_id: Uuid,
        req: CreateHandoffRequest,
    ) -> Result<(HandoffView, String), StoreError> {
        req.validate().map_err(|e| StoreError::Invalid(e.0))?;
        let token = super::generate_token();
        let view = {
            let mut inner = self.lock();
            let session = inner
                .sessions
                .get(&session_id)
                .ok_or(StoreError::NotFound("session"))?;
            if session.status != RemoteSessionStatus::Active {
                return Err(StoreError::Conflict("session has ended".into()));
            }
            let host_id = session.host_id;
            let profile = session.profile.clone();
            let viewer_url = inner.hosts.get(&host_id).and_then(|h| h.viewer_url.clone());
            if let Some(h) = Self::pending_handoff(&inner, session_id) {
                return Err(StoreError::HandoffPending(h));
            }
            let now = Utc::now();
            let timeout = req.timeout_ms.unwrap_or(DEFAULT_HANDOFF_TIMEOUT_MS);
            let view = HandoffView {
                id: Uuid::new_v4(),
                session_id,
                host_id,
                profile,
                kind: req.kind,
                prompt: req.prompt.trim().to_string(),
                input: req.input,
                choices: req.choices,
                page: req.page,
                status: HandoffStatus::Pending,
                created_at: now,
                expires_at: now + chrono::Duration::milliseconds(timeout as i64),
                resolved_at: None,
                response: None,
                viewer_url,
            };
            let (tx, _) = watch::channel(HandoffStatus::Pending);
            inner.handoffs.insert(
                view.id,
                HandoffEntry {
                    view: view.clone(),
                    token_digest: Some(digest(&token)),
                    secret_value: None,
                    tx,
                },
            );
            view
        };
        self.publish(RuntimeEvent::new(
            "handoff.created",
            view.clone(),
            Some(token.clone()),
        ));
        self.schedule_handoff_expiry(view.id, view.expires_at);
        Ok((view, token))
    }

    /// Expire a pending handoff at `expires_at`.
    pub(super) fn schedule_handoff_expiry(&self, id: Uuid, expires_at: DateTime<Utc>) {
        let store = self.clone();
        let wait = (expires_at - Utc::now()).to_std().unwrap_or_default();
        tokio::spawn(async move {
            tokio::time::sleep(wait).await;
            store.expire_handoff(id);
        });
    }

    pub(super) fn export_handoffs(inner: &Inner) -> Vec<HandoffRecord> {
        let mut v: Vec<HandoffRecord> = inner
            .handoffs
            .values()
            .map(|h| HandoffRecord {
                view: h.view.clone(),
                token_digest: h.token_digest,
            })
            .collect();
        v.sort_by_key(|h| h.view.id);
        v
    }

    /// Restore handoffs; returns pending ones that need an expiry timer.
    pub(super) fn import_handoffs(
        inner: &mut Inner,
        records: Vec<HandoffRecord>,
    ) -> Vec<(Uuid, DateTime<Utc>)> {
        let mut pending = Vec::new();
        for r in records {
            let (tx, _) = watch::channel(r.view.status);
            if r.view.status == HandoffStatus::Pending {
                pending.push((r.view.id, r.view.expires_at));
            }
            inner.handoffs.insert(
                r.view.id,
                HandoffEntry {
                    view: r.view,
                    token_digest: r.token_digest,
                    secret_value: None,
                    tx,
                },
            );
        }
        pending
    }

    fn expire_handoff(&self, id: Uuid) {
        let ev = {
            let mut inner = self.lock();
            let Some(h) = inner.handoffs.get_mut(&id) else {
                return;
            };
            if h.view.status != HandoffStatus::Pending {
                return;
            }
            h.view.status = HandoffStatus::Expired;
            h.view.resolved_at = Some(Utc::now());
            h.token_digest = None;
            let _ = h.tx.send(HandoffStatus::Expired);
            RuntimeEvent::new("handoff.expired", h.view.clone(), None)
        };
        tracing::info!(handoff_id = %id, "handoff expired");
        self.publish(ev);
    }

    pub fn get_handoff(&self, id: Uuid) -> Result<HandoffView, StoreError> {
        self.lock()
            .handoffs
            .get(&id)
            .map(|h| h.view.clone())
            .ok_or(StoreError::NotFound("handoff"))
    }

    /// Check a response token without consuming it (for the HTML form).
    pub fn check_handoff_token(&self, id: Uuid, token: &str) -> Result<HandoffView, StoreError> {
        let inner = self.lock();
        let h = inner
            .handoffs
            .get(&id)
            .ok_or(StoreError::NotFound("handoff"))?;
        match &h.token_digest {
            Some(d) if ct_eq(d, &digest(token)) => Ok(h.view.clone()),
            _ => Err(StoreError::Forbidden),
        }
    }

    pub fn list_handoffs(&self, session_id: Option<Uuid>, pending_only: bool) -> Vec<HandoffView> {
        let mut v: Vec<_> = self
            .lock()
            .handoffs
            .values()
            .filter(|h| session_id.map(|s| h.view.session_id == s).unwrap_or(true))
            .filter(|h| !pending_only || h.view.status == HandoffStatus::Pending)
            .map(|h| h.view.clone())
            .collect();
        v.sort_by_key(|h| std::cmp::Reverse(h.created_at));
        v
    }

    /// Answer a handoff. Response tokens are single-use.
    pub fn respond_handoff(
        &self,
        id: Uuid,
        responder: Responder<'_>,
        req: RespondHandoffRequest,
    ) -> Result<HandoffView, StoreError> {
        let ev = {
            let mut inner = self.lock();
            let h = inner
                .handoffs
                .get_mut(&id)
                .ok_or(StoreError::NotFound("handoff"))?;
            if let Responder::Token(t) = responder {
                match &h.token_digest {
                    Some(d) if ct_eq(d, &digest(t)) => {}
                    _ => return Err(StoreError::Forbidden),
                }
            }
            if h.view.status != HandoffStatus::Pending {
                return Err(StoreError::Conflict(format!(
                    "handoff is already {:?}",
                    h.view.status
                )));
            }
            let channel = req
                .channel
                .map(|c| c.chars().take(64).collect::<String>())
                .filter(|c| !c.trim().is_empty());
            let value = req
                .value
                .map(|v| v.trim().to_string())
                .filter(|v| !v.is_empty());
            let (status, response) = match req.outcome {
                HandoffOutcome::Cancelled => (
                    HandoffStatus::Cancelled,
                    HandoffResponse {
                        value: None,
                        value_withheld: false,
                        channel,
                    },
                ),
                HandoffOutcome::Completed => {
                    if let Some(v) = &value {
                        if v.len() > MAX_HANDOFF_VALUE {
                            return Err(StoreError::Invalid(format!(
                                "value longer than {MAX_HANDOFF_VALUE} characters"
                            )));
                        }
                    }
                    match h.view.input {
                        HandoffInput::None => (
                            HandoffStatus::Completed,
                            HandoffResponse {
                                value: None,
                                value_withheld: false,
                                channel,
                            },
                        ),
                        HandoffInput::Text => {
                            let v = value.ok_or_else(|| {
                                StoreError::Invalid("this handoff needs a value".into())
                            })?;
                            (
                                HandoffStatus::Completed,
                                HandoffResponse {
                                    value: Some(v),
                                    value_withheld: false,
                                    channel,
                                },
                            )
                        }
                        HandoffInput::Choice => {
                            let v = value.ok_or_else(|| {
                                StoreError::Invalid("this handoff needs a choice".into())
                            })?;
                            if !h.view.choices.iter().any(|c| c == &v) {
                                return Err(StoreError::Invalid(
                                    "value is not one of the choices".into(),
                                ));
                            }
                            (
                                HandoffStatus::Completed,
                                HandoffResponse {
                                    value: Some(v),
                                    value_withheld: false,
                                    channel,
                                },
                            )
                        }
                        HandoffInput::Secret => {
                            let v = value.ok_or_else(|| {
                                StoreError::Invalid("this handoff needs a value".into())
                            })?;
                            h.secret_value = Some(v);
                            (
                                HandoffStatus::Completed,
                                HandoffResponse {
                                    value: None,
                                    value_withheld: true,
                                    channel,
                                },
                            )
                        }
                    }
                }
            };
            h.view.status = status;
            h.view.response = Some(response);
            h.view.resolved_at = Some(Utc::now());
            h.token_digest = None; // single use
            let _ = h.tx.send(status);
            let kind = if status == HandoffStatus::Cancelled {
                "handoff.cancelled"
            } else {
                "handoff.resolved"
            };
            RuntimeEvent::new(kind, h.view.clone(), None)
        };
        tracing::info!(handoff_id = %id, status = ?ev.handoff.status, "handoff resolved");
        let view = ev.handoff.clone();
        self.publish(ev);
        Ok(view)
    }

    /// Return a secret value once, then erase it.
    pub fn claim_handoff_secret(&self, id: Uuid) -> Result<String, StoreError> {
        let mut inner = self.lock();
        let h = inner
            .handoffs
            .get_mut(&id)
            .ok_or(StoreError::NotFound("handoff"))?;
        if h.view.input != HandoffInput::Secret {
            return Err(StoreError::Invalid("handoff has no secret value".into()));
        }
        h.secret_value.take().ok_or_else(|| {
            StoreError::Conflict(
                "no secret value to claim (not answered yet, or already claimed)".into(),
            )
        })
    }

    /// Wait until the handoff leaves `pending` or `wait` elapses.
    pub async fn wait_handoff(&self, id: Uuid, wait: Duration) -> Result<HandoffView, StoreError> {
        let mut rx = {
            let inner = self.lock();
            inner
                .handoffs
                .get(&id)
                .ok_or(StoreError::NotFound("handoff"))?
                .tx
                .subscribe()
        };
        let _ = tokio::time::timeout(wait, async {
            loop {
                if rx.borrow_and_update().is_terminal() {
                    return;
                }
                if rx.changed().await.is_err() {
                    return;
                }
            }
        })
        .await;
        self.get_handoff(id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use hexactra_core::remote::{HandoffKind, RemoteAction};

    fn setup() -> (RuntimeStore, Uuid) {
        let s = RuntimeStore::new();
        let h = s.register_host(None, "h".into(), "0".into());
        let sess = s.create_session(Some(h), None).unwrap();
        (s, sess.id)
    }

    fn req(input: HandoffInput) -> CreateHandoffRequest {
        CreateHandoffRequest {
            kind: HandoffKind::Code,
            prompt: "Enter the code".into(),
            input,
            choices: if input == HandoffInput::Choice {
                vec!["Yes".into(), "No".into()]
            } else {
                vec![]
            },
            timeout_ms: None,
            page: None,
        }
    }

    fn answer(value: Option<&str>, token: Option<&str>) -> RespondHandoffRequest {
        RespondHandoffRequest {
            outcome: HandoffOutcome::Completed,
            value: value.map(str::to_string),
            response_token: token.map(str::to_string),
            channel: Some("test".into()),
        }
    }

    #[tokio::test]
    async fn pending_handoff_blocks_actions_until_resolved() {
        let (s, sess) = setup();
        let mut events = s.subscribe_events();
        let (h, token) = s.create_handoff(sess, req(HandoffInput::None)).unwrap();
        assert_eq!(events.recv().await.unwrap().kind, "handoff.created");
        assert!(matches!(
            s.enqueue(sess, RemoteAction::Tabs, Duration::from_secs(1)),
            Err(StoreError::HandoffPending(id)) if id == h.id
        ));
        // A second handoff on the same session is refused.
        assert!(s.create_handoff(sess, req(HandoffInput::None)).is_err());
        s.respond_handoff(h.id, Responder::Token(&token), answer(None, None))
            .unwrap();
        assert_eq!(events.recv().await.unwrap().kind, "handoff.resolved");
        assert!(s
            .enqueue(sess, RemoteAction::Tabs, Duration::from_secs(1))
            .is_ok());
    }

    #[tokio::test]
    async fn tokens_are_single_use_and_checked() {
        let (s, sess) = setup();
        let (h, token) = s.create_handoff(sess, req(HandoffInput::Text)).unwrap();
        assert_eq!(
            s.respond_handoff(h.id, Responder::Token("wrong"), answer(Some("x"), None))
                .unwrap_err(),
            StoreError::Forbidden
        );
        // Value required for text input.
        assert!(matches!(
            s.respond_handoff(h.id, Responder::Token(&token), answer(None, None)),
            Err(StoreError::Invalid(_))
        ));
        let v = s
            .respond_handoff(h.id, Responder::Token(&token), answer(Some("hello"), None))
            .unwrap();
        assert_eq!(v.response.unwrap().value.as_deref(), Some("hello"));
        assert_eq!(
            s.respond_handoff(h.id, Responder::Token(&token), answer(Some("again"), None))
                .unwrap_err(),
            StoreError::Forbidden
        );
        assert!(s.check_handoff_token(h.id, &token).is_err());
    }

    #[tokio::test]
    async fn secret_is_withheld_and_claimed_once() {
        let (s, sess) = setup();
        let mut events = s.subscribe_events();
        let (h, token) = s.create_handoff(sess, req(HandoffInput::Secret)).unwrap();
        events.recv().await.unwrap();
        s.respond_handoff(h.id, Responder::Token(&token), answer(Some("123456"), None))
            .unwrap();
        let ev = events.recv().await.unwrap();
        let payload = serde_json::to_string(&ev.handoff).unwrap();
        assert!(!payload.contains("123456"));
        let read = serde_json::to_string(&s.get_handoff(h.id).unwrap()).unwrap();
        assert!(!read.contains("123456"));
        assert_eq!(s.claim_handoff_secret(h.id).unwrap(), "123456");
        assert!(s.claim_handoff_secret(h.id).is_err());
    }

    #[tokio::test]
    async fn choice_must_match() {
        let (s, sess) = setup();
        let (h, _) = s.create_handoff(sess, req(HandoffInput::Choice)).unwrap();
        assert!(s
            .respond_handoff(h.id, Responder::Operator, answer(Some("Maybe"), None))
            .is_err());
        let v = s
            .respond_handoff(h.id, Responder::Operator, answer(Some("Yes"), None))
            .unwrap();
        assert_eq!(v.status, HandoffStatus::Completed);
    }

    #[tokio::test]
    async fn expiry_and_session_end() {
        let (s, sess) = setup();
        let mut r = req(HandoffInput::None);
        r.timeout_ms = Some(hexactra_core::remote::MIN_HANDOFF_TIMEOUT_MS);
        let (h, _) = s.create_handoff(sess, r).unwrap();
        // Force expiry without waiting 10 s.
        s.expire_handoff(h.id);
        let v = s
            .wait_handoff(h.id, Duration::from_millis(10))
            .await
            .unwrap();
        assert_eq!(v.status, HandoffStatus::Expired);

        let (h2, _) = s.create_handoff(sess, req(HandoffInput::None)).unwrap();
        s.end_session(sess).unwrap();
        assert_eq!(
            s.get_handoff(h2.id).unwrap().status,
            HandoffStatus::Cancelled
        );
    }
}
