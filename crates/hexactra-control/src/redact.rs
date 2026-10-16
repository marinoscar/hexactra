//! Redacted logging utilities for Hexactra

use serde_json::Value;

/// Redact sensitive fields from a JSON value for logging
pub fn redact_value(value: &Value) -> Value {
    match value {
        Value::Object(map) => {
            let mut new_map = serde_json::Map::new();
            for (key, val) in map {
                if is_secret_key(key) {
                    new_map.insert(key.clone(), Value::String("[REDACTED]".to_string()));
                } else {
                    new_map.insert(key.clone(), redact_value(val));
                }
            }
            Value::Object(new_map)
        }
        Value::Array(arr) => {
            Value::Array(arr.iter().map(redact_value).collect())
        }
        _ => value.clone(),
    }
}

/// Check if a key name suggests a secret value
fn is_secret_key(key: &str) -> bool {
    let lower = key.to_lowercase();
    [
        "password", "secret", "token", "api_key", "apikey", "credential",
        "auth", "bearer", "session_id"
    ].iter().any(|s| lower.contains(s))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_redact_value() {
        let value = serde_json::json!({
            "username": "user123",
            "password": "secret123",
            "token": "bearer_token"
        });

        let redacted = redact_value(&value);
        
        assert_eq!(redacted["username"], "user123");
        assert_eq!(redacted["password"], "[REDACTED]");
        assert_eq!(redacted["token"], "[REDACTED]");
    }

    #[test]
    fn test_is_secret_key() {
        assert!(is_secret_key("password"));
        assert!(is_secret_key("api_key"));
        assert!(is_secret_key("SECRET_TOKEN"));
        assert!(!is_secret_key("username"));
    }
}
