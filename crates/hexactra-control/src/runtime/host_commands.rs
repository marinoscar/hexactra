//! Host commands (#213): manage a host's profiles and browsers remotely.
//!
//! A command is queued per host and handed to the agent on its poll (only
//! to agents that poll with `commands=true`), ahead of session operations.
//! The agent reports a result like an operation. `drain` never reaches the
//! agent: the control plane applies it at once.
//!
//! Event payloads are content-free: ids, kind, profile name, state, error.

use std::time::Duration;

use chrono::{DateTime, Utc};
use hexactra_core::remote::{
    DispatchedCommand, HostCommand, HostCommandView, OperationResult, OperationState,
    RemoteSessionStatus,
};
use serde_json::json;
use tokio::sync::watch;
use uuid::Uuid;

use super::events::EventLog;
use super::store::{Inner, RuntimeStore, StoreError};

/// Terminal commands kept for listing.
const COMMAND_RETENTION: Duration = Duration::from_secs(24 * 60 * 60);
const COMMAND_PRUNE_THRESHOLD: usize = 500;

pub(crate) struct CommandEntry {
    pub(super) view: HostCommandView,
    pub(super) deadline: DateTime<Utc>,
    pub(super) tx: watch::Sender<OperationState>,
    pub(super) traceparent: Option<String>,
}

fn event(v: &HostCommandView) -> serde_json::Value {
    json!({
        "command_id": v.id,
        "host_id": v.host_id,
        "kind": v.command.kind(),
        "profile": v.command.profile(),
        "state": v.state,
        "error": v.error,
    })
}

fn event_name(state: OperationState) -> &'static str {
    match state {
        OperationState::Queued => "host.command.queued",
        OperationState::Dispatched => "host.command.dispatched",
        OperationState::Succeeded => "host.command.succeeded",
        OperationState::Failed => "host.command.failed",
        OperationState::TimedOut => "host.command.timed_out",
        OperationState::Cancelled => "host.command.cancelled",
    }
}

impl RuntimeStore {
    /// Queue a command for a host (or apply `drain` at once).
    pub fn enqueue_host_command(
        &self,
        host_id: Uuid,
        command: HostCommand,
        timeout: Duration,
    ) -> Result<(HostCommandView, watch::Receiver<OperationState>), StoreError> {
        command.validate().map_err(|e| StoreError::Invalid(e.0))?;
        let mut inner = self.lock();
        let now = Utc::now();
        if !inner.hosts.contains_key(&host_id) {
            return Err(StoreError::NotFound("host"));
        }
        if let HostCommand::DeleteProfile { profile } = &command {
            let in_use = inner.sessions.values().any(|s| {
                s.host_id == host_id
                    && s.status == RemoteSessionStatus::Active
                    && &s.profile == profile
            });
            if in_use {
                return Err(StoreError::Conflict(format!(
                    "profile {profile:?} has an active session on this host; end it first"
                )));
            }
        }
        let mut view = HostCommandView {
            id: Uuid::new_v4(),
            host_id,
            command: command.clone(),
            state: OperationState::Queued,
            result: None,
            error: None,
            created_at: now,
            completed_at: None,
        };
        if let HostCommand::Drain { enabled } = command {
            let host = inner.hosts.get_mut(&host_id).expect("checked above");
            host.draining = enabled;
            view.state = OperationState::Succeeded;
            view.result = Some(json!({ "draining": enabled }));
            view.completed_at = Some(now);
            let (tx, rx) = watch::channel(OperationState::Succeeded);
            self.log.emit(
                "host.draining",
                json!({ "host_id": host_id, "draining": enabled }),
            );
            self.log.emit(event_name(view.state), event(&view));
            inner.commands.insert(
                view.id,
                CommandEntry {
                    view: view.clone(),
                    deadline: now,
                    tx,
                    traceparent: None,
                },
            );
            return Ok((view, rx));
        }
        let deadline = now + chrono::Duration::from_std(timeout).unwrap_or_default();
        let (tx, rx) = watch::channel(OperationState::Queued);
        inner.commands.insert(
            view.id,
            CommandEntry {
                view: view.clone(),
                deadline,
                tx,
                traceparent: hexactra_otel::current_traceparent(),
            },
        );
        let host = inner.hosts.get_mut(&host_id).expect("checked above");
        host.command_queue.push_back(view.id);
        host.notify.notify_one();
        self.log.emit(event_name(view.state), event(&view));
        if inner.commands.len() > COMMAND_PRUNE_THRESHOLD {
            let keep = chrono::Duration::from_std(COMMAND_RETENTION).unwrap_or_default();
            inner.commands.retain(|_, c| {
                !c.view.state.is_terminal()
                    || c.view
                        .completed_at
                        .map(|t| now.signed_duration_since(t) < keep)
                        .unwrap_or(true)
            });
        }
        Ok((view, rx))
    }

    /// Hand the oldest queued command to a polling host (called under lock).
    pub(super) fn dispatch_next_command(
        inner: &mut Inner,
        host_id: Uuid,
        log: &EventLog,
    ) -> Option<DispatchedCommand> {
        let host = inner.hosts.get_mut(&host_id)?;
        let mut queue = std::mem::take(&mut host.command_queue);
        let mut found = None;
        while let Some(id) = queue.pop_front() {
            if let Some(c) = inner.commands.get_mut(&id) {
                if c.view.state == OperationState::Queued {
                    c.view.state = OperationState::Dispatched;
                    let _ = c.tx.send(OperationState::Dispatched);
                    log.emit(event_name(c.view.state), event(&c.view));
                    found = Some(DispatchedCommand {
                        id,
                        command: c.view.command.clone(),
                        deadline: c.deadline,
                        traceparent: c.traceparent.clone(),
                    });
                    break;
                }
            }
        }
        if let Some(host) = inner.hosts.get_mut(&host_id) {
            host.command_queue = queue;
        }
        found
    }

    pub fn get_host_command(&self, id: Uuid) -> Result<HostCommandView, StoreError> {
        self.lock()
            .commands
            .get(&id)
            .map(|c| c.view.clone())
            .ok_or(StoreError::NotFound("command"))
    }

    /// Recent commands for a host, newest first.
    pub fn list_host_commands(&self, host_id: Uuid) -> Result<Vec<HostCommandView>, StoreError> {
        let inner = self.lock();
        if !inner.hosts.contains_key(&host_id) {
            return Err(StoreError::NotFound("host"));
        }
        let mut v: Vec<_> = inner
            .commands
            .values()
            .filter(|c| c.view.host_id == host_id)
            .map(|c| c.view.clone())
            .collect();
        v.sort_by_key(|c| std::cmp::Reverse(c.created_at));
        v.truncate(100);
        Ok(v)
    }

    pub fn subscribe_host_command(
        &self,
        id: Uuid,
    ) -> Result<watch::Receiver<OperationState>, StoreError> {
        self.lock()
            .commands
            .get(&id)
            .map(|c| c.tx.subscribe())
            .ok_or(StoreError::NotFound("command"))
    }

    /// Record a host's result for a dispatched command, and apply its effect
    /// on the host's reported profiles right away.
    pub fn complete_host_command(
        &self,
        host_id: Uuid,
        id: Uuid,
        result: OperationResult,
    ) -> Result<HostCommandView, StoreError> {
        let mut inner = self.lock();
        let c = inner
            .commands
            .get_mut(&id)
            .filter(|c| c.view.host_id == host_id)
            .ok_or(StoreError::NotFound("command"))?;
        if c.view.state != OperationState::Dispatched {
            return Err(StoreError::Conflict(format!(
                "command is {:?}, not dispatched",
                c.view.state
            )));
        }
        let state = if result.ok {
            OperationState::Succeeded
        } else {
            OperationState::Failed
        };
        c.view.state = state;
        c.view.result = result.result;
        c.view.error = if result.ok {
            None
        } else {
            Some(result.error.unwrap_or_else(|| "command failed".into()))
        };
        c.view.completed_at = Some(Utc::now());
        let _ = c.tx.send(state);
        super::metrics::host_command_finished(&c.view);
        self.log.emit(event_name(state), event(&c.view));
        let view = c.view.clone();
        if result.ok {
            if let Some(h) = inner.hosts.get_mut(&host_id) {
                match &view.command {
                    HostCommand::CreateProfile { profile } => {
                        if !h.profiles.contains(profile) {
                            h.profiles.push(profile.clone());
                            h.profiles.sort();
                        }
                    }
                    HostCommand::DeleteProfile { profile } => {
                        h.profiles.retain(|p| p != profile);
                        h.running_profiles.retain(|p| p != profile);
                    }
                    HostCommand::CloseBrowser { profile } => {
                        h.running_profiles.retain(|p| p != profile);
                    }
                    HostCommand::RestartBrowser { .. } | HostCommand::Drain { .. } => {}
                }
            }
        }
        Ok(view)
    }

    /// Mark a command timed out if it is still pending.
    pub fn time_out_host_command(&self, id: Uuid) -> Option<HostCommandView> {
        let mut inner = self.lock();
        let c = inner.commands.get_mut(&id)?;
        if !c.view.state.is_terminal() {
            let was_dispatched = c.view.state == OperationState::Dispatched;
            c.view.state = OperationState::TimedOut;
            c.view.error = Some(if was_dispatched {
                "host did not report a result in time; the command may have run".into()
            } else {
                "the host did not pick up the command in time (offline, or an agent without command support); it did not run".into()
            });
            c.view.completed_at = Some(Utc::now());
            let _ = c.tx.send(OperationState::TimedOut);
            super::metrics::host_command_finished(&c.view);
            self.log.emit(event_name(c.view.state), event(&c.view));
        }
        Some(c.view.clone())
    }

    /// Wait until a command is terminal or `wait` elapses (then time it out
    /// when `expire`).
    pub async fn wait_for_host_command(
        &self,
        id: Uuid,
        mut rx: watch::Receiver<OperationState>,
        wait: Duration,
        expire: bool,
    ) -> Result<HostCommandView, StoreError> {
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
                .time_out_host_command(id)
                .ok_or(StoreError::NotFound("command"));
        }
        self.get_host_command(id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use hexactra_core::remote::HostWork;

    fn ok() -> OperationResult {
        OperationResult {
            ok: true,
            result: Some(json!({})),
            error: None,
        }
    }

    #[tokio::test]
    async fn commands_go_first_to_agents_that_accept_them() {
        let s = RuntimeStore::new();
        let h = s.register_host(None, "vps".into(), "1".into());
        s.next_work(h, true, true, Duration::from_millis(1))
            .await
            .unwrap();
        let (c, rx) = s
            .enqueue_host_command(
                h,
                HostCommand::CreateProfile {
                    profile: "travel".into(),
                },
                Duration::from_secs(5),
            )
            .unwrap();
        // An agent without command support never receives it.
        assert!(s
            .next_work(h, true, false, Duration::from_millis(1))
            .await
            .unwrap()
            .is_none());
        let Some(HostWork::Command { command }) = s
            .next_work(h, true, true, Duration::from_millis(1))
            .await
            .unwrap()
        else {
            panic!("expected a command")
        };
        assert_eq!(command.id, c.id);
        s.complete_host_command(h, c.id, ok()).unwrap();
        let done = s
            .wait_for_host_command(c.id, rx, Duration::from_secs(1), true)
            .await
            .unwrap();
        assert_eq!(done.state, OperationState::Succeeded);
        assert!(s.list_hosts()[0].profiles.contains(&"travel".to_string()));
        // Reported once only.
        assert!(s.complete_host_command(h, c.id, ok()).is_err());
        assert_eq!(s.list_host_commands(h).unwrap().len(), 1);
    }

    #[tokio::test]
    async fn drain_applies_at_once_and_stops_new_sessions() {
        let s = RuntimeStore::new();
        let h = s.register_host(None, "vps".into(), "1".into());
        s.next_work(h, true, true, Duration::from_millis(1))
            .await
            .unwrap();
        let (v, _) = s
            .enqueue_host_command(h, HostCommand::Drain { enabled: true }, Duration::ZERO)
            .unwrap();
        assert_eq!(v.state, OperationState::Succeeded);
        assert!(s.list_hosts()[0].draining);
        assert_eq!(
            s.create_session(None, None).unwrap_err(),
            StoreError::NoHostAvailable
        );
        assert!(matches!(
            s.create_session(Some(h), None),
            Err(StoreError::Conflict(_))
        ));
        s.enqueue_host_command(h, HostCommand::Drain { enabled: false }, Duration::ZERO)
            .unwrap();
        assert!(s.create_session(None, None).is_ok());
    }

    #[tokio::test]
    async fn delete_profile_is_refused_while_in_use_or_for_default() {
        let s = RuntimeStore::new();
        let h = s.register_host(None, "vps".into(), "1".into());
        s.next_work(h, true, true, Duration::from_millis(1))
            .await
            .unwrap();
        s.set_host_profiles(h, vec!["default".into(), "work".into()], vec![])
            .unwrap();
        let sess = s
            .create_session_for(Some(h), None, Some("work".into()), false)
            .unwrap();
        let del = |p: &str| HostCommand::DeleteProfile { profile: p.into() };
        assert!(matches!(
            s.enqueue_host_command(h, del("work"), Duration::from_secs(1)),
            Err(StoreError::Conflict(_))
        ));
        assert!(matches!(
            s.enqueue_host_command(h, del("default"), Duration::from_secs(1)),
            Err(StoreError::Invalid(_))
        ));
        assert!(matches!(
            s.enqueue_host_command(h, del("../x"), Duration::from_secs(1)),
            Err(StoreError::Invalid(_))
        ));
        s.end_session(sess.id).unwrap();
        assert!(s
            .enqueue_host_command(h, del("work"), Duration::from_secs(1))
            .is_ok());
    }

    #[tokio::test]
    async fn an_unclaimed_command_times_out_without_running() {
        let s = RuntimeStore::new();
        let h = s.register_host(None, "vps".into(), "1".into());
        let (c, rx) = s
            .enqueue_host_command(
                h,
                HostCommand::CloseBrowser {
                    profile: "default".into(),
                },
                Duration::from_millis(50),
            )
            .unwrap();
        let v = s
            .wait_for_host_command(c.id, rx, Duration::from_millis(50), true)
            .await
            .unwrap();
        assert_eq!(v.state, OperationState::TimedOut);
        assert!(v.error.unwrap().contains("did not run"));
        // A late poll does not receive it.
        assert!(s
            .next_work(h, true, true, Duration::from_millis(1))
            .await
            .unwrap()
            .is_none());
    }
}
