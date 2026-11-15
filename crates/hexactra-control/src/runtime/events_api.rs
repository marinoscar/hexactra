//! `GET /v1/events`: server-sent events from the fabric event log (#212).
//!
//! - `id:` is the event `seq`; reconnect with `Last-Event-ID` (or `?after=`)
//!   to resume without missing events.
//! - `event:` is the event type (`operation.succeeded`, `host.offline`, ...).
//! - `data:` is the JSON event.
//! - `?types=` takes comma-separated filters (`*`, `handoff.*`, exact names).
//! - When a client resumes from further back than the replay buffer (or from
//!   before a restart), it first gets `event: reset` and should re-read state.

use std::convert::Infallible;
use std::time::Duration;

use axum::{
    extract::{Query, State},
    http::HeaderMap,
    response::sse::{Event, KeepAlive, Sse},
    routing::get,
    Router,
};
use futures_util::Stream;
use hexactra_core::remote::webhook_filter_matches;
use serde::Deserialize;
use tokio::sync::broadcast::error::RecvError;

use super::api::ApiState;
use super::events::{FabricEvent, Replay};

pub(super) fn routes() -> Router<ApiState> {
    Router::new().route("/v1/events", get(events))
}

#[derive(Deserialize)]
struct EventsQuery {
    after: Option<u64>,
    types: Option<String>,
}

fn to_sse(e: &FabricEvent) -> Event {
    Event::default()
        .id(e.seq.to_string())
        .event(e.kind.clone())
        .data(serde_json::to_string(e).unwrap_or_default())
}

fn reset(last_seq: u64) -> Event {
    Event::default()
        .event("reset")
        .data(serde_json::json!({ "last_seq": last_seq }).to_string())
}

async fn events(
    State(s): State<ApiState>,
    headers: HeaderMap,
    Query(q): Query<EventsQuery>,
) -> Sse<impl Stream<Item = Result<Event, Infallible>>> {
    let after = headers
        .get("last-event-id")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.trim().parse::<u64>().ok())
        .or(q.after);
    let filters: Vec<String> = q
        .types
        .as_deref()
        .unwrap_or("*")
        .split(',')
        .map(|f| f.trim().to_string())
        .filter(|f| !f.is_empty())
        .collect();
    let wanted = move |kind: &str| filters.iter().any(|f| webhook_filter_matches(f, kind));
    let log = s.store.log.clone();
    let (mut rx, replay) = log.subscribe_from(after);
    let stream = async_stream::stream! {
        let mut last = after.unwrap_or(0);
        match replay {
            Replay::Gap => {
                last = log.last_seq();
                yield Ok(reset(last));
            }
            Replay::Events(v) => {
                for e in v {
                    last = e.seq;
                    if wanted(&e.kind) {
                        yield Ok(to_sse(&e));
                    }
                }
            }
        }
        loop {
            match rx.recv().await {
                Ok(e) => {
                    if e.seq <= last && after.is_some() {
                        continue; // already replayed
                    }
                    last = e.seq;
                    if wanted(&e.kind) {
                        yield Ok(to_sse(&e));
                    }
                }
                Err(RecvError::Lagged(_)) => {
                    last = log.last_seq();
                    yield Ok(reset(last));
                }
                Err(RecvError::Closed) => break,
            }
        }
    };
    Sse::new(stream).keep_alive(KeepAlive::new().interval(Duration::from_secs(15)))
}
