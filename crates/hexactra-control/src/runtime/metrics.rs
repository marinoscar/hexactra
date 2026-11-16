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
    desktop_opened: Counter<u64>,
    desktop_bytes: Counter<u64>,
    desktop_failures: Counter<u64>,
    desktop_duration: Histogram<f64>,
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
            desktop_opened: m
                .u64_counter("hexactra.desktop.tunnels")
                .with_description("Remote desktop tunnels opened (both legs joined)")
                .build(),
            desktop_bytes: m
                .u64_counter("hexactra.desktop.tunnel_bytes")
                .with_unit("By")
                .with_description("Bytes relayed through desktop tunnels, by direction")
                .build(),
            desktop_failures: m
                .u64_counter("hexactra.desktop.tunnel_failures")
                .with_description("Desktop tunnels that never opened, by reason")
                .build(),
            desktop_duration: m
                .f64_histogram("hexactra.desktop.tunnel_duration")
                .with_unit("s")
                .with_description("How long desktop tunnels stayed open")
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

pub(super) fn desktop_opened() {
    instruments().desktop_opened.add(1, &[]);
}

pub(super) fn desktop_failure(reason: &'static str) {
    instruments()
        .desktop_failures
        .add(1, &[KeyValue::new("reason", reason)]);
}

pub(super) fn desktop_closed(reason: &'static str, up: u64, down: u64, seconds: f64) {
    let i = instruments();
    i.desktop_bytes.add(up, &[KeyValue::new("direction", "up")]);
    i.desktop_bytes
        .add(down, &[KeyValue::new("direction", "down")]);
    i.desktop_duration
        .record(seconds, &[KeyValue::new("reason", reason)]);
}
