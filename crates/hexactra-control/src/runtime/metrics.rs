//! Fabric metrics over OpenTelemetry (#215). No-ops unless metric export
//! is configured (see `hexactra_otel`). Labels are kinds and states only.

use std::sync::OnceLock;

use hexactra_core::remote::{HostCommandView, OperationView};
use hexactra_otel::{global, KeyValue};
use opentelemetry::metrics::{Counter, Histogram};

struct Instruments {
    operations: Counter<u64>,
    operation_duration: Histogram<f64>,
    host_commands: Counter<u64>,
}

fn instruments() -> &'static Instruments {
    static I: OnceLock<Instruments> = OnceLock::new();
    I.get_or_init(|| {
        let m = global::meter("hexactra-control");
        Instruments {
            operations: m
                .u64_counter("hexactra.operations")
                .with_description("Browser actions that reached a final state")
                .build(),
            operation_duration: m
                .f64_histogram("hexactra.operation.duration")
                .with_unit("s")
                .with_description("Time from queueing an action to its final state")
                .build(),
            host_commands: m
                .u64_counter("hexactra.host_commands")
                .with_description("Host commands that reached a final state")
                .build(),
        }
    })
}

fn state(s: impl serde::Serialize) -> String {
    serde_json::to_value(s)
        .ok()
        .and_then(|v| v.as_str().map(str::to_string))
        .unwrap_or_default()
}

pub(super) fn operation_finished(v: &OperationView) {
    let i = instruments();
    let attrs = [
        KeyValue::new("kind", v.action.kind()),
        KeyValue::new("state", state(v.state)),
    ];
    i.operations.add(1, &attrs);
    if let Some(done) = v.completed_at {
        let secs = (done - v.created_at).num_milliseconds().max(0) as f64 / 1000.0;
        i.operation_duration.record(secs, &attrs);
    }
}

pub(super) fn host_command_finished(v: &HostCommandView) {
    instruments().host_commands.add(
        1,
        &[
            KeyValue::new("kind", v.command.kind()),
            KeyValue::new("state", state(v.state)),
        ],
    );
}
