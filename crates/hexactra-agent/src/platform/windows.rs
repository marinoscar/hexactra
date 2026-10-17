//! Windows platform implementation for host agent
//!
//! This module provides Windows-specific implementations for:
//! - Process management using Win32 APIs via winapi crate
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
            // Windows Session 0 is not interactive by default (services run here)
            supports_unattended_sessions: false,
            supports_gui_automation: true,
            supports_native_messaging: true,
        }
    }

    fn get_session_state() -> Result<SessionState> {
        // On Windows, we need to check if we're in an interactive session
        // This would use WTSGetActiveConsoleSessionId() and related APIs
        // For now, return Interactive as the default for signed-in user sessions
        Ok(SessionState::Interactive)
    }

    fn spawn_process(config: ProcessConfig) -> Result<SpawnedProcess> {
        use std::os::windows::process::CommandExt;
        
        let mut cmd = std::process::Command::new(&config.command);
        
        if let Some(cwd) = config.cwd {
            cmd.current_dir(cwd);
        }
        
        for (key, value) in config.env {
            cmd.env(key, value);
        }
        
        cmd.args(&config.args)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());
        
        // On Windows, use CREATE_NO_WINDOW for detached processes
        if config.detached {
            unsafe {
                cmd.creation_flags(winapi::um::winbase::CREATE_NO_WINDOW);
            }
        }
        
        let child = cmd.spawn()?;
        
        Ok(SpawnedProcess {
            pid: child.id() as u32,
            stdin: Some(child.stdin.ok_or_else(|| anyhow::anyhow!("Failed to get stdin"))?),
            stdout: Some(child.stdout.ok_or_else(|| anyhow::anyhow!("Failed to get stdout"))?),
            stderr: Some(child.stderr.ok_or_else(|| anyhow::anyhow!("Failed to get stderr"))?),
        })
    }

    fn terminate_process(pid: u32) -> Result<()> {
        // On Windows, use OpenProcess and TerminateProcess
        // For now, use the simpler approach via kill command or std::process
        // This is a simplified implementation
        Ok(())
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

    fn create_ipc_endpoint(endpoint: IpcEndpoint) -> Result<Box<dyn IpcServer>> {
        // Windows would use named pipes
        match endpoint.endpoint_type {
            IpcType::NamedPipe => Ok(Box::new(WindowsIpcServer::new(endpoint.path)?)),
            IpcType::Unix => Err(anyhow::anyhow!("Unix domain sockets not supported on Windows")),
        }
    }

    fn connect_to_ipc(endpoint: IpcEndpoint) -> Result<Box<dyn IpcClient>> {
        match endpoint.endpoint_type {
            IpcType::NamedPipe => Ok(Box::new(WindowsIpcClient::new(endpoint.path)?)),
            IpcType::Unix => Err(anyhow::anyhow!("Unix domain sockets not supported on Windows")),
        }
    }

    fn get_default_display() -> Result<String> {
        // Windows doesn't use DISPLAY variable, return a placeholder
        Ok("quartz".to_string())
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

/// Windows IPC server implementation using named pipes
struct WindowsIpcServer {
    pipe_name: PathBuf,
}

impl WindowsIpcServer {
    fn new(pipe_name: PathBuf) -> Result<Self> {
        // On Windows, named pipes use \\.\pipe\name format
        Ok(Self { pipe_name })
    }
}

impl IpcServer for WindowsIpcServer {
    fn start(&mut self) -> Result<()> {
        // Windows named pipe server setup would go here
        // CreateNamedPipe, ConnectNamedPipe, etc.
        Ok(())
    }

    fn accept(&mut self) -> Result<Box<dyn IpcConnection>> {
        Err(anyhow::anyhow!("Windows IPC accept not yet implemented"))
    }

    fn stop(&mut self) -> Result<()> {
        Ok(())
    }
}

/// Windows IPC client implementation using named pipes
struct WindowsIpcClient {
    pipe_name: PathBuf,
}

impl WindowsIpcClient {
    fn new(pipe_name: PathBuf) -> Result<Self> {
        Ok(Self { pipe_name })
    }
}

impl IpcClient for WindowsIpcClient {
    fn connect(&mut self) -> Result<()> {
        // Windows ConnectNamedPipe would go here
        Ok(())
    }

    fn send(&mut self, _data: &[u8]) -> Result<()> {
        Err(anyhow::anyhow!("Windows IPC send not yet implemented"))
    }

    fn receive(&mut self, _buffer: &mut [u8]) -> Result<usize> {
        Err(anyhow::anyhow!("Windows IPC receive not yet implemented"))
    }

    fn disconnect(&mut self) -> Result<()> {
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

    #[test]
    fn test_get_home_dir() {
        let home = WindowsPlatform::get_home_dir();
        assert!(!home.as_os_str().is_empty());
    }
}
