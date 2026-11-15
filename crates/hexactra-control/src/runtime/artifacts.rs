//! Short-lived artifacts (#214): screenshot bytes held by the control plane
//! and handed out by id, so large data does not travel inside operation
//! results (VISION: artifacts move by short-lived authorized handles).
//!
//! In memory only, bounded by total size and age; the oldest go first. A
//! fetch needs a client token (`GET /v1/artifacts/{id}`). Never persisted.

use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use chrono::{DateTime, Utc};
use uuid::Uuid;

/// How long an artifact can be fetched.
pub const ARTIFACT_TTL: Duration = Duration::from_secs(15 * 60);
/// Most bytes held at once.
pub const ARTIFACT_MAX_BYTES: usize = 256 * 1024 * 1024;

/// One stored artifact.
#[derive(Clone)]
pub struct Artifact {
    pub id: Uuid,
    pub session_id: Uuid,
    pub mime: String,
    pub bytes: Arc<Vec<u8>>,
    pub expires_at: DateTime<Utc>,
}

#[derive(Default)]
struct Inner {
    by_id: HashMap<Uuid, Artifact>,
    order: VecDeque<Uuid>,
    total: usize,
}

/// The artifact store. Cheap to clone.
#[derive(Clone)]
pub struct ArtifactStore {
    inner: Arc<Mutex<Inner>>,
    ttl: Duration,
    max_bytes: usize,
}

impl Default for ArtifactStore {
    fn default() -> Self {
        Self::new(ARTIFACT_TTL, ARTIFACT_MAX_BYTES)
    }
}

impl ArtifactStore {
    pub fn new(ttl: Duration, max_bytes: usize) -> Self {
        Self {
            inner: Default::default(),
            ttl,
            max_bytes,
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn evict(inner: &mut Inner, now: DateTime<Utc>, need: usize, max: usize) {
        while let Some(id) = inner.order.front().copied() {
            let expired = inner
                .by_id
                .get(&id)
                .map(|a| a.expires_at <= now)
                .unwrap_or(true);
            if !expired && inner.total + need <= max {
                break;
            }
            inner.order.pop_front();
            if let Some(a) = inner.by_id.remove(&id) {
                inner.total -= a.bytes.len();
            }
        }
    }

    /// Store bytes; returns the artifact (with its id and expiry).
    pub fn put(&self, session_id: Uuid, mime: &str, bytes: Vec<u8>) -> Artifact {
        let now = Utc::now();
        let a = Artifact {
            id: Uuid::new_v4(),
            session_id,
            mime: mime.to_string(),
            bytes: Arc::new(bytes),
            expires_at: now + chrono::Duration::from_std(self.ttl).unwrap_or_default(),
        };
        let mut inner = self.lock();
        Self::evict(&mut inner, now, a.bytes.len(), self.max_bytes);
        inner.total += a.bytes.len();
        inner.order.push_back(a.id);
        inner.by_id.insert(a.id, a.clone());
        a
    }

    /// A live artifact, or `None` when unknown or expired.
    pub fn get(&self, id: Uuid) -> Option<Artifact> {
        let mut inner = self.lock();
        Self::evict(&mut inner, Utc::now(), 0, self.max_bytes);
        inner.by_id.get(&id).cloned()
    }

    /// Bytes held now.
    pub fn total_bytes(&self) -> usize {
        self.lock().total
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn expired_artifacts_are_gone() {
        let s = ArtifactStore::new(Duration::from_millis(0), 1024);
        let a = s.put(Uuid::new_v4(), "image/jpeg", vec![1, 2, 3]);
        assert!(s.get(a.id).is_none());
        assert_eq!(s.total_bytes(), 0);
    }

    #[test]
    fn the_oldest_make_room_for_new_ones() {
        let s = ArtifactStore::new(Duration::from_secs(60), 10);
        let a = s.put(Uuid::new_v4(), "image/jpeg", vec![0; 6]);
        let b = s.put(Uuid::new_v4(), "image/jpeg", vec![0; 6]);
        assert!(s.get(a.id).is_none());
        assert_eq!(s.get(b.id).unwrap().bytes.len(), 6);
        assert_eq!(s.total_bytes(), 6);
    }
}
