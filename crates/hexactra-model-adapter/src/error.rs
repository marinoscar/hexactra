//! Error types for model adapter

use super::ModelAdapterError;
use std::fmt;

/// Result type for model adapter operations
pub type Result<T> = std::result::Result<T, ModelAdapterError>;

/// Extension trait for converting reqwest errors
pub trait RequestErrorExt {
    fn into_model_adapter_error(self) -> ModelAdapterError;
}

impl RequestErrorExt for reqwest::Error {
    fn into_model_adapter_error(self) -> ModelAdapterError {
        if self.is_timeout() {
            ModelAdapterError::Timeout
        } else if self.is_redirect() {
            ModelAdapterError::InvalidConfig("Redirect not allowed".to_string())
        } else if self.is_status() {
            ModelAdapterError::HttpError {
                status: self.status().map_or(500, |s| s.as_u16() as u32),
                body: self.to_string(),
            }
        } else {
            ModelAdapterError::Network(self.to_string())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_error_display() {
        let err = ModelAdapterError::InvalidConfig("test".to_string());
        assert_eq!(format!("{}", err), "Invalid configuration: test");

        let err = ModelAdapterError::Timeout;
        assert_eq!(format!("{}", err), "Timeout error");
    }
}
