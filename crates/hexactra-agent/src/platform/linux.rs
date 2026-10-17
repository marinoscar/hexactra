//! Linux platform implementation for host agent
//!
//! This module provides Linux-specific implementations for:
//! - Process management using standard Unix primitives
//! - X11 display handling
//! - D-Bus session discovery
//! - Profile management in standard Linux locations

use anyhow::Result;
use std::io::{Read, Write};
use std::path::PathBuf;

use super::*;

/// Linux platform implementation
pub struct LinuxPlatform;

impl HostPlatform for LinuxPlatform {
    fn platform_name() -> &'static str {
        "linux"
    }

    fn get_capabilities() -> PlatformCapabilities {
        PlatformCapabilities {
            supports_interactive_sessions: true,
            supports_unattended_sessions: true,
            supports_gui_automation: true,
            supports_native_messaging: true,
        }
    }

    fn get_session_state() -> Result<SessionState> {
        // Check if X11 display is available
        if std::env::var("DISPLAY").is_ok() || std::env::var("WAYLAND_DISPLAY").is_ok() {
            // Check if session is locked (simplified: check for screen saver)
            if std::process::Command::new("loginctl")
                .arg("show-session")
                .arg("current")
                .output()
                .map(|o| String::from_utf8_lossy(&o.stdout).contains("LockedHint=yes"))
                .unwrap_or(false)
            {
                return Ok(SessionState::Locked);
            }
            Ok(SessionState::Interactive)
        } else if std::env::var("DBUS_SESSION_BUS_ADDRESS").is_ok() {
            // D-Bus session exists but no display - could be headless
            Ok(SessionState::Console)
        } else {
            Ok(SessionState::None)
        }
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
        
        if config.detached {
            // For true detachment on Linux, we'd use setsid()
            // This is a simplified version
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
        // Send SIGTERM first
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
            .unwrap_or_else(|| PathBuf::from("/tmp"))
    }

    fn get_temp_dir() -> PathBuf {
        std::env::temp_dir()
    }

    fn create_ipc_endpoint(endpoint: IpcEndpoint) -> Result<Box<dyn IpcServer>> {
        // For Linux, we use Unix domain sockets
        match endpoint.endpoint_type {
            IpcType::Unix => Ok(Box::new(LinuxIpcServer::new(endpoint.path)?)),
            IpcType::NamedPipe => {
                Err(anyhow::anyhow!("Named pipes not supported on Linux"))
            }
        }
    }

    fn connect_to_ipc(endpoint: IpcEndpoint) -> Result<Box<dyn IpcClient>> {
        match endpoint.endpoint_type {
            IpcType::Unix => Ok(Box::new(LinuxIpcClient::new(endpoint.path)?)),
            IpcType::NamedPipe => {
                Err(anyhow::anyhow!("Named pipes not supported on Linux"))
            }
        }
    }

    fn get_default_display() -> Result<String> {
        std::env::var("DISPLAY")
            .or_else(|_| std::env::var("WAYLAND_DISPLAY"))
            .map_err(|_| anyhow::anyhow!("No display found"))
    }

    fn is_gui_automation_available() -> bool {
        // Check for X11 or Wayland
        std::env::var("DISPLAY").is_ok() || std::env::var("WAYLAND_DISPLAY").is_ok()
    }

    fn get_profile_dir(username: &str) -> PathBuf {
        PathBuf::from("/home").join(username)
    }

    fn register_native_messaging_host(_manifest_path: &Path) -> Result<()> {
        // On Linux, native messaging manifests go in:
        // - Chrome: ~/.config/google-chrome/NativeMessagingHosts/
        // - Chromium: ~/.config/chromium/NativeMessagingHosts/
        // This is a simplified placeholder
        Ok(())
    }

    fn unregister_native_messaging_host(_name: &str) -> Result<()> {
        Ok(())
    }
}

/// Linux IPC server implementation using Unix domain sockets
struct LinuxIpcServer {
    socket_path: PathBuf,
    listener: Option<std::os::unix::net::UnixListener>,
}

impl LinuxIpcServer {
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

impl IpcServer for LinuxIpcServer {
    fn start(&mut self) -> Result<()> {
        // Already bound in new()
        Ok(())
    }

    fn accept(&mut self) -> Result<Box<dyn IpcConnection>> {
        let (stream, _) = self.listener.as_mut().ok_or_else(|| anyhow::anyhow!("Not started"))?.accept()
            .map_err(|e| anyhow::anyhow!("Failed to accept connection: {}", e))?;
        Ok(Box::new(LinuxIpcConnection { stream }))
    }

    fn stop(&mut self) -> Result<()> {
        self.listener = None;
        if self.socket_path.exists() {
            std::fs::remove_file(&self.socket_path)?;
        }
        Ok(())
    }
}

/// Linux IPC client implementation using Unix domain sockets
struct LinuxIpcClient {
    socket_path: PathBuf,
    stream: Option<std::os::unix::net::UnixStream>,
}

impl LinuxIpcClient {
    fn new(socket_path: PathBuf) -> Result<Self> {
        Ok(Self {
            socket_path,
            stream: None,
        })
    }
}

impl IpcClient for LinuxIpcClient {
    fn connect(&mut self) -> Result<()> {
        let stream = std::os::unix::net::UnixStream::connect(&self.socket_path)?;
        self.stream = Some(stream);
        Ok(())
    }

    fn send(&mut self, data: &[u8]) -> Result<()> {
        if let Some(stream) = &mut self.stream {
            stream.write_all(data)?;
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

/// Linux IPC connection implementation
struct LinuxIpcConnection {
    stream: std::os::unix::net::UnixStream,
}

impl IpcConnection for LinuxIpcConnection {
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
    fn test_linux_platform_name() {
        assert_eq!(LinuxPlatform::platform_name(), "linux");
    }

    #[test]
    fn test_linux_capabilities() {
        let caps = LinuxPlatform::get_capabilities();
        assert!(caps.supports_interactive_sessions);
        assert!(caps.supports_unattended_sessions);
    }

    #[test]
    fn test_get_home_dir() {
        let home = LinuxPlatform::get_home_dir();
        assert!(!home.as_os_str().is_empty());
    }
}
