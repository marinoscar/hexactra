//! In-memory state for remote browser control: hosts, sessions and the
//! operation queue.
//!
//! State is process-local by design for the first vertical slice (#175): a
//! restart drops sessions and in-flight operations, and callers see them as
//! not found. Durable sessions and audit are follow-up work on epic #173.

use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use chrono::{DateTime, Utc};
use hexactra_core::remote::{
    DispatchedOperation, HostView, OperationResult, OperationState, OperationView, RemoteAction,
    RemoteSessionStatus, SessionView,
};
use tokio::sync::{watch, Notify};
use uuid::Uuid;

/// A host counts as online if it polled within this window.
pub const HOST_ONLINE_WINDOW: Duration = Duration::from_secs(45);
/// Terminal operations older than this are pruned.
const OPERATION_RETENTION: Duration = Duration::from_secs(15 * 60);
/// Prune when the operation map grows past this size.
const PRUNE_THRESHOLD: usize = 1_000;

/// Errors raised by the store; mapped to HTTP statuses by the API layer.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum StoreError {
    #[error("{0} not found")]
    NotFound(&'static str),
    #[error("{0}")]
    Conflict(String),
    #[error("no online host with a connected browser")]
    NoHostAvailable,
}

struct HostEntry {
    name: String,
    version: String,
    last_seen: DateTime<Utc>,
    browser_connected: bool,
    queue: VecDeque<Uuid>,
    notify: Arc<Notify>,
}

struct OperationEntry {
    view: OperationView,
    deadline: DateTime<Utc>,
    tx: watch::Sender<OperationState>,
}

#[derive(Default)]
struct Inner {
    hosts: HashMap<Uuid, HostEntry>,
    sessions: HashMap<Uuid, SessionView>,
    operations: HashMap<Uuid, OperationEntry>,
}

/// Shared runtime store.
#[derive(Clone, Default)]
pub struct RuntimeStore {
    inner: Arc<Mutex<Inner>>,
}

fn host_view(id: Uuid, h: &HostEntry, now: DateTime<Utc>) -> HostView {
    let online = now
        .signed_duration_since(h.last_seen)
        .to_std()
        .map(|d| d <= HOST_ONLINE_WINDOW)
        .unwrap_or(true);
    HostView {
        id,
        name: h.name.clone(),
        version: h.version.clone(),
        online,
        browser_connected: online && h.browser_connected,
        last_seen: h.last_seen,
    }
}

impl RuntimeStore {
    pub fn new() -> Self {
        Self::default()
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        // A poisoned lock means a panic mid-update; the maps are still
        // structurally valid, so keep serving.
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    // ---------------------------------------------------------------- hosts

    /// Register (or re-register) a host agent.
    pub fn register_host(&self, requested: Option<Uuid>, name: String, version: String) -> Uuid {
        let mut inner = self.lock();
        let id = requested.unwrap_or_else(Uuid::new_v4);
        let now = Utc::now();
        match inner.hosts.get_mut(&id) {
            Some(h) => {
                h.name = name;
                h.version = version;
                h.last_seen = now;
            }
            None => {
                inner.hosts.insert(
                    id,
                    HostEntry {
                        name,
                        version,
                        last_seen: now,
                        browser_connected: false,
                        queue: VecDeque::new(),
                        notify: Arc::new(Notify::new()),
                    },
                );
            }
        }
        id
    }

    pub fn list_hosts(&self) -> Vec<HostView> {
        let inner = self.lock();
        let now = Utc::now();
        let mut v: Vec<_> = inner
            .hosts
            .iter()
            .map(|(id, h)| host_view(*id, h, now))
            .collect();
        v.sort_by_key(|h| std::cmp::Reverse(h.last_seen));
        v
    }

    /// Long-poll for the next operation for a host. Returns `Ok(None)` when
    /// nothing arrived within `wait`.
    pub async fn next_operation(
        &self,
        host_id: Uuid,
        browser_connected: bool,
        wait: Duration,
    ) -> Result<Option<DispatchedOperation>, StoreError> {
        let deadline = tokio::time::Instant::now() + wait;
        loop {
            let notify = {
                let mut inner = self.lock();
                let now = Utc::now();
                let host = inner
                    .hosts
                    .get_mut(&host_id)
                    .ok_or(StoreError::NotFound("host"))?;
                host.last_seen = now;
                host.browser_connected = browser_connected;
                let notify = host.notify.clone();
                let mut queue = std::mem::take(&mut host.queue);
                let mut found = None;
                while let Some(op_id) = queue.pop_front() {
                    if let Some(op) = inner.operations.get_mut(&op_id) {
                        if op.view.state == OperationState::Queued {
                            op.view.state = OperationState::Dispatched;
                            let _ = op.tx.send(OperationState::Dispatched);
                            found = Some(DispatchedOperation {
                                id: op.view.id,
                                session_id: op.view.session_id,
                                action: op.view.action.clone(),
                                deadline: op.deadline,
                            });
                            break;
                        }
                    }
                }
                if let Some(host) = inner.hosts.get_mut(&host_id) {
                    host.queue = queue;
                }
                if found.is_some() {
                    return Ok(found);
                }
                notify
            };
            let notified = notify.notified();
            if tokio::time::timeout_at(deadline, notified).await.is_err() {
                return Ok(None);
            }
        }
    }

    // ------------------------------------------------------------- sessions

    pub fn create_session(
        &self,
        host_id: Option<Uuid>,
        label: Option<String>,
    ) -> Result<SessionView, StoreError> {
        let mut inner = self.lock();
        let now = Utc::now();
        let host_id = match host_id {
            Some(id) => {
                if !inner.hosts.contains_key(&id) {
                    return Err(StoreError::NotFound("host"));
                }
                id
            }
            None => inner
                .hosts
                .iter()
                .map(|(id, h)| host_view(*id, h, now))
                .filter(|h| h.browser_connected)
                .max_by_key(|h| h.last_seen)
                .map(|h| h.id)
                .ok_or(StoreError::NoHostAvailable)?,
        };
        let session = SessionView {
            id: Uuid::new_v4(),
            host_id,
            status: RemoteSessionStatus::Active,
            label,
            created_at: now,
            ended_at: None,
        };
        inner.sessions.insert(session.id, session.clone());
        Ok(session)
    }

    pub fn get_session(&self, id: Uuid) -> Result<SessionView, StoreError> {
        self.lock()
            .sessions
            .get(&id)
            .cloned()
            .ok_or(StoreError::NotFound("session"))
    }

    pub fn list_sessions(&self) -> Vec<SessionView> {
        let mut v: Vec<_> = self.lock().sessions.values().cloned().collect();
        v.sort_by_key(|s| std::cmp::Reverse(s.created_at));
        v
    }

    /// End a session and cancel its queued operations.
    pub fn end_session(&self, id: Uuid) -> Result<SessionView, StoreError> {
        let mut inner = self.lock();
        let now = Utc::now();
        let session = inner
            .sessions
            .get_mut(&id)
            .ok_or(StoreError::NotFound("session"))?;
        if session.status == RemoteSessionStatus::Active {
            session.status = RemoteSessionStatus::Ended;
            session.ended_at = Some(now);
        }
        let ended = session.clone();
        for op in inner.operations.values_mut() {
            if op.view.session_id == id && op.view.state == OperationState::Queued {
                op.view.state = OperationState::Cancelled;
                op.view.error = Some("session ended".into());
                op.view.completed_at = Some(now);
                let _ = op.tx.send(OperationState::Cancelled);
            }
        }
        Ok(ended)
    }

    // ----------------------------------------------------------- operations

    /// Queue an action for a session's host.
    pub fn enqueue(
        &self,
        session_id: Uuid,
        action: RemoteAction,
        timeout: Duration,
    ) -> Result<(OperationView, watch::Receiver<OperationState>), StoreError> {
        let mut inner = self.lock();
        let session = inner
            .sessions
            .get(&session_id)
            .ok_or(StoreError::NotFound("session"))?;
        if session.status != RemoteSessionStatus::Active {
            return Err(StoreError::Conflict("session has ended".into()));
        }
        let host_id = session.host_id;
        let now = Utc::now();
        let deadline = now + chrono::Duration::from_std(timeout).unwrap_or_default();
        let view = OperationView {
            id: Uuid::new_v4(),
            session_id,
            host_id,
            action,
            state: OperationState::Queued,
            result: None,
            error: None,
            created_at: now,
            completed_at: None,
        };
        let (tx, rx) = watch::channel(OperationState::Queued);
        inner.operations.insert(
            view.id,
            OperationEntry {
                view: view.clone(),
                deadline,
                tx,
            },
        );
        let host = inner
            .hosts
            .get_mut(&host_id)
            .ok_or(StoreError::NotFound("host"))?;
        host.queue.push_back(view.id);
        host.notify.notify_one();
        if inner.operations.len() > PRUNE_THRESHOLD {
            Self::prune(&mut inner, now);
        }
        Ok((view, rx))
    }

    fn prune(inner: &mut Inner, now: DateTime<Utc>) {
        let keep = chrono::Duration::from_std(OPERATION_RETENTION).unwrap_or_default();
        inner.operations.retain(|_, op| {
            !op.view.state.is_terminal()
                || op
                    .view
                    .completed_at
                    .map(|t| now.signed_duration_since(t) < keep)
                    .unwrap_or(true)
        });
    }

    pub fn get_operation(&self, id: Uuid) -> Result<OperationView, StoreError> {
        self.lock()
            .operations
            .get(&id)
            .map(|o| o.view.clone())
            .ok_or(StoreError::NotFound("operation"))
    }

    pub fn subscribe(&self, id: Uuid) -> Result<watch::Receiver<OperationState>, StoreError> {
        self.lock()
            .operations
            .get(&id)
            .map(|o| o.tx.subscribe())
            .ok_or(StoreError::NotFound("operation"))
    }

    /// Record a host's result. Only the host the operation was dispatched to
    /// may report it, and only once.
    pub fn complete(
        &self,
        host_id: Uuid,
        op_id: Uuid,
        result: OperationResult,
    ) -> Result<OperationView, StoreError> {
        let mut inner = self.lock();
        let op = inner
            .operations
            .get_mut(&op_id)
            .ok_or(StoreError::NotFound("operation"))?;
        if op.view.host_id != host_id {
            return Err(StoreError::NotFound("operation"));
        }
        if op.view.state != OperationState::Dispatched {
            return Err(StoreError::Conflict(format!(
                "operation is {:?}, not dispatched",
                op.view.state
            )));
        }
        let state = if result.ok {
            OperationState::Succeeded
        } else {
            OperationState::Failed
        };
        op.view.state = state;
        op.view.result = result.result;
        op.view.error = if result.ok {
            None
        } else {
            Some(result.error.unwrap_or_else(|| "action failed".into()))
        };
        op.view.completed_at = Some(Utc::now());
        let _ = op.tx.send(state);
        Ok(op.view.clone())
    }

    /// Mark an operation timed out if it is still pending.
    pub fn time_out(&self, op_id: Uuid) -> Option<OperationView> {
        let mut inner = self.lock();
        let op = inner.operations.get_mut(&op_id)?;
        if !op.view.state.is_terminal() {
            let was_dispatched = op.view.state == OperationState::Dispatched;
            op.view.state = OperationState::TimedOut;
            op.view.error = Some(if was_dispatched {
                "host did not report a result in time; the action may have run".into()
            } else {
                "no host picked up the action in time; it did not run".into()
            });
            op.view.completed_at = Some(Utc::now());
            let _ = op.tx.send(OperationState::TimedOut);
        }
        Some(op.view.clone())
    }

    /// Wait until an operation is terminal or `wait` elapses; on expiry the
    /// operation is marked timed out when `expire` is true.
    pub async fn wait_for(
        &self,
        op_id: Uuid,
        mut rx: watch::Receiver<OperationState>,
        wait: Duration,
        expire: bool,
    ) -> Result<OperationView, StoreError> {
        let finished = tokio::time::timeout(wait, async {
            loop {
                if rx.borrow_and_update().is_terminal() {
                    return;
                }
                if rx.changed().await.is_err() {
                    return;
                }
            }
        })
        .await
        .is_ok();
        if !finished && expire {
            return self
                .time_out(op_id)
                .ok_or(StoreError::NotFound("operation"));
        }
        self.get_operation(op_id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn nav() -> RemoteAction {
        RemoteAction::Navigate {
            url: "https://example.test".into(),
            tab_id: None,
        }
    }

    #[tokio::test]
    async fn session_requires_connected_host() {
        let s = RuntimeStore::new();
        assert_eq!(
            s.create_session(None, None).unwrap_err(),
            StoreError::NoHostAvailable
        );
        let h = s.register_host(None, "h".into(), "0".into());
        // Registered but browser not connected yet.
        assert!(s.create_session(None, None).is_err());
        assert!(s
            .next_operation(h, true, Duration::from_millis(1))
            .await
            .unwrap()
            .is_none());
        assert_eq!(s.create_session(None, None).unwrap().host_id, h);
    }

    #[tokio::test]
    async fn operation_round_trip() {
        let s = RuntimeStore::new();
        let h = s.register_host(None, "h".into(), "0".into());
        let sess = s.create_session(Some(h), None).unwrap();
        let (op, rx) = s.enqueue(sess.id, nav(), Duration::from_secs(5)).unwrap();
        let s2 = s.clone();
        let host = tokio::spawn(async move {
            let d = s2
                .next_operation(h, true, Duration::from_secs(5))
                .await
                .unwrap()
                .unwrap();
            s2.complete(
                h,
                d.id,
                OperationResult {
                    ok: true,
                    result: Some(serde_json::json!({"url": "https://example.test/"})),
                    error: None,
                },
            )
            .unwrap();
        });
        let done = s
            .wait_for(op.id, rx, Duration::from_secs(5), true)
            .await
            .unwrap();
        host.await.unwrap();
        assert_eq!(done.state, OperationState::Succeeded);
        assert!(done.result.is_some());
        // Second report is refused.
        assert!(matches!(
            s.complete(
                h,
                op.id,
                OperationResult {
                    ok: true,
                    result: None,
                    error: None
                }
            ),
            Err(StoreError::Conflict(_))
        ));
    }

    #[tokio::test]
    async fn queued_operation_times_out_and_is_not_dispatched() {
        let s = RuntimeStore::new();
        let h = s.register_host(None, "h".into(), "0".into());
        let sess = s.create_session(Some(h), None).unwrap();
        let (op, rx) = s
            .enqueue(sess.id, nav(), Duration::from_millis(20))
            .unwrap();
        let done = s
            .wait_for(op.id, rx, Duration::from_millis(20), true)
            .await
            .unwrap();
        assert_eq!(done.state, OperationState::TimedOut);
        assert!(s
            .next_operation(h, true, Duration::from_millis(1))
            .await
            .unwrap()
            .is_none());
    }

    #[tokio::test]
    async fn other_host_cannot_report() {
        let s = RuntimeStore::new();
        let h = s.register_host(None, "h".into(), "0".into());
        let other = s.register_host(None, "o".into(), "0".into());
        let sess = s.create_session(Some(h), None).unwrap();
        let (op, _rx) = s.enqueue(sess.id, nav(), Duration::from_secs(5)).unwrap();
        s.next_operation(h, true, Duration::from_millis(1))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            s.complete(
                other,
                op.id,
                OperationResult {
                    ok: true,
                    result: None,
                    error: None
                }
            )
            .unwrap_err(),
            StoreError::NotFound("operation")
        );
    }

    #[tokio::test]
    async fn ending_session_cancels_queue() {
        let s = RuntimeStore::new();
        let h = s.register_host(None, "h".into(), "0".into());
        let sess = s.create_session(Some(h), None).unwrap();
        let (op, _rx) = s.enqueue(sess.id, nav(), Duration::from_secs(5)).unwrap();
        s.end_session(sess.id).unwrap();
        assert_eq!(
            s.get_operation(op.id).unwrap().state,
            OperationState::Cancelled
        );
        assert!(matches!(
            s.enqueue(sess.id, nav(), Duration::from_secs(1)),
            Err(StoreError::Conflict(_))
        ));
    }
}
