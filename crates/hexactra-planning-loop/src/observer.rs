//! Observer module for consuming browser worker snapshots

use anyhow::Result;
use async_trait::async_trait;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::{ActionProposal, Observation};

/// Source of observations from browser worker
#[async_trait]
pub trait ObservationSource: Send + Sync {
    async fn take_snapshot(&self, session_id: Uuid) -> Result<Observation>;
}

/// In-memory observation source for testing
pub struct MemoryObservationSource {
    snapshots: Vec<Observation>,
}

impl MemoryObservationSource {
    pub fn new(snapshots: Vec<Observation>) -> Self {
        Self { snapshots }
    }

    pub fn with_single(snapshot: Observation) -> Self {
        Self {
            snapshots: vec![snapshot],
        }
    }
}

#[async_trait]
impl ObservationSource for MemoryObservationSource {
    async fn take_snapshot(&self, _session_id: Uuid) -> Result<Observation> {
        self.snapshots
            .first()
            .cloned()
            .ok_or_else(|| anyhow::anyhow!("No snapshot available"))
    }
}

/// Observer that consumes observations from a source
pub struct Observer<S: ObservationSource> {
    source: S,
}

impl<S: ObservationSource> Observer<S> {
    pub fn new(source: S) -> Self {
        Self { source }
    }

    pub async fn observe(&self, session_id: Uuid) -> Result<Observation> {
        self.source.take_snapshot(session_id).await
    }
}

/// Builder for creating observations
pub struct ObservationBuilder {
    timestamp: DateTime<Utc>,
    session_id: Uuid,
    page_url: String,
    dom_snapshot: serde_json::Value,
    viewport_size: (u32, u32),
    focused_element: Option<String>,
}

impl ObservationBuilder {
    pub fn new(session_id: Uuid) -> Self {
        Self {
            timestamp: Utc::now(),
            session_id,
            page_url: String::new(),
            dom_snapshot: serde_json::json!({}),
            viewport_size: (1920, 1080),
            focused_element: None,
        }
    }

    pub fn page_url(mut self, url: impl Into<String>) -> Self {
        self.page_url = url.into();
        self
    }

    pub fn dom_snapshot(mut self, snapshot: serde_json::Value) -> Self {
        self.dom_snapshot = snapshot;
        self
    }

    pub fn viewport_size(mut self, width: u32, height: u32) -> Self {
        self.viewport_size = (width, height);
        self
    }

    pub fn focused_element(mut self, element: impl Into<String>) -> Self {
        self.focused_element = Some(element.into());
        self
    }

    pub fn build(self) -> Observation {
        Observation {
            timestamp: self.timestamp,
            session_id: self.session_id,
            page_url: self.page_url,
            dom_snapshot: self.dom_snapshot,
            viewport_size: self.viewport_size,
            focused_element: self.focused_element,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_memory_observation_source() {
        let session_id = Uuid::new_v4();
        let observation = ObservationBuilder::new(session_id)
            .page_url("https://example.com")
            .build();

        let source = MemoryObservationSource::with_single(observation.clone());
        let observer = Observer::new(source);

        let result = observer.observe(session_id).await;
        assert!(result.is_ok());
        assert_eq!(result.unwrap().page_url, "https://example.com");
    }

    #[tokio::test]
    async fn test_memory_observation_source_empty() {
        let source = MemoryObservationSource::new(vec![]);
        let observer = Observer::new(source);

        let result = observer.observe(Uuid::new_v4()).await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_observation_builder() {
        let session_id = Uuid::new_v4();
        let observation = ObservationBuilder::new(session_id)
            .page_url("https://test.com")
            .viewport_size(1280, 720)
            .focused_element("input#search")
            .build();

        assert_eq!(observation.page_url, "https://test.com");
        assert_eq!(observation.viewport_size, (1280, 720));
        assert_eq!(observation.focused_element, Some("input#search".to_string()));
    }
}
