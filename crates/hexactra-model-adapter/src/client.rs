//! OpenAI-compatible HTTP client for model adapter

use super::*;
use anyhow::Context;
use std::time::Instant;

/// OpenAI-compatible HTTP client
pub struct OpenAIClient {
    config: ModelConfig,
    client: reqwest::Client,
}

impl OpenAIClient {
    /// Create a new OpenAI-compatible client
    pub fn new(config: ModelConfig) -> Result<Self> {
        let client = reqwest::Client::builder()
            .timeout(config.request_timeout)
            .build()
            .map_err(|e| ModelAdapterError::InvalidConfig(format!("Failed to build HTTP client: {}", e)))?;

        Ok(Self { config, client })
    }

    /// Get the model configuration
    pub fn config(&self) -> &ModelConfig {
        &self.config
    }

    /// Validate the model configuration
    pub fn validate(&self) -> Result<()> {
        if self.config.base_url.is_empty() {
            return Err(ModelAdapterError::InvalidConfig(
                "base_url cannot be empty".to_string(),
            ));
        }

        // Try to parse the URL to validate it
        url::Url::parse(&self.config.base_url).map_err(|e| {
            ModelAdapterError::InvalidConfig(format!("Invalid base_url: {}", e))
        })?;

        Ok(())
    }

    /// Build the request URL for completions
    fn build_url(&self) -> String {
        format!("{}/chat/completions", self.config.base_url.trim_end_matches('/'))
    }

    /// Build headers for the request
    fn build_headers(&self) -> reqwest::header::HeaderMap {
        let mut headers = reqwest::header::HeaderMap::new();
        headers.insert(
            reqwest::header::CONTENT_TYPE,
            reqwest::header::HeaderValue::from_static("application/json"),
        );

        if let Some(api_key) = &self.config.api_key {
            headers.insert(
                reqwest::header::AUTHORIZATION,
                reqwest::header::HeaderValue::from_str(&format!("Bearer {}", api_key)).expect(
                    "Failed to create authorization header - API key contains invalid characters",
                ),
            );
        }

        headers
    }

    /// Send a chat completion request
    pub async fn chat_completion(
        &self,
        messages: Vec<ChatMessage>,
        tools: Option<Vec<Tool>>,
    ) -> Result<ChatCompletionResponse> {
        let _span = start_span("model.chat_completion", &self.config.model_id);
        
        self.validate()?;

        let url = self.build_url();
        let headers = self.build_headers();

        // Build the request body
        let mut body = serde_json::json!({
            "model": self.config.model_id,
            "messages": messages,
            "stream": self.config.stream,
        });

        // Add optional parameters
        if let Some(max_tokens) = self.config.max_tokens {
            body["max_tokens"] = serde_json::Value::from(max_tokens);
        }

        if let Some(temperature) = self.config.temperature {
            body["temperature"] = serde_json::Value::from(temperature);
        }

        // Add tools if supported and provided
        if self.config.capabilities.tool_calling {
            if let Some(tools_vec) = tools {
                body["tools"] = serde_json::to_value(tools_vec).map_err(|e| {
                    ModelAdapterError::InvalidConfig(format!("Failed to serialize tools: {}", e))
                })?;
            }
        } else if tools.is_some() {
            return Err(ModelAdapterError::ToolCallingNotSupported);
        }

        // Send the request
        let start_time = Instant::now();
        let response = self
            .client
            .post(&url)
            .headers(headers)
            .json(&body)
            .send()
            .await?;

        let status = response.status();
        let response_body = response.text().await?;

        // Check for errors
        if !status.is_success() {
            return Err(self.handle_error(status.as_u16() as u32, &response_body));
        }

        // Parse the response
        let completion: ChatCompletionResponse = serde_json::from_str(&response_body).map_err(|e| {
            ModelAdapterError::InvalidResponse(format!("Failed to parse response: {}", e))
        })?;

        info!(
            "Chat completion completed in {:?}, model: {}",
            start_time.elapsed(),
            self.config.model_id
        );

        Ok(completion)
    }

    /// Handle HTTP errors
    fn handle_error(&self, status: u32, body: &str) -> ModelAdapterError {
        match status {
            401 => ModelAdapterError::HttpError {
                status,
                body: format!("Unauthorized: {}", body),
            },
            403 => ModelAdapterError::HttpError {
                status,
                body: format!("Forbidden: {}", body),
            },
            429 => ModelAdapterError::RateLimitExceeded,
            408 => ModelAdapterError::Timeout,
            _ => ModelAdapterError::HttpError {
                status,
                body: format!("Unexpected error: {}", body),
            },
        }
    }

    /// Test the connection to the model endpoint
    pub async fn test_connection(&self) -> Result<()> {
        let _span = start_span("model.test_connection", &self.config.model_id);
        
        let url = self.build_url();
        let headers = self.build_headers();

        // Send a minimal test request
        let test_messages = vec![ChatMessage {
            role: MessageRole::User,
            content: "test".to_string(),
            name: None,
        }];

        let body = serde_json::json!({
            "model": self.config.model_id,
            "messages": test_messages,
            "max_tokens": 1
        });

        let response = self
            .client
            .post(&url)
            .headers(headers)
            .json(&body)
            .send()
            .await?;

        if !response.status().is_success() {
            let status = response.status().as_u16() as u32;
            let body = response.text().await.unwrap_or_default();
            return Err(ModelAdapterError::HttpError { status, body }.into());
        }

        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_openai_client_creation() {
        let config = ModelConfig::default();
        let client = OpenAIClient::new(config);
        assert!(client.is_ok());
    }

    #[test]
    fn test_openai_client_validation() {
        let mut config = ModelConfig::default();
        config.base_url = "".to_string();
        let client = OpenAIClient::new(config.clone()).unwrap();
        assert!(client.validate().is_err());

        // Valid URLs should work
        config.base_url = "http://localhost:11434/v1".to_string();
        let client = OpenAIClient::new(config).unwrap();
        assert!(client.validate().is_ok());
    }
}
