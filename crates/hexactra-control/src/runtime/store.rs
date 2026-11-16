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
    valid_profile_name, DispatchedOperation, HostMode, HostView, HostWork, OperationResult,
    OperationState, OperationView, RemoteAction, RemoteSessionStatus, SessionView, DEFAULT_PROFILE,
    REDACTED_TEXT,
};
use serde::{Deserialize, Serialize};
use serde_json::json;
use tokio::sync::{broadcast, watch, Notify};
use uuid::Uuid;
use zeroize::Zeroizing;

use super::handoff::{HandoffEntry, RuntimeEvent};

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
    #[error("session is waiting for a human (handoff {0}); resolve or cancel it first")]
    HandoffPending(Uuid),
    #[error("{0}")]
    Invalid(String),
    #[error("invalid or already used response token")]
    Forbidden,
    #[error(
        "profile {0:?} not found on any online host; create it with --create (create_profile)"
    )]
    ProfileNotFound(String),
    /// The request is well formed but cannot apply (machine code, message).
    #[error("{1}")]
    Unprocessable(&'static str, String),
    /// A handoff's secret is not available: not answered, already used,
    /// erased or expired.
    #[error("{0}")]
    SecretUnavailable(String),
}

pub(super) struct HostEntry {
    name: String,
    version: String,
    last_seen: DateTime<Utc>,
    browser_connected: bool,
    on_demand: bool,
    pub(super) viewer_url: Option<String>,
    pub(super) mode: Option<HostMode>,
    pub(super) desktop: bool,
    /// Profiles the host reported; empty means a host that only knows the
    /// default profile (older agents).
    pub(super) profiles: Vec<String>,
    pub(super) running_profiles: Vec<String>,
    queue: VecDeque<Uuid>,
    pub(super) notify: Arc<Notify>,
    /// No new sessions are placed here (#213).
    pub(super) draining: bool,
    /// The agent polls with `commands=true` and can run host commands.
    pub(super) accepts_commands: bool,
    pub(super) command_queue: VecDeque<Uuid>,
}

struct OperationEntry {
    view: OperationView,
    deadline: DateTime<Utc>,
    tx: watch::Sender<OperationState>,
    /// Keep screenshot bytes inline in the result as well (migration flag).
    inline_artifacts: bool,
    /// Trace context of the request that queued it (#215).
    traceparent: Option<String>,
    /// Text of a `type_secret` or sensitive `type` action, held apart from
    /// the view (which shows `[secret]`) until the host takes it, and
    /// dropped (zeroed) when the operation ends without being dispatched.
    secret_text: Option<Zeroizing<String>>,
}

/// The action a host runs: `type_secret` and sensitive `type` actions get
/// their real text back, as a plain `type`.
fn host_action(view: &RemoteAction, secret: Option<Zeroizing<String>>) -> RemoteAction {
    let Some(text) = secret else {
        return view.clone();
    };
    match view {
        RemoteAction::TypeSecret {
            selector,
            clear,
            submit,
            tab_id,
            ..
        }
        | RemoteAction::Type {
            selector,
            clear,
            submit,
            tab_id,
            ..
        } => RemoteAction::Type {
            selector: selector.clone(),
            text: String::clone(&text),
            clear: *clear,
            submit: *submit,
            sensitive: true,
            tab_id: *tab_id,
        },
        other => other.clone(),
    }
}

#[derive(Default)]
pub(super) struct Inner {
    pub(super) hosts: HashMap<Uuid, HostEntry>,
    pub(super) sessions: HashMap<Uuid, SessionView>,
    operations: HashMap<Uuid, OperationEntry>,
    pub(super) handoffs: HashMap<Uuid, HandoffEntry>,
    pub(super) commands: HashMap<Uuid, super::host_commands::CommandEntry>,
}

#[cfg(test)]
impl Inner {
    /// Whether an operation still holds secret text (None: unknown op).
    pub(super) fn operations_secret_held(&self, id: Uuid) -> Option<bool> {
        self.operations.get(&id).map(|o| o.secret_text.is_some())
    }
}

/// A host as persisted (no queue, no connection state).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct HostRecord {
    pub id: Uuid,
    pub name: String,
    pub version: String,
    pub last_seen: DateTime<Utc>,
    pub on_demand: bool,
    pub viewer_url: Option<String>,
    #[serde(default)]
    pub mode: Option<HostMode>,
    #[serde(default)]
    pub desktop: bool,
    pub profiles: Vec<String>,
    #[serde(default)]
    pub draining: bool,
}

/// Everything the store persists (#211). Operations are not persisted:
/// they are short-lived, and an operation in flight at a restart is
/// reported as timed out by the waiting caller anyway. Typed text and
/// screenshots therefore never reach disk.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub(crate) struct StoreSnapshot {
    pub hosts: Vec<HostRecord>,
    pub sessions: Vec<SessionView>,
    pub handoffs: Vec<super::handoff::HandoffRecord>,
}

/// Ended sessions older than this are not kept across restarts.
const ENDED_SESSION_RETENTION_DAYS: i64 = 7;

/// Shared runtime store.
#[derive(Clone)]
pub struct RuntimeStore {
    inner: Arc<Mutex<Inner>>,
    pub(super) events: broadcast::Sender<RuntimeEvent>,
    /// Content-free event log for `GET /v1/events`.
    pub log: super::events::EventLog,
    /// Screenshot bytes, served by handle (#214).
    pub artifacts: super::artifacts::ArtifactStore,
}

impl Default for RuntimeStore {
    fn default() -> Self {
        let (events, _) = broadcast::channel(256);
        Self {
            inner: Arc::new(Mutex::new(Inner::default())),
            events,
            log: Default::default(),
            artifacts: Default::default(),
        }
    }
}

/// Content-free operation event payload (no action arguments).
fn op_event(v: &OperationView) -> serde_json::Value {
    json!({
        "op_id": v.id,
        "session_id": v.session_id,
        "host_id": v.host_id,
        "kind": v.action.kind(),
        "state": v.state,
        "error": v.error,
    })
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
        on_demand: online && h.on_demand,
        viewer_url: h.viewer_url.clone(),
        mode: h.mode,
        desktop: h.desktop,
        profiles: h.known_profiles(),
        running_profiles: h.running_profiles.clone(),
        draining: h.draining,
        last_seen: h.last_seen,
    }
}

impl HostEntry {
    fn known_profiles(&self) -> Vec<String> {
        if self.profiles.is_empty() {
            vec![DEFAULT_PROFILE.to_string()]
        } else {
            self.profiles.clone()
        }
    }

    fn has_profile(&self, p: &str) -> bool {
        self.known_profiles().iter().any(|x| x == p)
    }
}

impl RuntimeStore {
    pub fn new() -> Self {
        Self::default()
    }

    /// Snapshot for persistence.
    pub(super) fn export_snapshot(&self) -> StoreSnapshot {
        let inner = self.lock();
        let cutoff = Utc::now() - chrono::Duration::days(ENDED_SESSION_RETENTION_DAYS);
        let mut hosts: Vec<HostRecord> = inner
            .hosts
            .iter()
            .map(|(id, h)| HostRecord {
                id: *id,
                name: h.name.clone(),
                version: h.version.clone(),
                last_seen: h.last_seen,
                on_demand: h.on_demand,
                viewer_url: h.viewer_url.clone(),
                mode: h.mode,
                desktop: h.desktop,
                profiles: h.profiles.clone(),
                draining: h.draining,
            })
            .collect();
        hosts.sort_by_key(|h| h.id);
        let mut sessions: Vec<SessionView> = inner
            .sessions
            .values()
            .filter(|s| {
                s.status == RemoteSessionStatus::Active
                    || s.ended_at.map(|t| t > cutoff).unwrap_or(true)
            })
            .cloned()
            .collect();
        sessions.sort_by_key(|s| s.id);
        let handoffs = Self::export_handoffs(&inner);
        StoreSnapshot {
            hosts,
            sessions,
            handoffs,
        }
    }

    /// Restore from a snapshot (at startup, before serving). Hosts come back
    /// offline until they poll again; pending handoffs keep their expiry.
    pub(super) fn import_snapshot(&self, snap: StoreSnapshot) {
        let pending = {
            let mut inner = self.lock();
            for h in snap.hosts {
                inner.hosts.insert(
                    h.id,
                    HostEntry {
                        name: h.name,
                        version: h.version,
                        last_seen: h.last_seen,
                        browser_connected: false,
                        on_demand: h.on_demand,
                        viewer_url: h.viewer_url,
                        mode: h.mode,
                        desktop: h.desktop,
                        profiles: h.profiles,
                        running_profiles: Vec::new(),
                        queue: VecDeque::new(),
                        notify: Arc::new(Notify::new()),
                        draining: h.draining,
                        accepts_commands: false,
                        command_queue: VecDeque::new(),
                    },
                );
            }
            for s in snap.sessions {
                inner.sessions.insert(s.id, s);
            }
            Self::import_handoffs(&mut inner, snap.handoffs)
        };
        for (id, expires_at) in pending {
            self.schedule_handoff_expiry(id, expires_at);
        }
    }

    pub(super) fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
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
                // A re-registering agent has a fresh bridge; it reports the
                // browser as connected on its next poll.
                h.browser_connected = false;
                h.on_demand = false;
            }
            None => {
                inner.hosts.insert(
                    id,
                    HostEntry {
                        name,
                        version,
                        last_seen: now,
                        browser_connected: false,
                        on_demand: false,
                        viewer_url: None,
                        mode: None,
                        desktop: false,
                        profiles: Vec::new(),
                        running_profiles: Vec::new(),
                        queue: VecDeque::new(),
                        notify: Arc::new(Notify::new()),
                        draining: false,
                        accepts_commands: false,
                        command_queue: VecDeque::new(),
                    },
                );
            }
        }
        drop(inner);
        self.log.emit("host.registered", json!({ "host_id": id }));
        id
    }

    /// Remove a host: its sessions end and queued work is cancelled.
    /// Returns false if the host was unknown.
    pub fn remove_host(&self, id: Uuid) -> bool {
        let sessions: Vec<Uuid> = {
            let mut inner = self.lock();
            if inner.hosts.remove(&id).is_none() {
                return false;
            }
            self.log.emit("host.removed", json!({ "host_id": id }));
            inner
                .sessions
                .values()
                .filter(|s| s.host_id == id && s.status == RemoteSessionStatus::Active)
                .map(|s| s.id)
                .collect()
        };
        for s in sessions {
            let _ = self.end_session(s);
        }
        true
    }

    /// Mark a host offline now (it announced shutdown). Its next poll or
    /// registration brings it back.
    pub fn set_host_offline(&self, id: Uuid) -> Result<(), StoreError> {
        let mut inner = self.lock();
        let h = inner
            .hosts
            .get_mut(&id)
            .ok_or(StoreError::NotFound("host"))?;
        h.last_seen = DateTime::<Utc>::UNIX_EPOCH;
        h.browser_connected = false;
        h.running_profiles.clear();
        self.log.emit("host.offline", json!({ "host_id": id }));
        Ok(())
    }

    /// Record a host's viewer URL (from registration).
    pub fn set_host_viewer_url(&self, id: Uuid, url: Option<String>) -> Result<(), StoreError> {
        let mut inner = self.lock();
        let h = inner
            .hosts
            .get_mut(&id)
            .ok_or(StoreError::NotFound("host"))?;
        h.viewer_url = url;
        Ok(())
    }

    /// Record how a host runs and whether it can share its desktop (from
    /// registration; an older agent reports neither).
    pub fn set_host_mode(
        &self,
        id: Uuid,
        mode: Option<HostMode>,
        desktop: bool,
    ) -> Result<(), StoreError> {
        let mut inner = self.lock();
        let h = inner
            .hosts
            .get_mut(&id)
            .ok_or(StoreError::NotFound("host"))?;
        h.mode = mode;
        h.desktop = desktop;
        Ok(())
    }

    /// Record whether a host launches its browser on demand (from polls).
    pub fn set_host_on_demand(&self, id: Uuid, on_demand: bool) -> Result<(), StoreError> {
        let mut inner = self.lock();
        let h = inner
            .hosts
            .get_mut(&id)
            .ok_or(StoreError::NotFound("host"))?;
        h.on_demand = on_demand;
        Ok(())
    }

    /// Record the profiles a host has and which are running (from polls).
    pub fn set_host_profiles(
        &self,
        id: Uuid,
        profiles: Vec<String>,
        running: Vec<String>,
    ) -> Result<(), StoreError> {
        let clean = |v: Vec<String>| -> Vec<String> {
            let mut v: Vec<String> = v
                .into_iter()
                .filter(|p| valid_profile_name(p))
                .take(100)
                .collect();
            v.sort();
            v.dedup();
            v
        };
        let mut inner = self.lock();
        let h = inner
            .hosts
            .get_mut(&id)
            .ok_or(StoreError::NotFound("host"))?;
        h.profiles = clean(profiles);
        h.running_profiles = clean(running);
        Ok(())
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
        Ok(
            match self
                .next_work(host_id, browser_connected, false, wait)
                .await?
            {
                Some(HostWork::Operation(op)) => Some(op),
                _ => None,
            },
        )
    }

    /// Long-poll for the next operation or, when the agent accepts them,
    /// host command (commands first).
    pub async fn next_work(
        &self,
        host_id: Uuid,
        browser_connected: bool,
        accepts_commands: bool,
        wait: Duration,
    ) -> Result<Option<HostWork>, StoreError> {
        let deadline = tokio::time::Instant::now() + wait;
        loop {
            let notify = {
                let mut inner = self.lock();
                let now = Utc::now();
                let host = inner
                    .hosts
                    .get_mut(&host_id)
                    .ok_or(StoreError::NotFound("host"))?;
                let was_online = now
                    .signed_duration_since(host.last_seen)
                    .to_std()
                    .map(|d| d <= HOST_ONLINE_WINDOW)
                    .unwrap_or(true);
                let browser_changed = host.browser_connected != browser_connected;
                host.last_seen = now;
                host.browser_connected = browser_connected;
                host.accepts_commands = accepts_commands;
                let notify = host.notify.clone();
                if !was_online {
                    self.log.emit("host.online", json!({ "host_id": host_id }));
                }
                if browser_changed {
                    self.log.emit(
                        "host.browser",
                        json!({ "host_id": host_id, "connected": browser_connected }),
                    );
                }
                if accepts_commands {
                    if let Some(cmd) = Self::dispatch_next_command(&mut inner, host_id, &self.log) {
                        return Ok(Some(HostWork::Command { command: cmd }));
                    }
                }
                let host = inner
                    .hosts
                    .get_mut(&host_id)
                    .ok_or(StoreError::NotFound("host"))?;
                let mut queue = std::mem::take(&mut host.queue);
                let mut found = None;
                while let Some(op_id) = queue.pop_front() {
                    let queued_session = inner
                        .operations
                        .get(&op_id)
                        .filter(|op| op.view.state == OperationState::Queued)
                        .map(|op| op.view.session_id);
                    if let Some(session_id) = queued_session {
                        {
                            let profile = inner
                                .sessions
                                .get(&session_id)
                                .map(|s| s.profile.clone())
                                .unwrap_or_else(|| DEFAULT_PROFILE.to_string());
                            let op = inner.operations.get_mut(&op_id).expect("checked above");
                            op.view.state = OperationState::Dispatched;
                            let _ = op.tx.send(OperationState::Dispatched);
                            self.log.emit("operation.dispatched", op_event(&op.view));
                            found = Some(DispatchedOperation {
                                id: op.view.id,
                                session_id: op.view.session_id,
                                profile,
                                action: host_action(&op.view.action, op.secret_text.take()),
                                deadline: op.deadline,
                                traceparent: op.traceparent.clone(),
                            });
                            break;
                        }
                    }
                }
                if let Some(host) = inner.hosts.get_mut(&host_id) {
                    host.queue = queue;
                }
                if let Some(op) = found {
                    return Ok(Some(HostWork::Operation(op)));
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

    /// Create a session on the default profile.
    pub fn create_session(
        &self,
        host_id: Option<Uuid>,
        label: Option<String>,
    ) -> Result<SessionView, StoreError> {
        self.create_session_for(host_id, label, None, false)
    }

    /// Create a session on a profile. Without `host_id`, picks an online host
    /// that has the profile (preferring one where it is running); with
    /// `create_profile`, an on-demand host may create it.
    pub fn create_session_for(
        &self,
        host_id: Option<Uuid>,
        label: Option<String>,
        profile: Option<String>,
        create_profile: bool,
    ) -> Result<SessionView, StoreError> {
        let profile = profile.unwrap_or_else(|| DEFAULT_PROFILE.to_string());
        if !valid_profile_name(&profile) {
            return Err(StoreError::Invalid(
                "profile names are 1-32 characters: lowercase letters, digits, '-' and '_'".into(),
            ));
        }
        let mut inner = self.lock();
        let now = Utc::now();
        let host_id = match host_id {
            Some(id) => {
                let h = inner.hosts.get(&id).ok_or(StoreError::NotFound("host"))?;
                if h.draining {
                    return Err(StoreError::Conflict(
                        "host is draining: it takes no new sessions (undrain it first)".into(),
                    ));
                }
                if !h.has_profile(&profile) {
                    let on_demand = host_view(id, h, now).on_demand;
                    if !create_profile {
                        return Err(StoreError::ProfileNotFound(profile));
                    }
                    if !on_demand {
                        return Err(StoreError::Invalid(
                            "this host attaches to a browser you run; it cannot create profiles"
                                .into(),
                        ));
                    }
                }
                id
            }
            None => {
                let usable: Vec<(HostView, bool, bool)> = inner
                    .hosts
                    .iter()
                    .map(|(id, h)| {
                        (
                            host_view(*id, h, now),
                            h.has_profile(&profile),
                            h.running_profiles.iter().any(|r| r == &profile),
                        )
                    })
                    .filter(|(v, _, _)| (v.browser_connected || v.on_demand) && !v.draining)
                    .collect();
                if usable.is_empty() {
                    return Err(StoreError::NoHostAvailable);
                }
                // Spread sessions: among hosts with the profile (running ones
                // first), the one with the fewest active sessions, then the
                // most recently seen. Without the load term every session of a
                // profile landed on one host (scripts/load/fabric-load.mjs).
                let mut load: HashMap<Uuid, usize> = HashMap::new();
                for s in inner.sessions.values() {
                    if s.status == RemoteSessionStatus::Active {
                        *load.entry(s.host_id).or_default() += 1;
                    }
                }
                let with = usable
                    .iter()
                    .filter(|(_, has, _)| *has)
                    .max_by_key(|(v, _, running)| {
                        (
                            *running,
                            std::cmp::Reverse(load.get(&v.id).copied().unwrap_or(0)),
                            v.last_seen,
                        )
                    })
                    .map(|(v, _, _)| v.id);
                match with {
                    Some(id) => id,
                    None if create_profile => usable
                        .iter()
                        .filter(|(v, _, _)| v.on_demand)
                        .max_by_key(|(v, _, _)| v.last_seen)
                        .map(|(v, _, _)| v.id)
                        .ok_or_else(|| {
                            StoreError::Invalid(
                                "no on-demand host is online to create the profile".into(),
                            )
                        })?,
                    None => return Err(StoreError::ProfileNotFound(profile)),
                }
            }
        };
        let session = SessionView {
            id: Uuid::new_v4(),
            host_id,
            profile,
            status: RemoteSessionStatus::Active,
            label,
            created_at: now,
            ended_at: None,
        };
        inner.sessions.insert(session.id, session.clone());
        self.log.emit(
            "session.created",
            json!({ "session_id": session.id, "host_id": session.host_id, "profile": session.profile }),
        );
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
                op.secret_text = None;
                op.view.state = OperationState::Cancelled;
                op.view.error = Some("session ended".into());
                op.view.completed_at = Some(now);
                let _ = op.tx.send(OperationState::Cancelled);
                self.log.emit("operation.cancelled", op_event(&op.view));
            }
        }
        self.log.emit(
            "session.ended",
            json!({ "session_id": id, "host_id": ended.host_id, "profile": ended.profile }),
        );
        let cancelled = Self::cancel_session_handoffs(&mut inner, id, now);
        drop(inner);
        for ev in cancelled {
            self.publish(ev);
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
        self.enqueue_with(session_id, action, timeout, false)
    }

    /// Queue an action; `inline_artifacts` keeps screenshot data in the
    /// result next to the artifact handle.
    ///
    /// A `type_secret` action consumes its handoff's secret here; the text
    /// of it, or of a `type` action with `sensitive: true`, is held apart
    /// from the operation view, which reports it as `[secret]`.
    pub fn enqueue_with(
        &self,
        session_id: Uuid,
        mut action: RemoteAction,
        timeout: Duration,
        inline_artifacts: bool,
    ) -> Result<(OperationView, watch::Receiver<OperationState>), StoreError> {
        let mut secret_text = match &mut action {
            RemoteAction::Type {
                text,
                sensitive: true,
                ..
            } => Some(Zeroizing::new(std::mem::replace(
                text,
                REDACTED_TEXT.to_string(),
            ))),
            _ => None,
        };
        let mut inner = self.lock();
        let session = inner
            .sessions
            .get(&session_id)
            .ok_or(StoreError::NotFound("session"))?;
        if session.status != RemoteSessionStatus::Active {
            return Err(StoreError::Conflict("session has ended".into()));
        }
        if let Some(h) = Self::pending_handoff(&inner, session_id) {
            return Err(StoreError::HandoffPending(h));
        }
        let host_id = session.host_id;
        if !inner.hosts.contains_key(&host_id) {
            return Err(StoreError::NotFound("host"));
        }
        let now = Utc::now();
        // Last check: the secret is consumed only if the action is queued.
        let used_handoff = match &action {
            RemoteAction::TypeSecret { handoff_id, .. } => {
                secret_text = Some(Self::take_handoff_secret(
                    &mut inner,
                    *handoff_id,
                    Some(session_id),
                    now,
                )?);
                Some(*handoff_id)
            }
            _ => None,
        };
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
                inline_artifacts,
                traceparent: hexactra_otel::current_traceparent(),
                secret_text,
            },
        );
        let host = inner
            .hosts
            .get_mut(&host_id)
            .ok_or(StoreError::NotFound("host"))?;
        host.queue.push_back(view.id);
        host.notify.notify_one();
        self.log.emit("operation.queued", op_event(&view));
        if let Some(handoff_id) = used_handoff {
            self.log.emit(
                "handoff.secret_used",
                json!({ "handoff_id": handoff_id, "session_id": session_id, "op_id": view.id }),
            );
        }
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
        op.secret_text = None;
        op.view.state = state;
        op.view.result = result.result;
        if result.ok && matches!(op.view.action, RemoteAction::Screenshot { .. }) {
            if let Some(r) = op.view.result.as_mut() {
                Self::store_screenshot(&self.artifacts, op.view.session_id, r, op.inline_artifacts);
            }
        }
        op.view.error = if result.ok {
            None
        } else {
            Some(result.error.unwrap_or_else(|| "action failed".into()))
        };
        op.view.completed_at = Some(Utc::now());
        let _ = op.tx.send(state);
        super::metrics::operation_finished(&op.view);
        self.log.emit(
            if state == OperationState::Succeeded {
                "operation.succeeded"
            } else {
                "operation.failed"
            },
            op_event(&op.view),
        );
        Ok(op.view.clone())
    }

    /// Move a screenshot's base64 `data` into the artifact store and put a
    /// handle (`artifact_id`, `mime`, `size`) in the result instead.
    fn store_screenshot(
        artifacts: &super::artifacts::ArtifactStore,
        session_id: Uuid,
        result: &mut serde_json::Value,
        inline: bool,
    ) {
        use base64::Engine;
        let Some(data) = result.get("data").and_then(|d| d.as_str()) else {
            return;
        };
        let Ok(bytes) = base64::engine::general_purpose::STANDARD.decode(data) else {
            return;
        };
        let mime = result
            .get("mime")
            .and_then(|m| m.as_str())
            .unwrap_or("image/jpeg")
            .to_string();
        let size = bytes.len();
        let a = artifacts.put(session_id, &mime, bytes);
        if let Some(obj) = result.as_object_mut() {
            if !inline {
                obj.remove("data");
            }
            obj.insert("mime".into(), json!(mime));
            obj.insert("artifact_id".into(), json!(a.id));
            obj.insert("size".into(), json!(size));
            obj.insert("expires_at".into(), json!(a.expires_at));
        }
    }

    /// Mark an operation timed out if it is still pending.
    pub fn time_out(&self, op_id: Uuid) -> Option<OperationView> {
        let mut inner = self.lock();
        let op = inner.operations.get_mut(&op_id)?;
        if !op.view.state.is_terminal() {
            op.secret_text = None;
            let was_dispatched = op.view.state == OperationState::Dispatched;
            op.view.state = OperationState::TimedOut;
            op.view.error = Some(if was_dispatched {
                "host did not report a result in time; the action may have run".into()
            } else {
                "no host picked up the action in time; it did not run".into()
            });
            op.view.completed_at = Some(Utc::now());
            let _ = op.tx.send(OperationState::TimedOut);
            super::metrics::operation_finished(&op.view);
            self.log.emit("operation.timed_out", op_event(&op.view));
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

    #[test]
    fn host_mode_survives_a_snapshot_and_old_records_load() {
        let s = RuntimeStore::new();
        let h = s.register_host(None, "mini-pc".into(), "0".into());
        s.set_host_mode(h, Some(HostMode::Attended), true).unwrap();
        let snap = s.export_snapshot();
        let json = serde_json::to_string(&snap).unwrap();

        let restored = RuntimeStore::new();
        restored.import_snapshot(serde_json::from_str(&json).unwrap());
        let v = &restored.list_hosts()[0];
        assert_eq!(v.mode, Some(HostMode::Attended));
        assert!(v.desktop);

        // A record saved before #336 has neither field.
        let old: HostRecord = serde_json::from_value(json!({
            "id": h, "name": "n", "version": "0", "last_seen": Utc::now(),
            "on_demand": false, "viewer_url": null, "profiles": []
        }))
        .unwrap();
        assert_eq!(old.mode, None);
        assert!(!old.desktop);
        assert_eq!(
            s.set_host_mode(Uuid::new_v4(), None, false).unwrap_err(),
            StoreError::NotFound("host")
        );
    }

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
        // Re-registration clears the browser flag until the next poll.
        s.register_host(Some(h), "h".into(), "0".into());
        assert!(!s.list_hosts()[0].browser_connected);
    }

    #[tokio::test]
    async fn on_demand_host_takes_sessions_while_browser_is_stopped() {
        let s = RuntimeStore::new();
        let h = s.register_host(None, "h".into(), "0".into());
        assert!(s.create_session(None, None).is_err());
        s.set_host_on_demand(h, true).unwrap();
        s.set_host_viewer_url(h, Some("https://viewer.example.test/".into()))
            .unwrap();
        let v = &s.list_hosts()[0];
        assert!(v.on_demand && !v.browser_connected);
        assert_eq!(
            v.viewer_url.as_deref(),
            Some("https://viewer.example.test/")
        );
        assert_eq!(s.create_session(None, None).unwrap().host_id, h);
    }

    #[tokio::test]
    async fn offline_hosts_get_no_sessions() {
        let s = RuntimeStore::new();
        let h = s.register_host(None, "h".into(), "0".into());
        s.next_operation(h, true, Duration::from_millis(1))
            .await
            .unwrap();
        s.set_host_offline(h).unwrap();
        assert!(!s.list_hosts()[0].online);
        assert_eq!(
            s.create_session(None, None).unwrap_err(),
            StoreError::NoHostAvailable
        );
        s.next_operation(h, true, Duration::from_millis(1))
            .await
            .unwrap();
        assert!(s.create_session(None, None).is_ok());
    }

    #[tokio::test]
    async fn sessions_spread_across_hosts_with_the_profile() {
        let s = RuntimeStore::new();
        let hosts: Vec<Uuid> = (0..3)
            .map(|i| s.register_host(None, format!("h{i}"), "0".into()))
            .collect();
        for h in &hosts {
            s.set_host_on_demand(*h, true).unwrap();
            s.set_host_profiles(*h, vec!["work".into()], vec!["work".into()])
                .unwrap();
        }
        let mut per_host: HashMap<Uuid, usize> = HashMap::new();
        for _ in 0..9 {
            let v = s
                .create_session_for(None, None, Some("work".into()), false)
                .unwrap();
            *per_host.entry(v.host_id).or_default() += 1;
        }
        assert_eq!(per_host.len(), 3);
        assert!(per_host.values().all(|n| *n == 3), "{per_host:?}");
        // An ended session frees its slot.
        let first = s.list_sessions()[0].clone();
        s.end_session(first.id).unwrap();
        let next = s
            .create_session_for(None, None, Some("work".into()), false)
            .unwrap();
        assert_eq!(next.host_id, first.host_id);
    }

    #[tokio::test]
    async fn sessions_route_by_profile() {
        let s = RuntimeStore::new();
        // An attach-mode desktop (default profile only) and an on-demand VPS.
        let desktop = s.register_host(None, "desktop".into(), "0".into());
        s.next_operation(desktop, true, Duration::from_millis(1))
            .await
            .unwrap();
        let vps = s.register_host(None, "vps".into(), "0".into());
        s.set_host_on_demand(vps, true).unwrap();
        s.set_host_profiles(
            vps,
            vec!["default".into(), "travel".into(), "Bad/Name".into()],
            vec!["travel".into()],
        )
        .unwrap();
        let v = s.list_hosts().into_iter().find(|h| h.id == vps).unwrap();
        assert_eq!(v.profiles, vec!["default", "travel"]);
        assert_eq!(v.running_profiles, vec!["travel"]);

        let t = s
            .create_session_for(None, None, Some("travel".into()), false)
            .unwrap();
        assert_eq!((t.host_id, t.profile.as_str()), (vps, "travel"));

        // Unknown profile: refused unless created, and only on-demand hosts create.
        assert_eq!(
            s.create_session_for(None, None, Some("work".into()), false)
                .unwrap_err(),
            StoreError::ProfileNotFound("work".into())
        );
        let w = s
            .create_session_for(None, None, Some("work".into()), true)
            .unwrap();
        assert_eq!(w.host_id, vps);
        assert!(matches!(
            s.create_session_for(Some(desktop), None, Some("work".into()), true),
            Err(StoreError::Invalid(_))
        ));
        assert!(matches!(
            s.create_session_for(None, None, Some("Work!".into()), true),
            Err(StoreError::Invalid(_))
        ));

        // The operation carries the session's profile.
        let (op, _) = s
            .enqueue(t.id, RemoteAction::Tabs, Duration::from_secs(5))
            .unwrap();
        let d = s
            .next_operation(vps, true, Duration::from_millis(50))
            .await
            .unwrap()
            .unwrap();
        assert_eq!((d.id, d.profile.as_str()), (op.id, "travel"));
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
