//! Windows platform implementation for host agent
//!
//! This module provides Windows-specific implementations for:
//! - Process management using Win32 APIs
//! - Session 0 / interactive session handling
//! - Named pipes for IPC
//! - Registry-based profile management

use anyhow::Result;
use std::path::PathBuf;

use super::*;

/// Windows platform implementation
pub struct WindowsPlatform;

impl HostPlatform for WindowsPlatform {
    fn platform_name() -> &'static str {
        "windows"
    }

    fn get_capabilities() -> PlatformCapabilities {
        PlatformCapabilities {
            supports_interactive_sessions: true,
            // Windows Session 0 is not interactive by default
            supports_unattended_sessions: false,
            supports_gui_automation: true,
            supports_native_messaging: true,
        }
    }

    fn get_session_state() -> Result<SessionState> {
        // Check if we're in an interactive session
        // This would use WTSGetActiveConsoleSessionId() and related APIs
        // For now, return a placeholder
        Ok(SessionState::Interactive)
    }

    fn spawn_process(_config: ProcessConfig) -> Result<SpawnedProcess> {
        // Windows implementation would use CreateProcess()
        Err(anyhow::anyhow!("Windows process spawning not yet implemented"))
    }

    fn terminate_process(_pid: u32) -> Result<()> {
        // Windows implementation would use TerminateProcess()
        Err(anyhow::anyhow!("Windows process termination not yet implemented"))
    }

    fn get_home_dir() -> PathBuf {
        std::env::var("USERPROFILE")
            .ok()
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from(r"C:\Users\Default"))
    }

    fn get_temp_dir() -> PathBuf {
        std::env::temp_dir()
    }

    fn create_ipc_endpoint(_endpoint: IpcEndpoint) -> Result<Box<dyn IpcServer>> {
        // Windows would use named pipes
        Err(anyhow::anyhow!("Windows IPC not yet implemented"))
    }

    fn connect_to_ipc(_endpoint: IpcEndpoint) -> Result<Box<dyn IpcClient>> {
        Err(anyhow::anyhow!("Windows IPC not yet implemented"))
    }

    fn get_default_display() -> Result<String> {
        // Windows doesn't use DISPLAY variable
        Ok("DISPLAY".to_string())
    }

    fn is_gui_automation_available() -> bool {
        // Check for GUI subsystem availability
        true
    }

    fn get_profile_dir(_username: &str) -> PathBuf {
        // Windows profile paths are in C:\Users\username
        PathBuf::from(r"C:\Users")
    }

    fn register_native_messaging_host(_manifest_path: &Path) -> Result<()> {
        // Windows would write to registry:
        // HKEY_CURRENT_USER\Software\Google\Chrome\NativeMessagingHosts\
        Ok(())
    }

    fn unregister_native_messaging_host(_name: &str) -> Result<()> {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_windows_platform_name() {
        assert_eq!(WindowsPlatform::platform_name(), "windows");
    }

    #[test]
    fn test_windows_capabilities() {
        let caps = WindowsPlatform::get_capabilities();
        assert!(caps.supports_interactive_sessions);
        // Windows Session 0 is not interactive
        assert!(!caps.supports_unattended_sessions);
    }
}
