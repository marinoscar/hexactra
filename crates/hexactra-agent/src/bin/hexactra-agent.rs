//! `hexactra-agent`: host agent that lets the control plane drive the
//! operator's own Chrome (#177).

use std::path::PathBuf;
use std::time::Duration;

use anyhow::{Context, Result};
use clap::{Parser, Subcommand};
use hexactra_agent::desktop::DesktopTarget;
use hexactra_agent::launcher::LaunchConfig;
use hexactra_agent::pool::PoolConfig;
use hexactra_agent::remote_daemon::{self, DaemonConfig};
use hexactra_core::bridge::bridge_socket_path;
use hexactra_core::remote::HostMode;

#[derive(Parser)]
#[command(name = "hexactra-agent", version, about = "Hexactra host agent")]
struct Cli {
    #[command(subcommand)]
    command: Commands,
}

#[derive(Subcommand)]
#[allow(clippy::large_enum_variant)] // parsed once at startup
enum Commands {
    /// Connect to the control plane and serve browser operations (attach mode).
    Daemon {
        /// Control plane URL.
        #[arg(long, env = "HEXACTRA_URL", default_value = "http://127.0.0.1:8787")]
        url: String,
        /// File with the API token (default: $XDG_CONFIG_HOME/hexactra/api-token).
        /// `HEXACTRA_API_TOKEN` overrides it.
        #[arg(long, env = "HEXACTRA_TOKEN_FILE")]
        token_file: Option<PathBuf>,
        /// Single-use enrollment token (`hxe_…`) from the console or
        /// `POST /v1/admin/hosts/enrollments`. Exchanged once for this host's
        /// own credential, saved to $XDG_CONFIG_HOME/hexactra/host-credential.json.
        #[arg(long, env = "HEXACTRA_ENROLLMENT_TOKEN")]
        enrollment_token: Option<String>,
        /// Display name for this host (default: the machine's hostname).
        #[arg(long, env = "HEXACTRA_HOST_NAME")]
        name: Option<String>,
        /// Unix socket the native messaging host connects to.
        #[arg(long, env = "HEXACTRA_BRIDGE_SOCKET")]
        bridge_socket: Option<PathBuf>,
        /// Launch mode: browser binary the agent starts and supervises
        /// (e.g. /usr/bin/chromium). Without it the agent attaches to a
        /// browser you run yourself.
        #[arg(long, env = "HEXACTRA_BROWSER")]
        browser: Option<PathBuf>,
        /// Launch mode: directory with one subdirectory per browser profile
        /// (default: $XDG_DATA_HOME/hexactra/profiles).
        #[arg(long, env = "HEXACTRA_PROFILES_DIR")]
        profiles_dir: Option<PathBuf>,
        /// Deprecated single-profile directory; becomes the `default` profile
        /// by moving it into the profiles directory on first start.
        #[arg(long, env = "HEXACTRA_PROFILE_DIR", hide = true)]
        profile_dir: Option<PathBuf>,
        /// Most browsers (profiles) running at once; the least recently used
        /// idle one is closed to make room. Each takes 300-600 MB of RAM.
        #[arg(long, env = "HEXACTRA_MAX_BROWSERS", default_value_t = 1)]
        max_browsers: usize,
        /// Unpacked Hexactra extension to load in launch mode.
        #[arg(long, env = "HEXACTRA_EXTENSION_DIR")]
        extension_dir: Option<PathBuf>,
        /// Extra browser argument (repeat).
        #[arg(long = "browser-arg", allow_hyphen_values = true)]
        browser_args: Vec<String>,
        /// Close the browser after this many idle seconds (0 = keep it open).
        #[arg(long, env = "HEXACTRA_IDLE_SHUTDOWN_S", default_value_t = 0)]
        idle_shutdown_s: u64,
        /// Start the browser immediately instead of on the first operation.
        #[arg(long, env = "HEXACTRA_LAUNCH_EAGERLY")]
        launch_eagerly: bool,
        /// hexactra-native-host binary (default: next to this binary).
        #[arg(long, env = "HEXACTRA_NATIVE_HOST")]
        native_host: Option<PathBuf>,
        /// Web viewer URL for this host's browser, shown in handoffs.
        #[arg(long, env = "HEXACTRA_VIEWER_URL")]
        viewer_url: Option<String>,
        /// How this host runs: unattended, attended or container. Default:
        /// unattended with --browser (the agent launches Chrome), else attended.
        #[arg(long, env = "HEXACTRA_HOST_MODE")]
        mode: Option<HostMode>,
        /// Local desktop server to share through the fabric:
        /// unix:/path/to/vnc.sock or tcp:127.0.0.1:<port>.
        #[arg(long = "desktop-vnc", env = "HEXACTRA_DESKTOP_VNC")]
        desktop_vnc: Option<DesktopTarget>,
    },
    /// Check this node: each browser profile's Google sign-in status, read
    /// from the profile on disk (the Fleet page also shows the live check).
    Doctor {
        /// Directory with one subdirectory per browser profile
        /// (default: $XDG_DATA_HOME/hexactra/profiles).
        #[arg(long, env = "HEXACTRA_PROFILES_DIR")]
        profiles_dir: Option<PathBuf>,
    },
    /// Print the bridge socket path the native host will use.
    SocketPath,
    /// Print version.
    Version,
}

fn config_dir() -> PathBuf {
    std::env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".config")))
        .unwrap_or_else(|| PathBuf::from("."))
        .join("hexactra")
}

fn data_dir() -> PathBuf {
    std::env::var_os("XDG_DATA_HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".local/share")))
        .unwrap_or_else(|| PathBuf::from("."))
        .join("hexactra")
}

fn hostname() -> String {
    std::fs::read_to_string("/etc/hostname")
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "hexactra-host".to_string())
}

/// Saved host credential from enrollment.
#[derive(serde::Serialize, serde::Deserialize)]
struct HostCredential {
    host_id: uuid::Uuid,
    host_token: String,
}

fn credential_file() -> PathBuf {
    config_dir().join("host-credential.json")
}

fn write_private(path: &std::path::Path, data: &[u8]) -> Result<()> {
    if let Some(d) = path.parent() {
        std::fs::create_dir_all(d)?;
    }
    use std::io::Write;
    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    opts.open(path)?.write_all(data)?;
    Ok(())
}

/// The token this host uses: its saved host credential, else a new one
/// from `enrollment_token`, else the operator token (legacy single-token
/// setups).
async fn host_token(
    url: &str,
    name: &str,
    token_file: Option<PathBuf>,
    enrollment_token: Option<String>,
) -> Result<String> {
    let file = credential_file();
    if let Ok(bytes) = std::fs::read(&file) {
        let c: HostCredential = serde_json::from_slice(&bytes)
            .with_context(|| format!("reading {}", file.display()))?;
        // Keep the host id file in step with the credential.
        let _ = std::fs::write(config_dir().join("host-id"), format!("{}\n", c.host_id));
        tracing::info!(host_id = %c.host_id, "using saved host credential");
        return Ok(c.host_token);
    }
    if let Some(et) = enrollment_token.filter(|t| !t.trim().is_empty()) {
        let e =
            hexactra_client::HostClient::enroll(url, et.trim(), name, env!("CARGO_PKG_VERSION"))
                .await
                .context("enrolling this host (is the enrollment token valid and unused?)")?;
        let c = HostCredential {
            host_id: e.host_id,
            host_token: e.host_token,
        };
        write_private(&file, &serde_json::to_vec_pretty(&c)?)?;
        let _ = std::fs::write(config_dir().join("host-id"), format!("{}\n", c.host_id));
        tracing::info!(host_id = %c.host_id, file = %file.display(), "host enrolled; credential saved");
        return Ok(c.host_token);
    }
    read_token(token_file)
}

fn read_token(token_file: Option<PathBuf>) -> Result<String> {
    if let Ok(t) = std::env::var("HEXACTRA_API_TOKEN") {
        if !t.trim().is_empty() {
            return Ok(t.trim().to_string());
        }
    }
    let file = token_file.unwrap_or_else(|| config_dir().join("api-token"));
    let t = std::fs::read_to_string(&file).with_context(|| {
        format!(
            "reading API token from {} (set HEXACTRA_API_TOKEN or --token-file)",
            file.display()
        )
    })?;
    Ok(t.trim().to_string())
}

#[tokio::main]
async fn main() -> Result<()> {
    hexactra_otel::init("hexactra-agent");

    match Cli::parse().command {
        Commands::Version => {
            println!("hexactra-agent {}", env!("CARGO_PKG_VERSION"));
            Ok(())
        }
        Commands::Doctor { profiles_dir } => {
            let dir = profiles_dir.unwrap_or_else(|| data_dir().join("profiles"));
            println!("profiles in {}", dir.display());
            for line in hexactra_agent::signin::doctor_lines(&dir) {
                println!("{line}");
            }
            Ok(())
        }
        Commands::SocketPath => {
            println!("{}", bridge_socket_path().display());
            Ok(())
        }
        Commands::Daemon {
            url,
            token_file,
            enrollment_token,
            name,
            bridge_socket,
            browser,
            profiles_dir,
            profile_dir,
            max_browsers,
            extension_dir,
            browser_args,
            idle_shutdown_s,
            launch_eagerly,
            native_host,
            viewer_url,
            mode,
            desktop_vnc,
        } => {
            let mode = Some(default_mode(mode, browser.is_some()));
            let bridge_socket = bridge_socket.unwrap_or_else(bridge_socket_path);
            let launch = match browser {
                None => None,
                Some(browser) => {
                    let native_host = match native_host {
                        Some(p) => p,
                        None => std::env::current_exe()?.with_file_name("hexactra-native-host"),
                    };
                    if !native_host.exists() {
                        anyhow::bail!(
                            "native host not found at {} (set --native-host)",
                            native_host.display()
                        );
                    }
                    let profiles_dir = profiles_dir.unwrap_or_else(|| data_dir().join("profiles"));
                    hexactra_agent::pool::migrate_single_profile(
                        profile_dir.as_deref(),
                        &profiles_dir,
                    )?;
                    let socket_dir = bridge_socket
                        .parent()
                        .map(|p| p.to_path_buf())
                        .unwrap_or_else(|| PathBuf::from("."));
                    Some(PoolConfig {
                        profiles_dir,
                        socket_dir,
                        max_browsers: max_browsers.max(1),
                        launch: LaunchConfig {
                            browser,
                            profile_dir: PathBuf::new(),
                            extension_dir,
                            extra_args: browser_args,
                            idle_shutdown: (idle_shutdown_s > 0)
                                .then(|| Duration::from_secs(idle_shutdown_s)),
                            native_host,
                            bridge_socket: PathBuf::new(),
                            startup_timeout: Duration::from_secs(30),
                        },
                    })
                }
            };
            let host_name = name.unwrap_or_else(hostname);
            let token = host_token(&url, &host_name, token_file, enrollment_token).await?;
            let cfg = DaemonConfig {
                control_url: url,
                token,
                host_name,
                host_id_file: Some(config_dir().join("host-id")),
                bridge_socket,
                poll_wait: Duration::from_secs(25),
                launch,
                launch_eagerly,
                viewer_url,
                mode,
                desktop: desktop_vnc,
            };
            // SIGTERM/SIGINT are handled inside: browsers are closed
            // gracefully so their cookies and storage reach the disk.
            remote_daemon::run(cfg).await
        }
    }
}

/// The mode a host reports: the flag, else unattended when the agent
/// launches its own browser, else attended (it attaches to the person's).
fn default_mode(flag: Option<HostMode>, launches_browser: bool) -> HostMode {
    flag.unwrap_or(if launches_browser {
        HostMode::Unattended
    } else {
        HostMode::Attended
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cli_parses_daemon() {
        let cli = Cli::parse_from(["hexactra-agent", "daemon", "--url", "http://h:1"]);
        assert!(matches!(cli.command, Commands::Daemon { .. }));
    }

    #[test]
    fn daemon_takes_mode_and_desktop() {
        let cli = Cli::parse_from([
            "hexactra-agent",
            "daemon",
            "--url",
            "http://h:1",
            "--mode",
            "container",
            "--desktop-vnc",
            "tcp:127.0.0.1:5900",
        ]);
        match cli.command {
            Commands::Daemon {
                mode, desktop_vnc, ..
            } => {
                assert_eq!(mode, Some(HostMode::Container));
                assert_eq!(desktop_vnc, Some("tcp:127.0.0.1:5900".parse().unwrap()));
            }
            _ => panic!("expected daemon"),
        }
        assert!(Cli::try_parse_from([
            "hexactra-agent",
            "daemon",
            "--url",
            "http://h:1",
            "--desktop-vnc",
            "tcp:0.0.0.0:5900",
        ])
        .is_err());
    }

    #[test]
    fn cli_parses_doctor() {
        let cli = Cli::parse_from(["hexactra-agent", "doctor", "--profiles-dir", "/p"]);
        match cli.command {
            Commands::Doctor { profiles_dir } => {
                assert_eq!(profiles_dir, Some(PathBuf::from("/p")))
            }
            _ => panic!("expected doctor"),
        }
    }

    #[test]
    fn mode_defaults_from_launch() {
        assert_eq!(default_mode(None, true), HostMode::Unattended);
        assert_eq!(default_mode(None, false), HostMode::Attended);
        assert_eq!(
            default_mode(Some(HostMode::Container), true),
            HostMode::Container
        );
    }
}
