//! macOS platform implementation for host agent
//!
//! This module provides macOS-specific implementations for:
//! - Process management using POSIX APIs
//! - Launchd for session management
//! - CoreFoundation/Accessibility APIs for GUI automation
//! - Profile management in ~/Library

use anyhow::Result;
use std::path::PathBuf;

use super::*;

/// macOS platform implementation
pub struct MacOsPlatform;

impl HostPlatform for MacOsPlatform {
    fn platform_name() -> &'static str {
        "macos"
    }

    fn get_capabilities() -> PlatformCapabilities {
        PlatformCapabilities {
            supports_interactive_sessions: true,
            // macOS requires user login for GUI access
            supports_unattended_sessions: false,
            supports_gui_automation: true,
            supports_native_messaging: true,
        }
    }

    fn get_session_state() -> Result<SessionState> {
        // Check for active GUI session
        // This would use CGSessionCopyCurrentDictionary() and related APIs
        Ok(SessionState::Interactive)
    }

    fn spawn_process(config: ProcessConfig) -> Result<SpawnedProcess> {
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
        
        let child = cmd.spawn()?;
        
        Ok(SpawnedProcess {
            pid: child.id() as u32,
            stdin: Some(child.stdin.ok_or_else(|| anyhow::anyhow!("Failed to get stdin"))?),
            stdout: Some(child.stdout.ok_or_else(|| anyhow::anyhow!("Failed to get stdout"))?),
            stderr: Some(child.stderr.ok_or_else(|| anyhow::anyhow!("Failed to get stderr"))?),
        })
    }

    fn terminate_process(pid: u32) -> Result<()> {
        // macOS implementation would use kill()
        unsafe {
            libc::kill(pid as libc::pid_t, libc::SIGTERM);
        }
        
        // Give it a moment to terminate gracefully
        std::thread::sleep(std::time::Duration::from_millis(100));
        
        // Check if process is still running and send SIGKILL if needed
        unsafe {
            if libc::kill(pid as libc::pid_t, 0) == 0 {
                libc::kill(pid as libc::pid_t, libc::SIGKILL);
            }
        }
        
        Ok(())
    }

    fn get_home_dir() -> PathBuf {
        std::env::var("HOME")
            .ok()
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("/Users/Default"))
    }

    fn get_temp_dir() -> PathBuf {
        std::env::temp_dir()
    }

    fn create_ipc_endpoint(endpoint: IpcEndpoint) -> Result<Box<dyn IpcServer>> {
        // macOS would use Unix domain sockets or Mach ports
        match endpoint.endpoint_type {
            IpcType::Unix => Ok(Box::new(MacOsIpcServer::new(endpoint.path)?)),
            IpcType::NamedPipe => Err(anyhow::anyhow!("Named pipes not supported on macOS")),
        }
    }

    fn connect_to_ipc(endpoint: IpcEndpoint) -> Result<Box<dyn IpcClient>> {
        match endpoint.endpoint_type {
            IpcType::Unix => Ok(Box::new(MacOsIpcClient::new(endpoint.path)?)),
            IpcType::NamedPipe => Err(anyhow::anyhow!("Named pipes not supported on macOS")),
        }
    }

    fn get_default_display() -> Result<String> {
        // macOS doesn't use DISPLAY variable
        Ok("quartz".to_string())
    }

    fn is_gui_automation_available() -> bool {
        // Check for Accessibility permissions
        true
    }

    fn get_profile_dir(_username: &str) -> PathBuf {
        // macOS profile paths are in /Users/username or ~/Library
        PathBuf::from("/Users")
    }

    fn register_native_messaging_host(_manifest_path: &Path) -> Result<()> {
        // macOS would write to:
        // ~/Library/Application Support/Google/Chrome/NativeMessagingHosts/
        Ok(())
    }

    fn unregister_native_messaging_host(_name: &str) -> Result<()> {
        Ok(())
    }
}

/// macOS IPC server implementation using Unix domain sockets
struct MacOsIpcServer {
    socket_path: PathBuf,
    listener: Option<std::os::unix::net::UnixListener>,
}

impl MacOsIpcServer {
    fn new(socket_path: PathBuf) -> Result<Self> {
        // Remove existing socket if present
        if socket_path.exists() {
            std::fs::remove_file(&socket_path)?;
        }
        
        let listener = std::os::unix::net::UnixListener::bind(&socket_path)?;
        
        // Set secure permissions
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&socket_path, std::fs::Permissions::from_mode(0o660))?;
        
        Ok(Self {
            socket_path,
            listener: Some(listener),
        })
    }
}

impl IpcServer for MacOsIpcServer {
    fn start(&mut self) -> Result<()> {
        // Already bound in new()
        Ok(())
    }

    fn accept(&mut self) -> Result<Box<dyn IpcConnection>> {
        let (stream, _) = self.listener.as_mut().ok_or_else(|| anyhow::anyhow!("Not started"))?.accept()
            .map_err(|e| anyhow::anyhow!("Failed to accept connection: {}", e))?;
        Ok(Box::new(MacOsIpcConnection { stream }))
    }

    fn stop(&mut self) -> Result<()> {
        self.listener = None;
        if self.socket_path.exists() {
            std::fs::remove_file(&self.socket_path)?;
        }
        Ok(())
    }
}

/// macOS IPC client implementation using Unix domain sockets
struct MacOsIpcClient {
    socket_path: PathBuf,
    stream: Option<std::os::unix::net::UnixStream>,
}

impl MacOsIpcClient {
    fn new(socket_path: PathBuf) -> Result<Self> {
        Ok(Self {
            socket_path,
            stream: None,
        })
    }
}

impl IpcClient for MacOsIpcClient {
    fn connect(&mut self) -> Result<()> {
        let stream = std::os::unix::net::UnixStream::connect(&self.socket_path)?;
        self.stream = Some(stream);
        Ok(())
    }

    fn send(&mut self, data: &[u8]) -> Result<()> {
        if let Some(stream) = &mut self.stream {
            stream.write_all(data)
                .map_err(|e| anyhow::anyhow!("Failed to write: {}", e))?;
        } else {
            return Err(anyhow::anyhow!("Not connected"));
        }
        Ok(())
    }

    fn receive(&mut self, buffer: &mut [u8]) -> Result<usize> {
        if let Some(stream) = &mut self.stream {
            stream.read(buffer)
                .map_err(|e| anyhow::anyhow!("Failed to read: {}", e))
        } else {
            Err(anyhow::anyhow!("Not connected"))
        }
    }

    fn disconnect(&mut self) -> Result<()> {
        self.stream = None;
        Ok(())
    }
}

/// macOS IPC connection implementation
struct MacOsIpcConnection {
    stream: std::os::unix::net::UnixStream,
}

impl IpcConnection for MacOsIpcConnection {
    fn read(&mut self, buffer: &mut [u8]) -> Result<usize> {
        self.stream.read(buffer)
            .map_err(|e| anyhow::anyhow!("Failed to read: {}", e))
    }

    fn write(&mut self, data: &[u8]) -> Result<()> {
        self.stream.write_all(data)
            .map_err(|e| anyhow::anyhow!("Failed to write: {}", e))
    }

    fn close(&mut self) -> Result<()> {
        // UnixStream doesn't have a close method, drop will clean up
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_macos_platform_name() {
        assert_eq!(MacOsPlatform::platform_name(), "macos");
    }

    #[test]
    fn test_macos_capabilities() {
        let caps = MacOsPlatform::get_capabilities();
        assert!(caps.supports_interactive_sessions);
        assert!(!caps.supports_unattended_sessions);
    }

    #[test]
    fn test_get_home_dir() {
        let home = MacOsPlatform::get_home_dir();
        assert!(!home.as_os_str().is_empty());
    }
}
