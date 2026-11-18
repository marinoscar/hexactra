//! Human handoff (#189): an agent pauses a session until a human acts.
//!
//! Each handoff has a single-use response token (stored as a SHA-256 digest)
//! that any channel can present to answer it without the API token.
//!
//! Secret inputs (one-time codes, #287) are held in memory only, never
//! persisted or returned by the handoff routes. The value is used once: a
//! `type_secret` action of the same session consumes it and the control
//! plane types it into the page itself. An unused value is erased (and its
//! memory zeroed) [`SECRET_TTL`] after the answer, when the session ends,
//! and when the deprecated claim route takes it.

use std::time::Duration;

use chrono::{DateTime, Utc};
use hexactra_core::remote::{
    CreateHandoffRequest, HandoffInput, HandoffOutcome, HandoffRemember, HandoffResponse,
    HandoffRisk, HandoffStatus, HandoffView, RemoteSessionStatus, RespondHandoffRequest,
    DEFAULT_HANDOFF_TIMEOUT_MS, MAX_HANDOFF_ANSWERED_BY, MAX_HANDOFF_VALUE,
};
use sha2::{Digest, Sha256};
use tokio::sync::watch;
use uuid::Uuid;
use zeroize::Zeroizing;

use super::store::{Inner, RuntimeStore, StoreError};

/// How long a secret answer stays usable after the person gives it. One-time
/// codes expire within minutes anyway; a value no one used is erased.
pub const SECRET_TTL: Duration = Duration::from_secs(10 * 60);

/// A secret answer waiting to be used. Its memory is zeroed when dropped.
pub(super) struct HeldSecret {
    value: Zeroizing<String>,
    expires_at: DateTime<Utc>,
}

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
    secret: Option<HeldSecret>,
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
    /// Holder of the operator token.
    Operator,
    /// Holder of a service token, by the token's name.
    Service(&'a str),
    /// Holder of the handoff's response token.
    Token(&'a str),
}

impl Responder<'_> {
    /// The response's `by`: the caller's `answered_by` when the responder is
    /// authenticated (operator or service), else the responder itself.
    fn by(self, answered_by: Option<String>) -> Result<String, StoreError> {
        let claimed = match self {
            Responder::Token(_) => None,
            _ => answered_by
                .map(|a| a.trim().to_string())
                .filter(|a| !a.is_empty()),
        };
        if let Some(a) = claimed {
            if a.chars().count() > MAX_HANDOFF_ANSWERED_BY || a.chars().any(char::is_control) {
                return Err(StoreError::Invalid(format!(
                    "answered_by must be 1-{MAX_HANDOFF_ANSWERED_BY} printable characters"
                )));
            }
            return Ok(a);
        }
        Ok(match self {
            Responder::Operator => "operator".into(),
            Responder::Service(name) => format!("service:{name}"),
            Responder::Token(_) => "token".into(),
        })
    }
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

    /// Whether the handoff asks for a secret (a code, a password).
    pub(super) fn handoff_asks_secret(inner: &Inner, id: Uuid) -> bool {
        inner
            .handoffs
            .get(&id)
            .is_some_and(|h| h.view.input.holds_secret())
    }

    pub(super) fn cancel_session_handoffs(
        inner: &mut Inner,
        session_id: Uuid,
        now: DateTime<Utc>,
    ) -> Vec<RuntimeEvent> {
        let mut events = Vec::new();
        for h in inner.handoffs.values_mut() {
            if h.view.session_id == session_id {
                // An unused secret dies with its session.
                h.secret = None;
            }
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
                choices: req.choices.iter().map(|c| c.to_choice()).collect(),
                constraints: req.constraints,
                confirm_label: req.confirm_label,
                deny_label: req.deny_label,
                risk: if req.input == HandoffInput::Confirm {
                    Some(req.risk.unwrap_or(HandoffRisk::High))
                } else {
                    None
                },
                page: req.page,
                remember: req.remember.map(|r| HandoffRemember {
                    label: r.label.trim().to_string(),
                }),
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
                    secret: None,
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
        for mut r in records {
            // Responses saved before typed questions lack `outcome` and
            // `answered_at`: a response exists only on an answered handoff,
            // so both follow from the status and `resolved_at`.
            if let Some(resp) = r.view.response.as_mut() {
                if r.view.status == HandoffStatus::Cancelled {
                    resp.outcome = HandoffOutcome::Cancelled;
                }
                if resp.answered_at.is_none() {
                    resp.answered_at = r.view.resolved_at;
                }
            }
            let (tx, _) = watch::channel(r.view.status);
            if r.view.status == HandoffStatus::Pending {
                pending.push((r.view.id, r.view.expires_at));
            }
            inner.handoffs.insert(
                r.view.id,
                HandoffEntry {
                    view: r.view,
                    token_digest: r.token_digest,
                    secret: None,
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
            h.secret = None;
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
            let by = responder.by(req.answered_by)?;
            let now = Utc::now();
            let mut response = HandoffResponse {
                outcome: req.outcome,
                value: None,
                values: None,
                value_withheld: false,
                remember: None,
                channel,
                by: Some(by),
                answered_at: Some(now),
            };
            let status = match req.outcome {
                HandoffOutcome::Cancelled => HandoffStatus::Cancelled,
                HandoffOutcome::Completed => {
                    if req.value.as_deref().map(str::len).unwrap_or(0) > MAX_HANDOFF_VALUE {
                        return Err(StoreError::Invalid(format!(
                            "value longer than {MAX_HANDOFF_VALUE} characters"
                        )));
                    }
                    if req.remember.is_some() && h.view.remember.is_none() {
                        return Err(StoreError::Invalid(
                            "this handoff offered no remember option".into(),
                        ));
                    }
                    // The password of a sign-in, apart from the username.
                    let password = match (h.view.input, req.secret) {
                        (HandoffInput::Credentials, Some(p)) if !p.is_empty() => {
                            if p.chars().count() > h.view.constraints.text_max_length() {
                                return Err(StoreError::Invalid(format!(
                                    "password longer than {} characters",
                                    h.view.constraints.text_max_length()
                                )));
                            }
                            Some(Zeroizing::new(p))
                        }
                        (HandoffInput::Credentials, _) => {
                            return Err(StoreError::Invalid(
                                "this handoff needs a password (secret)".into(),
                            ))
                        }
                        (_, Some(_)) => {
                            return Err(StoreError::Invalid(
                                "secret is only accepted for input \"credentials\"".into(),
                            ))
                        }
                        (_, None) => None,
                    };
                    let answer = h
                        .view
                        .check_answer(req.value, req.values)
                        .map_err(|e| StoreError::Invalid(e.0))?;
                    response.remember = req.remember;
                    let held = |value| HeldSecret {
                        value,
                        expires_at: now
                            + chrono::Duration::from_std(SECRET_TTL).unwrap_or_default(),
                    };
                    if let Some(p) = password {
                        // The username is not a secret: it is returned like a text answer.
                        h.secret = Some(held(p));
                        response.value = answer.value;
                        response.value_withheld = true;
                    } else if h.view.input == HandoffInput::Secret {
                        h.secret = answer.value.map(|v| held(Zeroizing::new(v)));
                        response.value_withheld = true;
                    } else {
                        response.value = answer.value;
                        response.values = answer.values;
                    }
                    HandoffStatus::Completed
                }
            };
            h.view.status = status;
            h.view.response = Some(response);
            h.view.resolved_at = Some(now);
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
        let withheld = view.response.as_ref().is_some_and(|r| r.value_withheld);
        self.publish(ev);
        if withheld {
            self.schedule_secret_erasure(id);
        }
        Ok(view)
    }

    /// Erase an unused secret answer once [`SECRET_TTL`] has passed.
    fn schedule_secret_erasure(&self, id: Uuid) {
        let store = self.clone();
        tokio::spawn(async move {
            tokio::time::sleep(SECRET_TTL).await;
            store.erase_expired_secret(id, Utc::now());
        });
    }

    /// Drop a secret whose time is up. Returns true if one was erased.
    pub(super) fn erase_expired_secret(&self, id: Uuid, now: DateTime<Utc>) -> bool {
        let mut inner = self.lock();
        let Some(h) = inner.handoffs.get_mut(&id) else {
            return false;
        };
        if h.secret.as_ref().is_some_and(|s| s.expires_at <= now) {
            h.secret = None;
            tracing::info!(handoff_id = %id, "unused handoff secret erased");
            return true;
        }
        false
    }

    /// Take a handoff's secret answer, once. With `session_id`, the handoff
    /// must belong to that session (a `type_secret` action).
    pub(super) fn take_handoff_secret(
        inner: &mut Inner,
        id: Uuid,
        session_id: Option<Uuid>,
        now: DateTime<Utc>,
    ) -> Result<Zeroizing<String>, StoreError> {
        let h = inner
            .handoffs
            .get_mut(&id)
            .ok_or(StoreError::NotFound("handoff"))?;
        if session_id.is_some_and(|s| s != h.view.session_id) {
            return Err(StoreError::Unprocessable(
                "handoff_wrong_session",
                "the handoff belongs to another session".into(),
            ));
        }
        if !h.view.input.holds_secret() {
            return Err(StoreError::Unprocessable(
                "handoff_not_secret",
                "the handoff did not ask for a secret".into(),
            ));
        }
        if h.view.status != HandoffStatus::Completed {
            return Err(StoreError::SecretUnavailable(format!(
                "the handoff is {}, not completed",
                serde_json::to_value(h.view.status)
                    .ok()
                    .and_then(|v| v.as_str().map(str::to_string))
                    .unwrap_or_default()
            )));
        }
        let secret = h.secret.take().ok_or_else(|| {
            StoreError::SecretUnavailable(
                "the secret was already used, or erased (session ended or it expired)".into(),
            )
        })?;
        if secret.expires_at <= now {
            return Err(StoreError::SecretUnavailable(
                "the secret expired unused; ask the person again".into(),
            ));
        }
        Ok(secret.value)
    }

    /// Return a secret value once, then erase it. Deprecated: a
    /// `type_secret` action types it without returning it to the caller.
    pub fn claim_handoff_secret(&self, id: Uuid) -> Result<String, StoreError> {
        let value = Self::take_handoff_secret(&mut self.lock(), id, None, Utc::now())?;
        self.log.emit(
            "handoff.secret_claimed",
            serde_json::json!({ "handoff_id": id }),
        );
        Ok(String::clone(&value))
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
    use hexactra_core::remote::{HandoffKind, HostWork, RemoteAction};

    fn setup() -> (RuntimeStore, Uuid) {
        let s = RuntimeStore::new();
        let h = s.register_host(None, "h".into(), "0".into());
        let sess = s.create_session(Some(h), None).unwrap();
        (s, sess.id)
    }

    fn req(input: HandoffInput) -> CreateHandoffRequest {
        let mut r = CreateHandoffRequest::new(HandoffKind::Code, "Enter the code", input);
        if input.has_choices() {
            r.choices = vec!["Yes".into(), "No".into()];
        }
        r
    }

    fn answer(value: Option<&str>, token: Option<&str>) -> RespondHandoffRequest {
        RespondHandoffRequest {
            outcome: HandoffOutcome::Completed,
            value: value.map(str::to_string),
            response_token: token.map(str::to_string),
            channel: Some("test".into()),
            ..Default::default()
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
        assert!(matches!(
            s.claim_handoff_secret(h.id),
            Err(StoreError::SecretUnavailable(_))
        ));
    }

    fn type_secret(handoff_id: Uuid) -> RemoteAction {
        RemoteAction::TypeSecret {
            handoff_id,
            selector: "#otp".into(),
            clear: true,
            submit: true,
            tab_id: None,
        }
    }

    /// A completed secret handoff on `sess`.
    fn shot() -> RemoteAction {
        RemoteAction::Screenshot {
            marks: false,
            mask: false,
            tab_id: None,
        }
    }

    // #525: the person still sees the page while the session waits for them.
    #[tokio::test]
    async fn a_plain_screenshot_is_taken_while_a_handoff_waits_but_nothing_acts() {
        for input in [
            HandoffInput::None,
            HandoffInput::Confirm,
            HandoffInput::Takeover,
        ] {
            let (s, sess) = setup();
            let (h, _) = s.create_handoff(sess, req(input)).unwrap();
            assert!(s.enqueue(sess, shot(), Duration::from_secs(1)).is_ok());
            assert!(s
                .enqueue(
                    sess,
                    RemoteAction::DesktopScreenshot,
                    Duration::from_secs(1)
                )
                .is_ok());
            // Everything that acts on the page, or draws on it, still waits.
            for acts in [
                RemoteAction::Tabs,
                RemoteAction::Screenshot {
                    marks: true,
                    mask: false,
                    tab_id: None,
                },
            ] {
                assert!(matches!(
                    s.enqueue(sess, acts, Duration::from_secs(1)),
                    Err(StoreError::HandoffPending(id)) if id == h.id
                ));
            }
        }
    }

    #[tokio::test]
    async fn no_screenshot_is_taken_while_a_secret_is_asked_for() {
        let (s, sess) = setup();
        let (h, _) = s.create_handoff(sess, req(HandoffInput::Secret)).unwrap();
        // A masked screenshot (#539) is refused too: masking is not a reason
        // to capture while the person types a secret.
        let masked = RemoteAction::Screenshot {
            marks: false,
            mask: true,
            tab_id: None,
        };
        for looks in [shot(), masked, RemoteAction::DesktopScreenshot] {
            assert!(matches!(
                s.enqueue(sess, looks, Duration::from_secs(1)),
                Err(StoreError::HandoffPending(id)) if id == h.id
            ));
        }
        // Once the secret is given, the picture is back.
        s.respond_handoff(h.id, Responder::Operator, answer(Some("424242"), None))
            .unwrap();
        assert!(s.enqueue(sess, shot(), Duration::from_secs(1)).is_ok());
    }

    #[tokio::test]
    async fn a_plain_screenshot_is_taken_while_a_person_holds_the_desktop() {
        let (s, sess) = setup();
        let host = s.get_session(sess).unwrap().host_id;
        s.take_over(
            host,
            crate::runtime::takeover::TakeoverActor {
                user_id: "u1".into(),
                display_name: None,
            },
            None,
        )
        .unwrap();
        assert!(s.enqueue(sess, shot(), Duration::from_secs(1)).is_ok());
        assert!(matches!(
            s.enqueue(sess, RemoteAction::Tabs, Duration::from_secs(1)),
            Err(StoreError::TakeoverActive(_))
        ));
    }

    fn sign_in(remember: Option<&str>) -> CreateHandoffRequest {
        let mut r = CreateHandoffRequest::new(
            HandoffKind::Login,
            "Sign in to Example Bank",
            HandoffInput::Credentials,
        );
        r.remember = remember.map(|l| HandoffRemember { label: l.into() });
        r
    }

    fn signed_in(user: &str, given: Option<&str>, remember: Option<bool>) -> RespondHandoffRequest {
        RespondHandoffRequest {
            outcome: HandoffOutcome::Completed,
            value: Some(user.into()),
            secret: given.map(str::to_string),
            remember,
            ..Default::default()
        }
    }

    // #527: one answer carries the username, which is returned, and the
    // password, which is held and typed like a secret, never returned.
    #[tokio::test]
    async fn a_sign_in_returns_the_username_and_types_the_password_once() {
        let (s, sess) = setup();
        let host = s.get_session(sess).unwrap().host_id;
        let mut events = s.subscribe_events();
        let (h, _) = s
            .create_handoff(sess, sign_in(Some("  Keep me signed in  ")))
            .unwrap();
        assert_eq!(h.remember.as_ref().unwrap().label, "Keep me signed in");
        // No picture of the page while it is asked for.
        assert!(matches!(
            s.enqueue(sess, shot(), Duration::from_secs(1)),
            Err(StoreError::HandoffPending(_))
        ));
        let view = s
            .respond_handoff(
                h.id,
                Responder::Operator,
                signed_in(" oscar ", Some("x9-424243"), Some(true)),
            )
            .unwrap();
        let resp = view.response.clone().unwrap();
        assert_eq!(resp.value.as_deref(), Some("oscar"));
        assert!(resp.value_withheld);
        assert_eq!(resp.remember, Some(true));
        // Not in a read, nor in an event.
        for shown in [
            serde_json::to_string(&s.get_handoff(h.id).unwrap()).unwrap(),
            serde_json::to_string(&events.recv().await.unwrap().handoff).unwrap(),
            serde_json::to_string(&events.recv().await.unwrap().handoff).unwrap(),
        ] {
            assert!(!shown.contains("x9-424243"), "{shown}");
        }
        // The password is typed once, by the host.
        s.enqueue(sess, type_secret(h.id), Duration::from_secs(5))
            .unwrap();
        assert!(matches!(
            s.enqueue(sess, type_secret(h.id), Duration::from_secs(5)),
            Err(StoreError::SecretUnavailable(_))
        ));
        let Some(HostWork::Operation(op)) = s
            .next_work(host, true, false, Duration::from_millis(50))
            .await
            .unwrap()
        else {
            panic!("no work");
        };
        assert!(
            matches!(&op.action, RemoteAction::Type { text, sensitive: true, .. } if text == "x9-424243")
        );
    }

    #[tokio::test]
    async fn a_sign_in_answer_is_checked() {
        let (s, sess) = setup();
        let bad = |req: RespondHandoffRequest, offered: Option<&str>| {
            let (h, _) = s.create_handoff(sess, sign_in(offered)).unwrap();
            let refused = matches!(
                s.respond_handoff(h.id, Responder::Operator, req),
                Err(StoreError::Invalid(_))
            );
            // Free the session for the next question.
            let _ = s.respond_handoff(
                h.id,
                Responder::Operator,
                RespondHandoffRequest {
                    outcome: HandoffOutcome::Cancelled,
                    ..Default::default()
                },
            );
            refused
        };
        // No password, an empty one, no username, a two-line username.
        assert!(bad(signed_in("oscar", None, None), None));
        assert!(bad(signed_in("oscar", Some(""), None), None));
        assert!(bad(signed_in("", Some("x9-424243"), None), None));
        assert!(bad(signed_in("os\ncar", Some("x9-424243"), None), None));
        // A remember choice the question did not offer.
        assert!(bad(signed_in("oscar", Some("x9-424243"), Some(true)), None));
        // Without a choice the page's box is left as it was: none is recorded.
        let (h, _) = s
            .create_handoff(sess, sign_in(Some("Remember me")))
            .unwrap();
        let v = s
            .respond_handoff(
                h.id,
                Responder::Operator,
                signed_in("oscar", Some("x9-424243"), None),
            )
            .unwrap();
        assert_eq!(v.response.unwrap().remember, None);
        // Declining needs neither value.
        let (h, _) = s.create_handoff(sess, sign_in(None)).unwrap();
        let v = s
            .respond_handoff(
                h.id,
                Responder::Operator,
                RespondHandoffRequest {
                    outcome: HandoffOutcome::Cancelled,
                    ..Default::default()
                },
            )
            .unwrap();
        assert_eq!(v.status, HandoffStatus::Cancelled);
        // A password on another kind of question is refused.
        let (h, _) = s.create_handoff(sess, req(HandoffInput::Text)).unwrap();
        assert!(matches!(
            s.respond_handoff(
                h.id,
                Responder::Operator,
                RespondHandoffRequest {
                    secret: Some("x9-424243".into()),
                    ..answer(Some("hi"), None)
                }
            ),
            Err(StoreError::Invalid(_))
        ));
    }

    #[test]
    fn remember_is_offered_only_with_a_secret_and_in_one_short_line() {
        let ok = |input, label: &str| {
            let mut r = CreateHandoffRequest::new(HandoffKind::Login, "p", input);
            r.remember = Some(HandoffRemember {
                label: label.into(),
            });
            r.validate().is_ok()
        };
        assert!(ok(HandoffInput::Credentials, "Remember me"));
        assert!(ok(HandoffInput::Secret, "Trust this device"));
        assert!(!ok(HandoffInput::Text, "Remember me"));
        assert!(!ok(HandoffInput::Confirm, "Remember me"));
        assert!(!ok(HandoffInput::Credentials, "   "));
        assert!(!ok(HandoffInput::Credentials, &"x".repeat(81)));
        assert!(!ok(HandoffInput::Credentials, "Remember\nme"));
    }

    fn answered_secret(s: &RuntimeStore, sess: Uuid, value: &str) -> Uuid {
        let (h, _) = s.create_handoff(sess, req(HandoffInput::Secret)).unwrap();
        s.respond_handoff(h.id, Responder::Operator, answer(Some(value), None))
            .unwrap();
        h.id
    }

    #[tokio::test]
    async fn type_secret_reaches_only_the_host_and_is_used_once() {
        let (s, sess) = setup();
        let host = s.get_session(sess).unwrap().host_id;
        let id = answered_secret(&s, sess, "424242");
        let (view, _) = s
            .enqueue(sess, type_secret(id), Duration::from_secs(5))
            .unwrap();
        // The secret is consumed at enqueue: neither route has it any more.
        assert!(matches!(
            s.enqueue(sess, type_secret(id), Duration::from_secs(5)),
            Err(StoreError::SecretUnavailable(_))
        ));
        assert!(s.claim_handoff_secret(id).is_err());
        let shown = serde_json::to_string(&s.get_operation(view.id).unwrap()).unwrap();
        assert!(!shown.contains("424242"), "{shown}");
        let Some(HostWork::Operation(op)) = s
            .next_work(host, true, false, Duration::from_millis(50))
            .await
            .unwrap()
        else {
            panic!("no work");
        };
        assert_eq!(op.id, view.id);
        assert_eq!(
            op.action,
            RemoteAction::Type {
                selector: "#otp".into(),
                text: "424242".into(),
                clear: true,
                submit: true,
                sensitive: true,
                tab_id: None,
            }
        );
        s.complete(
            host,
            op.id,
            hexactra_core::remote::OperationResult {
                navigation_blocked: Vec::new(),
                ok: true,
                result: Some(serde_json::json!({})),
                error: None,
            },
        )
        .unwrap();
        let shown = serde_json::to_string(&s.get_operation(view.id).unwrap()).unwrap();
        assert!(!shown.contains("424242"), "{shown}");
        let super::super::events::Replay::Events(log) = s.log.subscribe_from(Some(0)).1 else {
            panic!("gap");
        };
        let log = serde_json::to_string(&log).unwrap();
        assert!(!log.contains("424242"));
        assert!(log.contains("handoff.secret_used"));
    }

    #[tokio::test]
    async fn type_secret_errors_are_typed() {
        let (s, sess) = setup();
        let host = s.get_session(sess).unwrap().host_id;
        let other = s.create_session(Some(host), None).unwrap().id;
        // Unknown handoff.
        assert_eq!(
            s.enqueue(sess, type_secret(Uuid::new_v4()), Duration::from_secs(1))
                .unwrap_err(),
            StoreError::NotFound("handoff")
        );
        // Another session's secret is refused and left in place.
        let id = answered_secret(&s, sess, "111111");
        assert!(matches!(
            s.enqueue(other, type_secret(id), Duration::from_secs(1)),
            Err(StoreError::Unprocessable("handoff_wrong_session", _))
        ));
        assert!(s
            .enqueue(sess, type_secret(id), Duration::from_secs(1))
            .is_ok());
        // Not a secret handoff.
        let (t, _) = s.create_handoff(other, req(HandoffInput::Text)).unwrap();
        s.respond_handoff(t.id, Responder::Operator, answer(Some("x"), None))
            .unwrap();
        assert!(matches!(
            s.enqueue(other, type_secret(t.id), Duration::from_secs(1)),
            Err(StoreError::Unprocessable("handoff_not_secret", _))
        ));
        // Cancelled before an answer.
        let (c, _) = s.create_handoff(other, req(HandoffInput::Secret)).unwrap();
        s.respond_handoff(
            c.id,
            Responder::Operator,
            RespondHandoffRequest {
                outcome: HandoffOutcome::Cancelled,
                ..Default::default()
            },
        )
        .unwrap();
        assert!(matches!(
            s.enqueue(other, type_secret(c.id), Duration::from_secs(1)),
            Err(StoreError::SecretUnavailable(_))
        ));
    }

    #[tokio::test]
    async fn sensitive_type_text_is_held_apart_from_the_view() {
        let (s, sess) = setup();
        let host = s.get_session(sess).unwrap().host_id;
        let action = RemoteAction::Type {
            selector: "#pw".into(),
            text: "hunter2".into(),
            clear: false,
            submit: false,
            sensitive: true,
            tab_id: None,
        };
        let (view, _) = s.enqueue(sess, action, Duration::from_secs(5)).unwrap();
        let shown = serde_json::to_string(&s.get_operation(view.id).unwrap()).unwrap();
        assert!(!shown.contains("hunter2"));
        assert!(shown.contains(hexactra_core::remote::REDACTED_TEXT));
        let Some(HostWork::Operation(op)) = s
            .next_work(host, true, false, Duration::from_millis(50))
            .await
            .unwrap()
        else {
            panic!("no work");
        };
        assert!(matches!(op.action, RemoteAction::Type { ref text, .. } if text == "hunter2"));
    }

    #[tokio::test]
    async fn unused_secret_is_erased_after_its_ttl_and_at_session_end() {
        let (s, sess) = setup();
        let id = answered_secret(&s, sess, "222222");
        // Not yet due.
        assert!(!s.erase_expired_secret(id, Utc::now()));
        let later = Utc::now() + chrono::Duration::from_std(SECRET_TTL).unwrap();
        assert!(s.erase_expired_secret(id, later + chrono::Duration::seconds(1)));
        assert!(matches!(
            s.enqueue(sess, type_secret(id), Duration::from_secs(1)),
            Err(StoreError::SecretUnavailable(_))
        ));
        // Taking a secret past its TTL fails even before the timer runs.
        let id = answered_secret(&s, sess, "333333");
        assert!(matches!(
            RuntimeStore::take_handoff_secret(
                &mut s.lock(),
                id,
                Some(sess),
                later + chrono::Duration::seconds(1)
            ),
            Err(StoreError::SecretUnavailable(_))
        ));

        let id = answered_secret(&s, sess, "444444");
        s.end_session(sess).unwrap();
        assert!(s.lock().handoffs[&id].secret.is_none());
    }

    #[tokio::test]
    async fn a_queued_secret_dies_with_its_operation() {
        let (s, sess) = setup();
        let id = answered_secret(&s, sess, "555555");
        let (view, _) = s
            .enqueue(sess, type_secret(id), Duration::from_secs(5))
            .unwrap();
        s.time_out(view.id);
        assert!(s.lock().operations_secret_held(view.id) == Some(false));
        // An expired pending handoff holds no secret either.
        let (h, _) = s.create_handoff(sess, req(HandoffInput::Secret)).unwrap();
        s.expire_handoff(h.id);
        assert!(s.lock().handoffs[&h.id].secret.is_none());
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

    #[tokio::test]
    async fn response_records_outcome_and_who_answered() {
        let (s, sess) = setup();
        let claim = |by: &str| RespondHandoffRequest {
            answered_by: Some(by.into()),
            ..answer(Some("hi"), None)
        };
        // Response-token holders cannot claim an identity.
        let (h, token) = s.create_handoff(sess, req(HandoffInput::Text)).unwrap();
        let r = s
            .respond_handoff(h.id, Responder::Token(&token), claim("user:42"))
            .unwrap()
            .response
            .unwrap();
        assert_eq!(r.by.as_deref(), Some("token"));
        assert_eq!(r.outcome, HandoffOutcome::Completed);
        assert!(r.answered_at.is_some());

        let (h, _) = s.create_handoff(sess, req(HandoffInput::Text)).unwrap();
        let r = s
            .respond_handoff(h.id, Responder::Operator, answer(Some("hi"), None))
            .unwrap()
            .response
            .unwrap();
        assert_eq!(r.by.as_deref(), Some("operator"));

        let (h, _) = s.create_handoff(sess, req(HandoffInput::Text)).unwrap();
        let r = s
            .respond_handoff(
                h.id,
                Responder::Service("console"),
                answer(Some("hi"), None),
            )
            .unwrap()
            .response
            .unwrap();
        assert_eq!(r.by.as_deref(), Some("service:console"));

        let (h, _) = s.create_handoff(sess, req(HandoffInput::Text)).unwrap();
        assert!(matches!(
            s.respond_handoff(h.id, Responder::Service("console"), claim(&"x".repeat(129))),
            Err(StoreError::Invalid(_))
        ));
        let r = s
            .respond_handoff(h.id, Responder::Service("console"), claim("user:42"))
            .unwrap()
            .response
            .unwrap();
        assert_eq!(r.by.as_deref(), Some("user:42"));

        let (h, _) = s.create_handoff(sess, req(HandoffInput::Confirm)).unwrap();
        assert_eq!(h.risk, Some(HandoffRisk::High));
        let v = s
            .respond_handoff(
                h.id,
                Responder::Operator,
                RespondHandoffRequest {
                    outcome: HandoffOutcome::Cancelled,
                    ..Default::default()
                },
            )
            .unwrap();
        assert_eq!(v.status, HandoffStatus::Cancelled);
        assert_eq!(v.response.unwrap().outcome, HandoffOutcome::Cancelled);
    }

    #[tokio::test]
    async fn multi_choice_and_number_answers() {
        let (s, sess) = setup();
        let (h, _) = s
            .create_handoff(sess, req(HandoffInput::MultiChoice))
            .unwrap();
        let pick = |vs: &[&str]| RespondHandoffRequest {
            values: Some(vs.iter().map(|v| v.to_string()).collect()),
            ..Default::default()
        };
        assert!(s
            .respond_handoff(h.id, Responder::Operator, pick(&["Yes", "Yes"]))
            .is_err());
        assert!(s
            .respond_handoff(h.id, Responder::Operator, pick(&[]))
            .is_err());
        let r = s
            .respond_handoff(h.id, Responder::Operator, pick(&["No", "Yes"]))
            .unwrap()
            .response
            .unwrap();
        assert_eq!(r.values, Some(vec!["No".to_string(), "Yes".to_string()]));
        assert_eq!(r.value, None);

        let mut n = req(HandoffInput::Number);
        n.constraints.step = Some(0.5);
        let (h, _) = s.create_handoff(sess, n).unwrap();
        assert!(s
            .respond_handoff(h.id, Responder::Operator, answer(Some("1.2"), None))
            .is_err());
        let r = s
            .respond_handoff(h.id, Responder::Operator, answer(Some("01.50"), None))
            .unwrap()
            .response
            .unwrap();
        assert_eq!(r.value.as_deref(), Some("1.5"));
    }

    #[test]
    fn import_fills_outcome_and_answered_at_of_old_records() {
        // A cancelled and a completed handoff as saved before typed questions.
        let old = |status: &str| {
            serde_json::json!({
                "view": {
                    "id": Uuid::new_v4(), "session_id": Uuid::nil(), "host_id": Uuid::nil(),
                    "kind": "confirmation", "prompt": "Go?", "input": "choice",
                    "choices": ["Yes, continue", "No"], "status": status,
                    "created_at": "2026-01-01T00:00:00Z", "expires_at": "2026-01-01T00:10:00Z",
                    "resolved_at": "2026-01-01T00:01:00Z",
                    "response": {"value": "Yes, continue", "value_withheld": false, "channel": "web-form"}
                },
                "token_digest": null
            })
        };
        let records: Vec<HandoffRecord> =
            serde_json::from_value(serde_json::json!([old("cancelled"), old("completed")]))
                .unwrap();
        let ids: Vec<Uuid> = records.iter().map(|r| r.view.id).collect();
        let s = RuntimeStore::new();
        RuntimeStore::import_handoffs(&mut s.lock(), records);
        let c = s.get_handoff(ids[0]).unwrap();
        assert_eq!(c.response.unwrap().outcome, HandoffOutcome::Cancelled);
        let d = s.get_handoff(ids[1]).unwrap();
        assert_eq!(d.choices[0].id, "Yes, continue");
        assert_eq!(d.choices[0].label, "Yes, continue");
        let r = d.response.unwrap();
        assert_eq!(r.outcome, HandoffOutcome::Completed);
        assert_eq!(r.answered_at, d.resolved_at);
        assert_eq!(r.by, None);
    }
}
