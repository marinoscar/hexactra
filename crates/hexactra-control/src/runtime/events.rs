//! Fabric event log for `GET /v1/events` (#212).
//!
//! Every event has a monotonically increasing `seq`, used as the SSE event
//! id. A bounded in-memory buffer lets clients resume after a reconnect with
//! `Last-Event-ID` (or `?after=`); if they fall further behind than the
//! buffer, they get a `reset` event and should re-read state.
//!
//! Payloads are content-free, like logs: ids, kinds, states and error
//! messages, never typed text, selectors, URLs from actions, screenshots or
//! secrets.

use std::collections::VecDeque;
use std::sync::{Arc, Mutex};

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::sync::broadcast;

/// Events kept for resuming clients.
pub const EVENT_BUFFER: usize = 2_000;

/// One fabric event.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, utoipa::ToSchema)]
pub struct FabricEvent {
    pub seq: u64,
    /// e.g. `operation.completed`, `session.created`, `host.offline`.
    #[serde(rename = "type")]
    pub kind: String,
    pub at: DateTime<Utc>,
    pub data: Value,
}

struct Inner {
    next_seq: u64,
    buffer: VecDeque<FabricEvent>,
}

/// Event log with replay buffer. Cheap to clone.
#[derive(Clone)]
pub struct EventLog {
    inner: Arc<Mutex<Inner>>,
    tx: broadcast::Sender<FabricEvent>,
}

impl Default for EventLog {
    fn default() -> Self {
        let (tx, _) = broadcast::channel(1024);
        Self {
            inner: Arc::new(Mutex::new(Inner {
                next_seq: 1,
                buffer: VecDeque::with_capacity(EVENT_BUFFER),
            })),
            tx,
        }
    }
}

/// Where a resuming client stands.
pub enum Replay {
    /// Events after the requested seq (possibly none).
    Events(Vec<FabricEvent>),
    /// The requested seq is older than the buffer: the client missed events.
    Gap,
}

impl EventLog {
    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Record and publish an event.
    pub fn emit(&self, kind: &str, data: Value) {
        let ev = {
            let mut inner = self.lock();
            let ev = FabricEvent {
                seq: inner.next_seq,
                kind: kind.to_string(),
                at: Utc::now(),
                data,
            };
            inner.next_seq += 1;
            if inner.buffer.len() == EVENT_BUFFER {
                inner.buffer.pop_front();
            }
            inner.buffer.push_back(ev.clone());
            ev
        };
        let _ = self.tx.send(ev);
    }

    /// Subscribe first, then replay, so no event falls between the two.
    pub fn subscribe_from(&self, after: Option<u64>) -> (broadcast::Receiver<FabricEvent>, Replay) {
        let rx = self.tx.subscribe();
        let inner = self.lock();
        let replay = match after {
            None => Replay::Events(Vec::new()),
            // A seq we never issued (e.g. from before a restart).
            Some(after) if after >= inner.next_seq => Replay::Gap,
            Some(after) => {
                let oldest = inner.buffer.front().map(|e| e.seq);
                match oldest {
                    Some(o) if after + 1 < o => Replay::Gap,
                    None if after + 1 < inner.next_seq => Replay::Gap,
                    _ => Replay::Events(
                        inner
                            .buffer
                            .iter()
                            .filter(|e| e.seq > after)
                            .cloned()
                            .collect(),
                    ),
                }
            }
        };
        (rx, replay)
    }

    /// Latest assigned seq (0 if none).
    pub fn last_seq(&self) -> u64 {
        self.lock().next_seq - 1
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[tokio::test]
    async fn replay_and_live_without_gaps() {
        let log = EventLog::default();
        log.emit("a.one", json!({}));
        log.emit("a.two", json!({}));
        let (mut rx, replay) = log.subscribe_from(Some(1));
        let Replay::Events(v) = replay else {
            panic!("gap")
        };
        assert_eq!(v.iter().map(|e| e.seq).collect::<Vec<_>>(), vec![2]);
        log.emit("a.three", json!({}));
        assert_eq!(rx.recv().await.unwrap().seq, 3);
        assert_eq!(log.last_seq(), 3);
    }

    #[test]
    fn falling_behind_the_buffer_is_a_gap() {
        let log = EventLog::default();
        for _ in 0..(EVENT_BUFFER + 5) {
            log.emit("x.y", json!({}));
        }
        assert!(matches!(log.subscribe_from(Some(1)).1, Replay::Gap));
        assert!(matches!(
            log.subscribe_from(Some(log.last_seq() - 1)).1,
            Replay::Events(v) if v.len() == 1
        ));
        // A seq from a previous process (restart) is also a gap.
        let fresh = EventLog::default();
        assert!(matches!(fresh.subscribe_from(Some(50)).1, Replay::Gap));
    }
}
