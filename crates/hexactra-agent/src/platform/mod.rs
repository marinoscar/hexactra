//! Platform-specific host agent abstractions
//!
//! This module provides cross-platform abstractions for:
//! - Process spawn/terminate
//! - Session discovery and lifecycle
//! - Inter-process communication (IPC)
//! - Display management
//! - User profile management
//! - Secure storage

use anyhow::Result;
use std::path::{Path, PathBuf};

/// Platform capability flags
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PlatformCapabilities {
    /// Supports interactive desktop sessions
    pub supports_interactive_sessions: bool,
    /// Supports unattended sessions (no user logged in)
    pub supports_unattended_sessions: bool,
    /// Supports GUI automation
    pub supports_gui_automation: bool,
    /// Supports native messaging host registration
    pub supports_native_messaging: bool,
}

/// Session state enumeration
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SessionState {
    /// No session active
    None,
    /// Active console session (Linux) / Session 0 (Windows)
    Console,
    /// User-interactive session
    Interactive,
    /// Locked session
    Locked,
}

/// Platform-specific process configuration
#[derive(Debug, Clone)]
pub struct ProcessConfig {
    /// Command to execute
    pub command: String,
    /// Arguments to pass
    pub args: Vec<String>,
    /// Working directory
    pub cwd: Option<PathBuf>,
    /// Environment variables
    pub env: std::collections::HashMap<String, String>,
    /// Whether to detach from parent
    pub detached: bool,
}

/// Platform-specific IPC endpoint
#[derive(Debug, Clone)]
pub struct IpcEndpoint {
    /// Path to Unix socket or named pipe
    pub path: PathBuf,
    /// Endpoint type
    pub endpoint_type: IpcType,
}

/// IPC endpoint types
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum IpcType {
    /// Unix domain socket (Linux/macOS)
    Unix,
    /// Named pipe (Windows)
    NamedPipe,
}

/// Platform trait for host agent operations
pub trait HostPlatform {
    /// Get the platform name
    fn platform_name() -> &'static str;

    /// Get platform capabilities
    fn get_capabilities() -> PlatformCapabilities;

    /// Get current session state
    fn get_session_state() -> Result<SessionState>;

    /// Spawn a new process with platform-specific configuration
    fn spawn_process(config: ProcessConfig) -> Result<SpawnedProcess>;

    /// Terminate a process by PID
    fn terminate_process(pid: u32) -> Result<()>;

    /// Get the path to the user's home directory
    fn get_home_dir() -> PathBuf;

    /// Get the path to the system temporary directory
    fn get_temp_dir() -> PathBuf;

    /// Create a new IPC endpoint
    fn create_ipc_endpoint(endpoint: IpcEndpoint) -> Result<Box<dyn IpcServer>>;

    /// Connect to an IPC endpoint
    fn connect_to_ipc(endpoint: IpcEndpoint) -> Result<Box<dyn IpcClient>>;

    /// Get the default display identifier
    fn get_default_display() -> Result<String>;

    /// Check if GUI automation is available
    fn is_gui_automation_available() -> bool;

    /// Get the profile directory for a user
    fn get_profile_dir(username: &str) -> PathBuf;

    /// Register a native messaging host
    fn register_native_messaging_host(manifest_path: &Path) -> Result<()>;

    /// Unregister a native messaging host
    fn unregister_native_messaging_host(name: &str) -> Result<()>;
}

/// Spawning result
#[derive(Debug)]
pub struct SpawnedProcess {
    /// Process ID
    pub pid: u32,
    /// Standard input handle
    pub stdin: Option<std::process::ChildStdin>,
    /// Standard output handle
    pub stdout: Option<std::process::ChildStdout>,
    /// Standard error handle
    pub stderr: Option<std::process::ChildStderr>,
}

/// IPC server trait for platform-specific implementations
pub trait IpcServer {
    /// Start listening for connections
    fn start(&mut self) -> Result<()>;
    /// Accept a new connection
    fn accept(&mut self) -> Result<Box<dyn IpcConnection>>;
    /// Stop listening
    fn stop(&mut self) -> Result<()>;
}

/// IPC client trait for platform-specific implementations
pub trait IpcClient {
    /// Connect to the server
    fn connect(&mut self) -> Result<()>;
    /// Send data to the server
    fn send(&mut self, data: &[u8]) -> Result<()>;
    /// Receive data from the server
    fn receive(&mut self, buffer: &mut [u8]) -> Result<usize>;
    /// Disconnect from the server
    fn disconnect(&mut self) -> Result<()>;
}

/// IPC connection trait for platform-specific implementations
pub trait IpcConnection {
    /// Read data from the connection
    fn read(&mut self, buffer: &mut [u8]) -> Result<usize>;
    /// Write data to the connection
    fn write(&mut self, data: &[u8]) -> Result<()>;
    /// Close the connection
    fn close(&mut self) -> Result<()>;
}

// Platform-specific implementations will be provided in separate modules

#[cfg(target_os = "linux")]
pub mod linux;

#[cfg(target_os = "windows")]
pub mod windows;

#[cfg(target_os = "macos")]
pub mod macos;

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::*;

    #[test]
    fn test_platform_capabilities() {
        let caps = PlatformCapabilities {
            supports_interactive_sessions: true,
            supports_unattended_sessions: false,
            supports_gui_automation: true,
            supports_native_messaging: true,
        };
        assert!(caps.supports_interactive_sessions);
        assert!(caps.supports_gui_automation);
    }

    #[test]
    fn test_process_config() {
        let config = ProcessConfig {
            command: "echo".to_string(),
            args: vec!["hello".to_string()],
            cwd: None,
            env: std::collections::HashMap::new(),
            detached: false,
        };
        assert_eq!(config.command, "echo");
        assert_eq!(config.args.len(), 1);
    }

    #[test]
    fn test_ipc_endpoint() {
        let endpoint = IpcEndpoint {
            path: PathBuf::from("/tmp/test.sock"),
            endpoint_type: IpcType::Unix,
        };
        assert_eq!(endpoint.endpoint_type, IpcType::Unix);
    }
}
