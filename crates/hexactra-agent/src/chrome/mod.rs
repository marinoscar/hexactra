//! Chrome runtime management for Hexactra host agent
//!
//! This module provides functionality to provision and manage isolated graphical
//! Chrome runtime environments on Linux, including virtual display setup,
//! profile isolation, and resource bounding.

use anyhow::{Context, Result};
use std::path::{Path, PathBuf};
use std::process::Command;
use tokio::fs;
use tracing::{debug, error, info, warn};

/// Chrome runtime configuration
#[derive(Debug, Clone)]
pub struct ChromeConfig {
    /// Path to Chrome/Chromium binary
    pub chrome_binary: String,
    /// Path to user data directory (profile)
    pub user_data_dir: String,
    /// Display number for virtual display (e.g., ":99")
    pub display: String,
    /// Extra arguments to pass to Chrome
    pub extra_args: Vec<String>,
    /// Resource limits (memory in MB, CPU cores)
    pub resource_limits: ResourceLimits,
    /// Whether to enable GPU acceleration
    pub enable_gpu: bool,
}

impl Default for ChromeConfig {
    fn default() -> Self {
        Self {
            chrome_binary: "/usr/bin/google-chrome".to_string(),
            user_data_dir: "/var/lib/hexactra/chrome-profiles/default".to_string(),
            display: ":99".to_string(),
            extra_args: Vec::new(),
            resource_limits: ResourceLimits::default(),
            enable_gpu: false,
        }
    }
}

/// Resource limits for Chrome process
#[derive(Debug, Clone)]
pub struct ResourceLimits {
    /// Memory limit in MB
    pub memory_mb: u64,
    /// CPU cores limit
    pub cpu_cores: u32,
    /// Maximum open files
    pub max_open_files: u64,
}

impl Default for ResourceLimits {
    fn default() -> Self {
        Self {
            memory_mb: 2048,
            cpu_cores: 2,
            max_open_files: 1024,
        }
    }
}

/// Virtual display manager
pub struct VirtualDisplayManager {
    display_num: String,
    xvfb_path: String,
    display_dir: PathBuf,
}

impl VirtualDisplayManager {
    /// Create a new virtual display manager
    pub fn new(display_num: &str) -> Self {
        let display_dir = Path::new("/tmp").join(format!(".X11-unix/X{}", &display_num[1..]));
        
        Self {
            display_num: display_num.to_string(),
            xvfb_path: "/usr/bin/Xvfb".to_string(),
            display_dir: display_dir,
        }
    }

    /// Start the virtual display server
    pub async fn start(&self) -> Result<()> {
        info!("Starting virtual display {}", self.display_num);
        
        // Check if Xvfb is available
        if !Path::new(&self.xvfb_path).exists() {
            return Err(anyhow::anyhow!(
                "Xvfb not found at {}. Please install xserver-xorg-video-dummy.",
                self.xvfb_path
            ));
        }

        // Create display directory if it doesn't exist
        if let Some(parent) = self.display_dir.parent() {
            fs::create_dir_all(parent).await?;
        }

        // Start Xvfb process
        let child = Command::new(&self.xvfb_path)
            .arg(&self.display_num)
            .arg("-screen")
            .arg("0")
            .arg("1920x1080x24")
            .arg("-nolisten")
            .arg("tcp")
            .arg("-auth")
            .arg("/tmp/xvfb-auth.XXXXXX")
            .spawn()
            .with_context(|| format!("Failed to start Xvfb on {}", self.display_num))?;

        info!("Virtual display {} started with PID {}", self.display_num, child.id());
        
        // Wait a moment for Xvfb to initialize
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        
        Ok(())
    }

    /// Stop the virtual display server
    pub async fn stop(&self) -> Result<()> {
        info!("Stopping virtual display {}", self.display_num);
        
        // Kill Xvfb process
        let output = Command::new("pkill")
            .arg("-f")
            .arg(format!("Xvfb {}", self.display_num))
            .output()?;

        if !output.status.success() {
            warn!("Xvfb stop command returned non-zero: {}", output.status);
        }
        
        Ok(())
    }

    /// Check if the display is running
    pub fn is_running(&self) -> bool {
        Command::new("pgrep")
            .arg("-f")
            .arg(format!("Xvfb {}", self.display_num))
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
    }
}

/// Chrome process manager
pub struct ChromeManager {
    config: ChromeConfig,
    display_manager: VirtualDisplayManager,
    chrome_pid: Option<u32>,
}

impl ChromeManager {
    /// Create a new Chrome manager with the given configuration
    pub fn new(config: ChromeConfig) -> Self {
        let display_manager = VirtualDisplayManager::new(&config.display);
        
        Self {
            config,
            display_manager,
            chrome_pid: None,
        }
    }

    /// Start Chrome with the configured profile
    pub async fn start_chrome(&mut self) -> Result<()> {
        info!("Starting Chrome with profile: {}", self.config.user_data_dir);
        
        // Ensure user data directory exists
        let user_data_path = Path::new(&self.config.user_data_dir);
        if !user_data_path.exists() {
            fs::create_dir_all(user_data_path).await?;
            info!("Created Chrome profile directory: {}", self.config.user_data_dir);
        }

        // Set up environment
        std::env::set_var("DISPLAY", &self.config.display);
        std::env::set_var("XDG_RUNTIME_DIR", "/tmp/hexactra-runtime");

        // Create runtime directory
        fs::create_dir_all("/tmp/hexactra-runtime").await?;

        // Build Chrome command line
        let mut args = vec![
            format!("--user-data-dir={}", self.config.user_data_dir),
            "--no-sandbox".to_string(),
            "--disable-dev-shm-usage".to_string(),
            "--disable-gpu".to_string(),  // Will be re-enabled if GPU is requested
            "--disable-extensions".to_string(),
            "--disable-plugins".to_string(),
            "--disable-background-networking".to_string(),
            "--disable-sync".to_string(),
            "--disable-translate".to_string(),
            "--metrics-recording-only".to_string(),
            "--no-first-run".to_string(),
            "--safebrowsing-disable-auto-update".to_string(),
        ];

        // Add GPU flag if enabled
        if self.config.enable_gpu {
            args.push("--enable-gpu".to_string());
            args.push("--gpu-no-context-lost".to_string());
        }

        // Add extra arguments
        args.extend(self.config.extra_args.clone());

        // Check if Chrome binary exists
        if !Path::new(&self.config.chrome_binary).exists() {
            return Err(anyhow::anyhow!(
                "Chrome binary not found at {}",
                self.config.chrome_binary
            ));
        }

        // Start Chrome with resource limits
        let child = self.start_chrome_with_limits(&args)?;

        self.chrome_pid = Some(child.id());
        info!("Chrome started with PID {}", child.id());
        
        // Wait a moment for Chrome to initialize
        tokio::time::sleep(std::time::Duration::from_millis(1000)).await;
        
        Ok(())
    }

    /// Start Chrome with resource limits applied
    fn start_chrome_with_limits(&self, args: &[String]) -> Result<std::process::Child> {
        let memory_mb = self.config.resource_limits.memory_mb;
        let max_open_files = self.config.resource_limits.max_open_files;
        
        let mut cmd = Command::new(&self.config.chrome_binary);
        cmd.args(args);

        // Apply resource limits using ulimit-like approach
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            
            unsafe {
                cmd.pre_exec(move || {
                    // Set memory limit (soft and hard)
                    let rlim = libc::rlimit {
                        rlim_cur: memory_mb as libc::rlim_t * 1024 * 1024,
                        rlim_max: memory_mb as libc::rlim_t * 1024 * 1024,
                    };
                    if libc::setrlimit(libc::RLIMIT_AS, &rlim) != 0 {
                        return Err(std::io::Error::last_os_error());
                    }

                    // Set open files limit
                    let rlim = libc::rlimit {
                        rlim_cur: max_open_files as libc::rlim_t,
                        rlim_max: max_open_files as libc::rlim_t,
                    };
                    if libc::setrlimit(libc::RLIMIT_NOFILE, &rlim) != 0 {
                        return Err(std::io::Error::last_os_error());
                    }

                    Ok(())
                });
            }
        }

        cmd.spawn().map_err(|e| anyhow::anyhow!(
            "Failed to start Chrome: {}",
            e
        ))
    }

    /// Stop Chrome gracefully
    pub async fn stop_chrome(&mut self) -> Result<()> {
        if let Some(pid) = self.chrome_pid {
            info!("Stopping Chrome with PID {}", pid);
            
            // Try graceful termination first
            let status = Command::new("kill")
                .arg("-TERM")
                .arg(pid.to_string())
                .status()?;

            if !status.success() {
                warn!("Graceful termination failed, forcing kill");
                let _ = Command::new("kill")
                    .arg("-9")
                    .arg(pid.to_string())
                    .status();
            }

            self.chrome_pid = None;
        } else {
            warn!("Chrome was not running");
        }

        Ok(())
    }

    /// Check if Chrome is running
    pub fn is_chrome_running(&self) -> bool {
        self.chrome_pid.map_or(false, |pid| {
            Command::new("kill")
                .arg("-0")
                .arg(pid.to_string())
                .status()
                .map(|s| s.success())
                .unwrap_or(false)
        })
    }

    /// Get Chrome version
    pub fn get_version(&self) -> Result<String> {
        let output = Command::new(&self.config.chrome_binary)
            .arg("--version")
            .output()?;

        if !output.status.success() {
            return Err(anyhow::anyhow!("Failed to get Chrome version"));
        }

        Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
    }
}

impl Drop for ChromeManager {
    fn drop(&mut self) {
        if self.chrome_pid.is_some() {
            warn!("ChromeManager dropped while Chrome was still running");
        }
    }
}

/// Utility functions for Chrome management
pub mod utils {
    use anyhow::Result;
    use std::path::Path;

    /// Check if Chrome/Chromium is installed
    pub fn chrome_installed() -> bool {
        Path::new("/usr/bin/google-chrome").exists()
            || Path::new("/usr/bin/chromium").exists()
            || Path::new("/usr/bin/chromium-browser").exists()
    }

    /// Get available Chrome/Chromium binary path
    pub fn get_chrome_path() -> String {
        if Path::new("/usr/bin/google-chrome").exists() {
            "/usr/bin/google-chrome".to_string()
        } else if Path::new("/usr/bin/chromium").exists() {
            "/usr/bin/chromium".to_string()
        } else if Path::new("/usr/bin/chromium-browser").exists() {
            "/usr/bin/chromium-browser".to_string()
        } else {
            "".to_string()
        }
    }

    /// Check if Xvfb is installed
    pub fn xvfb_installed() -> bool {
        Path::new("/usr/bin/Xvfb").exists()
    }

    /// Verify system prerequisites for Chrome runtime
    pub fn verify_prerequisites() -> Result<()> {
        if !chrome_installed() {
            return Err(anyhow::anyhow!(
                "Chrome/Chromium is not installed. Please install Google Chrome or Chromium."
            ));
        }

        if !xvfb_installed() {
            return Err(anyhow::anyhow!(
                "Xvfb is not installed. Please install xserver-xorg-video-dummy."
            ));
        }

        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_chrome_config_default() {
        let config = ChromeConfig::default();
        assert_eq!(config.display, ":99");
        assert_eq!(config.resource_limits.memory_mb, 2048);
    }

    #[test]
    fn test_resource_limits_default() {
        let limits = ResourceLimits::default();
        assert_eq!(limits.memory_mb, 2048);
        assert_eq!(limits.cpu_cores, 2);
    }

    #[test]
    fn test_virtual_display_manager_creation() {
        let manager = VirtualDisplayManager::new(":99");
        assert_eq!(manager.display_num, ":99");
    }

    #[test]
    fn test_chrome_manager_creation() {
        let config = ChromeConfig::default();
        let manager = ChromeManager::new(config);
        assert!(!manager.is_chrome_running());
    }
}
