//! Event queue with batching support

use crate::ConnectorError;
use chrono::{DateTime, Utc};
use hexactra_core::experience::{ExperienceEvent, ExperienceEventBatch};
use std::collections::VecDeque;
use std::sync::Arc;
use tokio::sync::Mutex;
use tracing::{debug, instrument};

/// Event queue with batching support
pub struct EventQueue {
    config: Arc<crate::config::ConnectorConfig>,
    events: Mutex<VecDeque<ExperienceEvent>>,
    last_flush: Mutex<DateTime<Utc>>,
}

impl EventQueue {
    /// Create a new event queue
    pub fn new(config: crate::config::ConnectorConfig) -> Self {
        let config = Arc::new(config);
        Self {
            config,
            events: Mutex::new(VecDeque::new()),
            last_flush: Mutex::new(Utc::now()),
        }
    }

    /// Add an event to the queue
    #[instrument(skip(self, event))]
    pub async fn add_event(&self, event: ExperienceEvent) -> Result<(), ConnectorError> {
        let mut events = self.events.lock().await;

        if events.len() >= self.config.max_events_per_batch {
            return Err(ConnectorError::Queue(
                "Queue is full, consider flushing or increasing batch size".to_string(),
            ));
        }

        events.push_back(event);
        debug!("Added event to queue, total: {}", events.len());
        Ok(())
    }

    /// Check if the queue should be flushed
    pub async fn should_flush(&self) -> bool {
        let events = self.events.lock().await;
        let last_flush = self.last_flush.lock().await;

        events.len() >= self.config.max_events_per_batch
            || (Utc::now() - *last_flush).num_seconds() >= self.config.flush_interval_ms as i64 / 1000
    }

    /// Flush the queue and return a batch
    #[instrument(skip(self))]
    pub async fn flush(&self) -> Option<ExperienceEventBatch> {
        let mut events = self.events.lock().await;
        let mut last_flush = self.last_flush.lock().await;

        if events.is_empty() {
            return None;
        }

        let owner_id = events.front()?.consent.owner_id;
        let event_list: Vec<ExperienceEvent> = events.drain(..).collect();
        let batch = ExperienceEventBatch::new(owner_id, event_list);

        *last_flush = Utc::now();
        debug!("Flushed batch with {} events", batch.events.len());
        Some(batch)
    }

    /// Get the current queue size
    pub async fn len(&self) -> usize {
        self.events.lock().await.len()
    }

    /// Check if the queue is empty
    pub async fn is_empty(&self) -> bool {
        self.events.lock().await.is_empty()
    }

    /// Clear all events from the queue
    #[instrument(skip(self))]
    pub async fn clear(&self) {
        let mut events = self.events.lock().await;
        events.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use uuid::Uuid;

    #[tokio::test]
    async fn test_add_and_flush() {
        let config = crate::config::ConnectorConfig::default();
        let queue = EventQueue::new(config);

        let event = ExperienceEvent::new(
            hexactra_core::experience::ExperienceOrigin {
                site_url: "https://example.com".to_string(),
                session_id: Uuid::new_v4().to_string(),
                profile_id: None,
            },
            hexactra_core::experience::TaskType::Navigation,
            vec![],
            hexactra_core::experience::TaskOutcome {
                success: true,
                status: hexactra_core::experience::TaskStatus::Completed,
                error_message: None,
                redacted_output: None,
            },
            hexactra_core::experience::EventProvenance {
                agent_id: Uuid::new_v4(),
                model_provider: None,
                model_id: None,
                total_tokens: None,
                total_cost_usd: None,
            },
            hexactra_core::experience::EventConsent {
                opt_in: true,
                owner_id: Uuid::new_v4(),
                revoked: false,
                consent_timestamp: None,
            },
        );

        queue.add_event(event).await.unwrap();
        assert_eq!(queue.len().await, 1);

        let batch = queue.flush().await.unwrap();
        assert_eq!(batch.events.len(), 1);
        assert!(queue.is_empty().await);
    }

    #[tokio::test]
    async fn test_queue_full() {
        let config = crate::config::ConnectorConfig {
            max_events_per_batch: 2,
            ..Default::default()
        };
        let queue = EventQueue::new(config);

        let event = ExperienceEvent::new(
            hexactra_core::experience::ExperienceOrigin {
                site_url: "https://example.com".to_string(),
                session_id: Uuid::new_v4().to_string(),
                profile_id: None,
            },
            hexactra_core::experience::TaskType::Navigation,
            vec![],
            hexactra_core::experience::TaskOutcome {
                success: true,
                status: hexactra_core::experience::TaskStatus::Completed,
                error_message: None,
                redacted_output: None,
            },
            hexactra_core::experience::EventProvenance {
                agent_id: Uuid::new_v4(),
                model_provider: None,
                model_id: None,
                total_tokens: None,
                total_cost_usd: None,
            },
            hexactra_core::experience::EventConsent {
                opt_in: true,
                owner_id: Uuid::new_v4(),
                revoked: false,
                consent_timestamp: None,
            },
        );

        queue.add_event(event.clone()).await.unwrap();
        queue.add_event(event.clone()).await.unwrap();
        let result = queue.add_event(event).await;

        assert!(matches!(result, Err(ConnectorError::Queue(_))));
    }
}
