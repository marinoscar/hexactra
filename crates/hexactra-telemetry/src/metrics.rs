//! Metrics and counters for Hexactra

use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Instant;
use std::sync::Arc;

/// Global metrics state - use Arc for sharing
#[derive(Debug)]
pub struct Metrics {
    /// Active sessions count
    pub active_sessions: Arc<AtomicU64>,
    /// Total sessions created
    pub total_sessions_created: Arc<AtomicU64>,
    /// Total sessions terminated
    pub total_sessions_terminated: Arc<AtomicU64>,
    /// Total actions executed
    pub total_actions_executed: Arc<AtomicU64>,
    /// Total actions failed
    pub total_actions_failed: Arc<AtomicU64>,
    /// Total model calls
    pub total_model_calls: Arc<AtomicU64>,
    /// Total model tokens used
    pub total_model_tokens: Arc<AtomicU64>,
    /// Total HITL approvals
    pub total_hitl_approvals: Arc<AtomicU64>,
    /// Total HITL denials
    pub total_hitl_denials: Arc<AtomicU64>,
}

impl Metrics {
    pub fn new() -> Self {
        Self {
            active_sessions: Arc::new(AtomicU64::new(0)),
            total_sessions_created: Arc::new(AtomicU64::new(0)),
            total_sessions_terminated: Arc::new(AtomicU64::new(0)),
            total_actions_executed: Arc::new(AtomicU64::new(0)),
            total_actions_failed: Arc::new(AtomicU64::new(0)),
            total_model_calls: Arc::new(AtomicU64::new(0)),
            total_model_tokens: Arc::new(AtomicU64::new(0)),
            total_hitl_approvals: Arc::new(AtomicU64::new(0)),
            total_hitl_denials: Arc::new(AtomicU64::new(0)),
        }
    }
}

impl Clone for Metrics {
    fn clone(&self) -> Self {
        Self {
            active_sessions: Arc::clone(&self.active_sessions),
            total_sessions_created: Arc::clone(&self.total_sessions_created),
            total_sessions_terminated: Arc::clone(&self.total_sessions_terminated),
            total_actions_executed: Arc::clone(&self.total_actions_executed),
            total_actions_failed: Arc::clone(&self.total_actions_failed),
            total_model_calls: Arc::clone(&self.total_model_calls),
            total_model_tokens: Arc::clone(&self.total_model_tokens),
            total_hitl_approvals: Arc::clone(&self.total_hitl_approvals),
            total_hitl_denials: Arc::clone(&self.total_hitl_denials),
        }
    }
}

/// Instrument a closure with metrics tracking
pub fn instrument<F, R>(metrics: &Metrics, f: F) -> R
where
    F: FnOnce() -> R,
{
    let _span = crate::start_span("metrics.instrument", "metrics");
    f()
}

/// Track session lifecycle events
pub fn track_session_created(metrics: &Metrics) {
    metrics.total_sessions_created.fetch_add(1, Ordering::SeqCst);
    metrics.active_sessions.fetch_add(1, Ordering::SeqCst);
}

pub fn track_session_terminated(metrics: &Metrics) {
    metrics.total_sessions_terminated.fetch_add(1, Ordering::SeqCst);
    let _ = metrics.active_sessions.fetch_sub(1, Ordering::SeqCst);
}

/// Track action execution
pub fn track_action_executed(metrics: &Metrics) {
    metrics.total_actions_executed.fetch_add(1, Ordering::SeqCst);
}

pub fn track_action_failed(metrics: &Metrics) {
    metrics.total_actions_failed.fetch_add(1, Ordering::SeqCst);
}

/// Track model call
pub fn track_model_call(metrics: &Metrics, tokens: u64) {
    metrics.total_model_calls.fetch_add(1, Ordering::SeqCst);
    metrics.total_model_tokens.fetch_add(tokens, Ordering::SeqCst);
}

/// Track HITL decision
pub fn track_hitl_approved(metrics: &Metrics) {
    metrics.total_hitl_approvals.fetch_add(1, Ordering::SeqCst);
}

pub fn track_hitl_denied(metrics: &Metrics) {
    metrics.total_hitl_denials.fetch_add(1, Ordering::SeqCst);
}

/// Measure duration of an operation
pub struct Timer {
    start: Instant,
    name: &'static str,
}

impl Timer {
    pub fn new(name: &'static str) -> Self {
        Self {
            start: Instant::now(),
            name,
        }
    }

    pub fn elapsed_ms(&self) -> u64 {
        self.start.elapsed().as_millis() as u64
    }
}

impl Drop for Timer {
    fn drop(&mut self) {
        let duration = self.elapsed_ms();
        tracing::debug!("Timer '{}' completed in {}ms", self.name, duration);
    }
}

/// Safe label values for metrics to prevent cardinality explosion
pub struct SafeLabels;

impl SafeLabels {
    /// Limit session ID cardinality by using only first 8 chars
    pub fn safe_session_id(id: &str) -> String {
        id.chars().take(8).collect()
    }

    /// Limit host ID cardinality
    pub fn safe_host_id(id: &str) -> String {
        id.chars().take(8).collect()
    }

    /// Limit model name cardinality
    pub fn safe_model_name(name: &str) -> String {
        // Extract provider and base model name
        name.split('/')
            .last()
            .unwrap_or(name)
            .chars()
            .take(32)
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_metrics_new() {
        let metrics = Metrics::new();
        assert_eq!(metrics.active_sessions.load(Ordering::SeqCst), 0);
        assert_eq!(metrics.total_sessions_created.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn test_metrics_clone() {
        let metrics = Metrics::new();
        let cloned = metrics.clone();
        track_session_created(&cloned);
        assert_eq!(metrics.active_sessions.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn test_track_session_created() {
        let metrics = Metrics::new();
        track_session_created(&metrics);
        assert_eq!(metrics.active_sessions.load(Ordering::SeqCst), 1);
        assert_eq!(metrics.total_sessions_created.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn test_track_session_terminated() {
        let metrics = Metrics::new();
        track_session_created(&metrics);
        track_session_terminated(&metrics);
        assert_eq!(metrics.active_sessions.load(Ordering::SeqCst), 0);
        assert_eq!(metrics.total_sessions_terminated.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn test_track_action() {
        let metrics = Metrics::new();
        track_action_executed(&metrics);
        assert_eq!(metrics.total_actions_executed.load(Ordering::SeqCst), 1);
        track_action_failed(&metrics);
        assert_eq!(metrics.total_actions_failed.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn test_track_model_call() {
        let metrics = Metrics::new();
        track_model_call(&metrics, 100);
        assert_eq!(metrics.total_model_calls.load(Ordering::SeqCst), 1);
        assert_eq!(metrics.total_model_tokens.load(Ordering::SeqCst), 100);
    }

    #[test]
    fn test_track_hitl() {
        let metrics = Metrics::new();
        track_hitl_approved(&metrics);
        assert_eq!(metrics.total_hitl_approvals.load(Ordering::SeqCst), 1);
        track_hitl_denied(&metrics);
        assert_eq!(metrics.total_hitl_denials.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn test_safe_labels() {
        let long_id = "a".repeat(100);
        assert_eq!(SafeLabels::safe_session_id(&long_id).len(), 8);
        // "model-name" after splitting "provider/model-name" has length 10
        assert_eq!(SafeLabels::safe_model_name("provider/model-name").len(), 10);
    }

    #[test]
    fn test_timer() {
        let timer = Timer::new("test");
        std::thread::sleep(std::time::Duration::from_millis(10));
        let elapsed = timer.elapsed_ms();
        assert!(elapsed >= 10);
    }
}
