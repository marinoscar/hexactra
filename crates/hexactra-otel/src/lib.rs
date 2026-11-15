//! OpenTelemetry for the Hexactra fabric (#215).
//!
//! - [`init`] installs logging (`RUST_LOG`, default `info`) plus a
//!   `tracing-opentelemetry` layer. The layer is always on, so W3C
//!   `traceparent` propagation works even when nothing is exported.
//! - Export is off unless `OTEL_EXPORTER_OTLP_ENDPOINT` (or the
//!   `..._TRACES_ENDPOINT` / `..._METRICS_ENDPOINT` variants) is set. The
//!   protocol follows `OTEL_EXPORTER_OTLP_PROTOCOL` (`http/protobuf` by
//!   default, or `http/json`). Other standard `OTEL_*` variables apply.
//! - Spans and metrics carry ids, kinds and states only, never typed text,
//!   selectors, URLs from actions, screenshots or tokens.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

use opentelemetry::propagation::{Extractor, Injector, TextMapPropagator};
use opentelemetry::trace::TracerProvider as _;
use opentelemetry::Context;
use opentelemetry_otlp::{Protocol, WithExportConfig};
use opentelemetry_sdk::metrics::SdkMeterProvider;
use opentelemetry_sdk::propagation::TraceContextPropagator;
use opentelemetry_sdk::trace::SdkTracerProvider;
use opentelemetry_sdk::Resource;
use tracing_opentelemetry::OpenTelemetrySpanExt;
use tracing_subscriber::filter::{LevelFilter, Targets};
use tracing_subscriber::layer::SubscriberExt;
use tracing_subscriber::util::SubscriberInitExt;
use tracing_subscriber::{EnvFilter, Layer};

pub use opentelemetry::global;
pub use opentelemetry::KeyValue;

struct Providers {
    tracer: SdkTracerProvider,
    meter: Option<SdkMeterProvider>,
}

static PROVIDERS: OnceLock<Mutex<Option<Providers>>> = OnceLock::new();

fn env_set(names: &[&str]) -> bool {
    names.iter().any(|n| {
        std::env::var(n)
            .map(|v| !v.trim().is_empty())
            .unwrap_or(false)
    })
}

fn protocol() -> Protocol {
    match std::env::var("OTEL_EXPORTER_OTLP_PROTOCOL").as_deref() {
        Ok("http/json") => Protocol::HttpJson,
        _ => Protocol::HttpBinary,
    }
}

/// Whether spans are exported.
pub fn traces_exported() -> bool {
    env_set(&[
        "OTEL_EXPORTER_OTLP_ENDPOINT",
        "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT",
    ])
}

fn metrics_exported() -> bool {
    env_set(&[
        "OTEL_EXPORTER_OTLP_ENDPOINT",
        "OTEL_EXPORTER_OTLP_METRICS_ENDPOINT",
    ])
}

/// Install logging and tracing for a binary. Call once, early.
pub fn init(service_name: &'static str) {
    global::set_text_map_propagator(TraceContextPropagator::new());
    let resource = Resource::builder().with_service_name(service_name).build();

    let mut tp = SdkTracerProvider::builder().with_resource(resource.clone());
    let mut export_error = None;
    if traces_exported() {
        match opentelemetry_otlp::SpanExporter::builder()
            .with_http()
            .with_protocol(protocol())
            .build()
        {
            Ok(exporter) => tp = tp.with_batch_exporter(exporter),
            Err(e) => export_error = Some(format!("trace exporter: {e}")),
        }
    }
    let tracer_provider = tp.build();
    let tracer = tracer_provider.tracer(service_name);
    global::set_tracer_provider(tracer_provider.clone());

    let meter_provider = if metrics_exported() {
        match opentelemetry_otlp::MetricExporter::builder()
            .with_http()
            .with_protocol(protocol())
            .build()
        {
            Ok(exporter) => {
                let mp = SdkMeterProvider::builder()
                    .with_resource(resource)
                    .with_periodic_exporter(exporter)
                    .build();
                global::set_meter_provider(mp.clone());
                Some(mp)
            }
            Err(e) => {
                export_error = Some(format!("metric exporter: {e}"));
                None
            }
        }
    } else {
        None
    };

    // The exporter's own HTTP client must not feed spans back to itself.
    let otel_filter = Targets::new()
        .with_default(LevelFilter::INFO)
        .with_target("hyper", LevelFilter::OFF)
        .with_target("hyper_util", LevelFilter::OFF)
        .with_target("reqwest", LevelFilter::OFF)
        .with_target("h2", LevelFilter::OFF)
        .with_target("tower", LevelFilter::OFF)
        .with_target("opentelemetry", LevelFilter::OFF)
        .with_target("opentelemetry_sdk", LevelFilter::OFF)
        .with_target("opentelemetry_otlp", LevelFilter::OFF);
    let fmt_filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into());
    let _ = tracing_subscriber::registry()
        .with(tracing_subscriber::fmt::layer().with_filter(fmt_filter))
        .with(
            tracing_opentelemetry::layer()
                .with_tracer(tracer)
                .with_filter(otel_filter),
        )
        .try_init();

    *PROVIDERS.get_or_init(Default::default).lock().unwrap() = Some(Providers {
        tracer: tracer_provider,
        meter: meter_provider,
    });
    match export_error {
        Some(e) => tracing::warn!(error = %e, "OpenTelemetry export disabled"),
        None if traces_exported() => tracing::info!("exporting OpenTelemetry traces over OTLP"),
        None => {}
    }
}

/// Flush and stop exporting (call before exit).
pub fn shutdown() {
    let taken = PROVIDERS
        .get()
        .and_then(|m| m.lock().unwrap_or_else(|e| e.into_inner()).take());
    if let Some(p) = taken {
        let _ = p.tracer.force_flush();
        let _ = p.tracer.shutdown();
        if let Some(m) = p.meter {
            let _ = m.force_flush();
            let _ = m.shutdown();
        }
    }
}

struct HeaderExtractor<'a>(&'a http::HeaderMap);

impl Extractor for HeaderExtractor<'_> {
    fn get(&self, key: &str) -> Option<&str> {
        self.0.get(key).and_then(|v| v.to_str().ok())
    }
    fn keys(&self) -> Vec<&str> {
        self.0.keys().map(|k| k.as_str()).collect()
    }
}

struct MapCarrier(HashMap<String, String>);

impl Injector for MapCarrier {
    fn set(&mut self, key: &str, value: String) {
        self.0.insert(key.to_string(), value);
    }
}

impl Extractor for MapCarrier {
    fn get(&self, key: &str) -> Option<&str> {
        self.0.get(key).map(String::as_str)
    }
    fn keys(&self) -> Vec<&str> {
        self.0.keys().map(String::as_str).collect()
    }
}

/// Trace context from incoming HTTP headers (`traceparent`, `tracestate`).
pub fn context_from_headers(headers: &http::HeaderMap) -> Context {
    global::get_text_map_propagator(|p| p.extract(&HeaderExtractor(headers)))
}

/// Make `span` a child of the trace in `headers`, if any.
pub fn set_parent_from_headers(span: &tracing::Span, headers: &http::HeaderMap) {
    if headers.contains_key("traceparent") {
        let _ = span.set_parent(context_from_headers(headers));
    }
}

/// Make `span` a child of a `traceparent` value carried in a message.
pub fn set_parent_from_traceparent(span: &tracing::Span, traceparent: Option<&str>) {
    let Some(tp) = traceparent else { return };
    let mut m = HashMap::new();
    m.insert("traceparent".to_string(), tp.to_string());
    let carrier = MapCarrier(m);
    let cx = global::get_text_map_propagator(|p| p.extract(&carrier));
    let _ = span.set_parent(cx);
}

/// The current span's `traceparent`, to carry in a dispatched message.
pub fn current_traceparent() -> Option<String> {
    let cx = tracing::Span::current().context();
    let mut carrier = MapCarrier(HashMap::new());
    TraceContextPropagator::new().inject_context(&cx, &mut carrier);
    carrier.0.remove("traceparent")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn traceparent_survives_a_round_trip_through_a_message() {
        init("hexactra-otel-test");
        let incoming = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";
        let mut headers = http::HeaderMap::new();
        headers.insert("traceparent", incoming.parse().unwrap());
        let span = tracing::info_span!("http.request");
        set_parent_from_headers(&span, &headers);
        let carried = span.in_scope(current_traceparent).expect("traceparent");
        assert!(
            carried.starts_with("00-4bf92f3577b34da6a3ce929d0e0e4736-"),
            "{carried}"
        );
        assert!(!carried.contains("00f067aa0ba902b7"), "a new span id");

        // On the host: a child of the carried context, same trace.
        let op = tracing::info_span!("operation.execute");
        set_parent_from_traceparent(&op, Some(&carried));
        let again = op.in_scope(current_traceparent).unwrap();
        assert!(again.starts_with("00-4bf92f3577b34da6a3ce929d0e0e4736-"));
        shutdown();
    }
}
