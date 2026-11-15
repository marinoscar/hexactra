//! Launch mode (#196): the agent starts, supervises and idle-stops the
//! browser itself, so no desktop session or manually opened Chrome is needed.
//!
//! - The profile directory is persistent and owned by this agent (one
//!   writer). Stale Chromium singleton locks left by a crash or a container
//!   restart (different hostname) are removed before launch.
//! - The native messaging manifest is written into the profile directory
//!   (`<profile>/NativeMessagingHosts`), which Chromium reads on Linux.
//! - The bridge socket path is passed in the browser's environment so the
//!   native host Chrome spawns connects to this agent.
//! - The browser runs visibly on whatever display the agent has (`DISPLAY`),
//!   for example Xvfb in a container.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;

use anyhow::{bail, Context, Result};
use hexactra_core::bridge::{native_host_manifest, BRIDGE_SOCKET_ENV, NATIVE_HOST_NAME};
use tokio::process::{Child, Command};
use tokio::sync::Mutex;
use tokio::time::Instant;

use crate::browser_bridge::BrowserBridge;

/// Launch settings.
#[derive(Debug, Clone)]
pub struct LaunchConfig {
    /// Browser binary (Chromium, Chrome for Testing, or Chrome).
    pub browser: PathBuf,
    /// Persistent profile (`--user-data-dir`).
    pub profile_dir: PathBuf,
    /// Unpacked extension to load (`--load-extension`). Branded Google
    /// Chrome ignores this flag; install the extension in the profile instead.
    pub extension_dir: Option<PathBuf>,
    /// Extra browser arguments.
    pub extra_args: Vec<String>,
    /// Close the browser after this long without operations.
    pub idle_shutdown: Option<Duration>,
    /// `hexactra-native-host` binary.
    pub native_host: PathBuf,
    /// Bridge socket the native host must connect to.
    pub bridge_socket: PathBuf,
    /// How long to wait for the extension after starting the browser.
    pub startup_timeout: Duration,
}

struct State {
    child: Option<Child>,
    last_activity: Instant,
    launches: u32,
}

/// Starts and supervises the browser.
pub struct BrowserLauncher {
    cfg: LaunchConfig,
    bridge: BrowserBridge,
    state: Mutex<State>,
}

/// Remove Chromium's singleton files. Only called when this agent has no
/// running browser, so any lock left is stale.
fn clear_stale_locks(profile: &Path) {
    for name in ["SingletonLock", "SingletonCookie", "SingletonSocket"] {
        let p = profile.join(name);
        // These are symlinks; symlink_metadata sees dangling ones too.
        if std::fs::symlink_metadata(&p).is_ok() {
            if let Err(e) = std::fs::remove_file(&p) {
                tracing::warn!(error = %e, file = %p.display(), "could not remove stale profile lock");
            }
        }
    }
}

impl BrowserLauncher {
    pub fn new(cfg: LaunchConfig, bridge: BrowserBridge) -> Arc<Self> {
        Arc::new(Self {
            cfg,
            bridge,
            state: Mutex::new(State {
                child: None,
                last_activity: Instant::now(),
                launches: 0,
            }),
        })
    }

    /// Number of times the browser was launched (for status and tests).
    pub async fn launches(&self) -> u32 {
        self.state.lock().await.launches
    }

    /// True while the browser process is alive.
    pub async fn is_running(&self) -> bool {
        let mut st = self.state.lock().await;
        Self::alive(&mut st)
    }

    fn alive(st: &mut State) -> bool {
        match st.child.as_mut().map(|c| c.try_wait()) {
            Some(Ok(None)) => true,
            Some(Ok(Some(status))) => {
                tracing::warn!(%status, "browser exited");
                st.child = None;
                false
            }
            Some(Err(_)) | None => {
                st.child = None;
                false
            }
        }
    }

    fn prepare_profile(&self) -> Result<()> {
        let profile = &self.cfg.profile_dir;
        std::fs::create_dir_all(profile)
            .with_context(|| format!("creating profile {}", profile.display()))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(profile, std::fs::Permissions::from_mode(0o700))?;
        }
        clear_stale_locks(profile);
        let dir = profile.join("NativeMessagingHosts");
        std::fs::create_dir_all(&dir)?;
        let manifest = native_host_manifest(&self.cfg.native_host);
        std::fs::write(
            dir.join(format!("{NATIVE_HOST_NAME}.json")),
            serde_json::to_vec_pretty(&manifest)?,
        )?;
        Ok(())
    }

    fn args(&self) -> Vec<String> {
        let mut a = vec![
            format!("--user-data-dir={}", self.cfg.profile_dir.display()),
            "--no-first-run".into(),
            "--no-default-browser-check".into(),
            "--disable-dev-shm-usage".into(),
            "--start-maximized".into(),
        ];
        if let Some(ext) = &self.cfg.extension_dir {
            a.push(format!("--disable-extensions-except={}", ext.display()));
            a.push(format!("--load-extension={}", ext.display()));
        }
        a.extend(self.cfg.extra_args.iter().cloned());
        // No start URL: after a graceful close Chromium restores the tabs it
        // had, so an agent finds the browser as it left it.
        a
    }

    /// Make sure the browser runs and its extension is connected.
    pub async fn ensure_running(&self) -> Result<()> {
        let mut st = self.state.lock().await;
        st.last_activity = Instant::now();
        if Self::alive(&mut st) {
            if self.bridge.is_connected() {
                return Ok(());
            }
            // Still starting up, or the extension is reconnecting.
            drop(st);
            if self.bridge.wait_connected(self.cfg.startup_timeout).await {
                return Ok(());
            }
            bail!(
                "browser is running but the Hexactra extension did not connect within {:?}",
                self.cfg.startup_timeout
            );
        }

        self.prepare_profile()?;
        tracing::info!(browser = %self.cfg.browser.display(), profile = %self.cfg.profile_dir.display(), "launching browser");
        // Browser output goes to a log next to the profile, replaced on each
        // launch, so startup failures can be explained.
        let log_path = self.log_path();
        let log = std::fs::File::create(&log_path)
            .with_context(|| format!("creating {}", log_path.display()))?;
        let child = Command::new(&self.cfg.browser)
            .args(self.args())
            .env(BRIDGE_SOCKET_ENV, &self.cfg.bridge_socket)
            .stdin(Stdio::null())
            .stdout(log.try_clone()?)
            .stderr(log)
            .kill_on_drop(true)
            .spawn()
            .with_context(|| format!("starting {}", self.cfg.browser.display()))?;
        st.child = Some(child);
        st.launches += 1;
        drop(st);

        // Wait for the extension, but fail fast if the browser exits.
        let deadline = Instant::now() + self.cfg.startup_timeout;
        loop {
            if self.bridge.is_connected() {
                tracing::info!("browser ready");
                return Ok(());
            }
            {
                let mut st = self.state.lock().await;
                if !Self::alive(&mut st) {
                    let tail = self.log_tail(15);
                    tracing::error!(log = %tail, "browser exited during startup");
                    bail!(
                        "browser exited during startup (check DISPLAY, sandbox and profile permissions); last output:\n{tail}"
                    );
                }
                if Instant::now() >= deadline {
                    Self::stop(&mut st, &self.bridge).await;
                    bail!(
                        "browser started but the Hexactra extension did not connect within {:?}; last output:\n{}",
                        self.cfg.startup_timeout,
                        self.log_tail(15)
                    );
                }
            }
            tokio::time::sleep(Duration::from_millis(200)).await;
        }
    }

    /// Browser output log for the current launch.
    pub fn log_path(&self) -> PathBuf {
        self.cfg.profile_dir.join("hexactra-browser.log")
    }

    fn log_tail(&self, lines: usize) -> String {
        let text = std::fs::read_to_string(self.log_path()).unwrap_or_default();
        let v: Vec<&str> = text.lines().filter(|l| !l.trim().is_empty()).collect();
        v[v.len().saturating_sub(lines)..].join("\n")
    }

    /// Record activity (keeps an idle browser alive).
    pub async fn touch(&self) {
        self.state.lock().await.last_activity = Instant::now();
    }

    async fn stop(st: &mut State, bridge: &BrowserBridge) {
        let Some(mut child) = st.child.take() else {
            return;
        };
        // Preferred: ask the extension to close every window, so Chromium
        // shuts down normally and flushes cookies and site storage (which it
        // writes lazily).
        if bridge.is_connected() && bridge.request_shutdown().await {
            if tokio::time::timeout(Duration::from_secs(15), child.wait())
                .await
                .is_ok()
            {
                return;
            }
            tracing::warn!("browser did not close its windows in time; terminating it");
        }
        #[cfg(unix)]
        if let Some(pid) = child.id() {
            // Ask politely so the profile is flushed.
            unsafe {
                libc::kill(pid as i32, libc::SIGTERM);
            }
            if tokio::time::timeout(Duration::from_secs(10), child.wait())
                .await
                .is_ok()
            {
                return;
            }
        }
        let _ = child.kill().await;
    }

    /// Stop the browser now.
    pub async fn shutdown(&self) {
        let mut st = self.state.lock().await;
        Self::stop(&mut st, &self.bridge).await;
    }

    /// Close the browser after `idle_shutdown` without activity.
    pub fn spawn_idle_watcher(self: &Arc<Self>) {
        let Some(idle) = self.cfg.idle_shutdown else {
            return;
        };
        let this = self.clone();
        tokio::spawn(async move {
            let tick = (idle / 4).clamp(Duration::from_millis(100), Duration::from_secs(5));
            loop {
                tokio::time::sleep(tick).await;
                let mut st = this.state.lock().await;
                if Self::alive(&mut st) && st.last_activity.elapsed() >= idle {
                    tracing::info!(?idle, "closing idle browser");
                    Self::stop(&mut st, &this.bridge).await;
                }
            }
        });
    }
}

/// Test helpers shared with the pool tests.
#[cfg(test)]
pub(crate) mod tests_support {
    use std::path::{Path, PathBuf};

    /// A stand-in browser: connects to the bridge socket like the native
    /// host would, says hello and answers every request. With
    /// `--fake-exit-after=N` it exits after N requests (a crash).
    const FAKE_BROWSER: &str = r#"#!/usr/bin/env python3
import json, os, socket, struct, sys
args = sys.argv[1:]
assert any(a.startswith('--user-data-dir=') for a in args), args
profile = [a.split('=', 1)[1] for a in args if a.startswith('--user-data-dir=')][0]
assert os.path.exists(os.path.join(profile, 'NativeMessagingHosts', 'com.hexactra.nativehost.json'))
open(os.path.join(profile, 'launched'), 'a').write('x')
s = socket.socket(socket.AF_UNIX)
s.connect(os.environ['HEXACTRA_BRIDGE_SOCKET'])
def send(o):
    b = json.dumps(o).encode(); s.sendall(struct.pack('>I', len(b)) + b)
def recv():
    h = b''
    while len(h) < 4:
        c = s.recv(4 - len(h))
        if not c: sys.exit(0)
        h += c
    n = struct.unpack('>I', h)[0]; d = b''
    while len(d) < n: d += s.recv(n - len(d))
    return json.loads(d)
send({'type': 'hello', 'version': 'fake'})
left = ([int(a.split('=', 1)[1]) for a in args if a.startswith('--fake-exit-after=')] or [None])[0]
while True:
    m = recv()
    if m.get('type') == 'shutdown':
        sys.exit(0)
    if m.get('type') == 'request':
        launches = len(open(os.path.join(profile, 'launched')).read())
        send({'type': 'response', 'id': m['id'], 'ok': True, 'result': {'launches': launches, 'profile': profile}})
        if left is not None:
            left -= 1
            if left == 0: sys.exit(0)
"#;

    /// Write the stand-in browser into `dir` and return its path.
    pub(crate) fn fake_browser(dir: &Path) -> PathBuf {
        let browser = dir.join("fake-browser");
        std::fs::write(&browser, FAKE_BROWSER).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&browser, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        browser
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::browser_bridge::BrowserBridge;
    use hexactra_core::remote::RemoteAction;

    async fn setup(
        idle: Option<Duration>,
        exit_after: Option<u32>,
    ) -> (tempfile::TempDir, Arc<BrowserLauncher>, BrowserBridge) {
        let dir = tempfile::tempdir().unwrap();
        let browser = super::tests_support::fake_browser(dir.path());
        let socket = dir.path().join("run/bridge.sock");
        let bridge = BrowserBridge::bind(&socket).await.unwrap();
        let profile = dir.path().join("profile");
        std::fs::create_dir_all(&profile).unwrap();
        // A stale lock from "another computer".
        #[cfg(unix)]
        std::os::unix::fs::symlink("other-host-123", profile.join("SingletonLock")).unwrap();
        let l = BrowserLauncher::new(
            LaunchConfig {
                browser,
                profile_dir: profile,
                extension_dir: None,
                extra_args: exit_after
                    .map(|n| vec![format!("--fake-exit-after={n}")])
                    .unwrap_or_default(),
                idle_shutdown: idle,
                native_host: PathBuf::from("/usr/local/bin/hexactra-native-host"),
                bridge_socket: socket,
                startup_timeout: Duration::from_secs(10),
            },
            bridge.clone(),
        );
        (dir, l, bridge)
    }

    async fn run_action(l: &BrowserLauncher, b: &BrowserBridge) -> serde_json::Value {
        l.ensure_running().await.unwrap();
        let r = b
            .execute(
                uuid::Uuid::new_v4(),
                &RemoteAction::Tabs,
                chrono::Utc::now() + chrono::Duration::seconds(5),
            )
            .await;
        assert!(r.ok, "{:?}", r.error);
        r.result.unwrap()
    }

    fn python_available() -> bool {
        std::process::Command::new("python3")
            .arg("--version")
            .output()
            .is_ok()
    }

    #[tokio::test]
    async fn launches_on_demand_and_idles_out_then_relaunches_with_same_profile() {
        if !python_available() {
            eprintln!("skipping: python3 not available");
            return;
        }
        let (dir, l, b) = setup(Some(Duration::from_millis(400)), None).await;
        l.spawn_idle_watcher();
        assert!(!l.is_running().await);
        assert_eq!(run_action(&l, &b).await["launches"], 1);
        assert!(!dir.path().join("profile/SingletonLock").exists());
        // Activity keeps it alive; a second call does not relaunch.
        run_action(&l, &b).await;
        assert_eq!(l.launches().await, 1);
        // Idle shutdown.
        for _ in 0..50 {
            if !l.is_running().await {
                break;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        assert!(!l.is_running().await, "idle browser was not closed");
        // Next action relaunches with the same profile directory.
        assert_eq!(run_action(&l, &b).await["launches"], 2);
        l.shutdown().await;
    }

    #[tokio::test]
    async fn crashed_browser_is_relaunched_on_next_action() {
        if !python_available() {
            eprintln!("skipping: python3 not available");
            return;
        }
        let (_dir, l, b) = setup(None, Some(1)).await;
        assert_eq!(run_action(&l, &b).await["launches"], 1);
        // The fake browser exits after one request.
        for _ in 0..50 {
            if !l.is_running().await {
                break;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        assert!(!l.is_running().await);
        assert_eq!(run_action(&l, &b).await["launches"], 2);
        l.shutdown().await;
    }

    #[tokio::test]
    async fn startup_crash_fails_fast_with_browser_output() {
        let dir = tempfile::tempdir().unwrap();
        let browser = dir.path().join("crashing-browser");
        std::fs::write(
            &browser,
            "#!/bin/sh\necho 'FATAL: No usable sandbox!' >&2\nexit 1\n",
        )
        .unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&browser, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        let socket = dir.path().join("b.sock");
        let bridge = BrowserBridge::bind(&socket).await.unwrap();
        let l = BrowserLauncher::new(
            LaunchConfig {
                browser,
                profile_dir: dir.path().join("p"),
                extension_dir: None,
                extra_args: vec![],
                idle_shutdown: None,
                native_host: PathBuf::from("/x"),
                bridge_socket: socket,
                startup_timeout: Duration::from_secs(30),
            },
            bridge,
        );
        let started = std::time::Instant::now();
        let e = l.ensure_running().await.unwrap_err().to_string();
        assert!(
            started.elapsed() < Duration::from_secs(5),
            "did not fail fast"
        );
        assert!(e.contains("No usable sandbox"), "{e}");
    }

    #[tokio::test]
    async fn missing_browser_is_a_clear_error() {
        let dir = tempfile::tempdir().unwrap();
        let socket = dir.path().join("b.sock");
        let bridge = BrowserBridge::bind(&socket).await.unwrap();
        let l = BrowserLauncher::new(
            LaunchConfig {
                browser: dir.path().join("no-such-browser"),
                profile_dir: dir.path().join("p"),
                extension_dir: None,
                extra_args: vec![],
                idle_shutdown: None,
                native_host: PathBuf::from("/x"),
                bridge_socket: socket,
                startup_timeout: Duration::from_secs(1),
            },
            bridge,
        );
        let e = l.ensure_running().await.unwrap_err().to_string();
        assert!(e.contains("starting"), "{e}");
    }
}
