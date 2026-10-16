//! State management for Hexactra control plane

use anyhow::Result;

/// State storage interface
pub trait StateStorage {
    fn get_session(&self, id: &str) -> Result<Option<String>>;
    fn set_session(&mut self, id: &str, data: String) -> Result<()>;
}
