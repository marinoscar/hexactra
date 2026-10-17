//! Type definitions for model adapter

use super::*;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_message_role_serialization() {
        let role = MessageRole::User;
        let json = serde_json::to_string(&role).unwrap();
        assert_eq!(json, "\"user\"");

        let role = MessageRole::Assistant;
        let json = serde_json::to_string(&role).unwrap();
        assert_eq!(json, "\"assistant\"");
    }

    #[test]
    fn test_chat_message_serialization() {
        let message = ChatMessage {
            role: MessageRole::User,
            content: "Hello".to_string(),
            name: None,
        };

        let json = serde_json::to_string(&message).unwrap();
        assert!(json.contains("\"user\""));
        assert!(json.contains("\"Hello\""));
    }

    #[test]
    fn test_tool_serialization() {
        let tool = Tool {
            r#type: ToolType::Function,
            function: FunctionDefinition {
                name: "test".to_string(),
                description: Some("test function".to_string()),
                parameters: Some(serde_json::json!({"type": "object"})),
            },
        };

        let json = serde_json::to_string(&tool).unwrap();
        assert!(json.contains("\"function\""));
    }

    #[test]
    fn test_completion_response_serialization() {
        let response = ChatCompletionResponse {
            id: "test-id".to_string(),
            object: "chat.completion".to_string(),
            created: 1234567890,
            model: "test-model".to_string(),
            choices: vec![Choice {
                index: 0,
                message: ChatMessage {
                    role: MessageRole::Assistant,
                    content: "Response".to_string(),
                    name: None,
                },
                finish_reason: Some("stop".to_string()),
            }],
            usage: Some(Usage {
                prompt_tokens: 10,
                completion_tokens: 5,
                total_tokens: 15,
            }),
        };

        let json = serde_json::to_string(&response).unwrap();
        assert!(json.contains("\"test-id\""));
    }
}
