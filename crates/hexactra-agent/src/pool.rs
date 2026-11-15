//! Browser pool (#204): one launched browser per profile on a host.
//!
//! - Each profile has its own directory (`<profiles_dir>/<name>`), bridge
//!   socket and launcher, so profiles never share cookies or locks.
//! - At most `max_browsers` run at once. When a profile must start and the
//!   pool is full, the least recently used browser that is not executing an
//!   action is closed. If every running browser is busy, the request waits
//!   until one frees up or its deadline passes.
//! - Actions on one profile run in order; different profiles run in parallel.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use anyhow::{bail, Context, Result};
use chrono::{DateTime, Utc};
use hexactra_core::remote::{valid_profile_name, OperationResult, RemoteAction, DEFAULT_PROFILE};
use tokio::sync::Mutex;
use tokio::time::Instant;
use uuid::Uuid;

use crate::browser_bridge::BrowserBridge;
use crate::launcher::{BrowserLauncher, LaunchConfig};

/// Pool settings.
#[derive(Debug, Clone)]
pub struct PoolConfig {
    /// Directory holding one subdirectory per profile.
    pub profiles_dir: PathBuf,
    /// Directory for per-profile bridge sockets (0700).
    pub socket_dir: PathBuf,
    /// Most browsers running at once.
    pub max_browsers: usize,
    /// Settings shared by every profile's browser; `profile_dir` and
    /// `bridge_socket` are replaced per profile.
    pub launch: LaunchConfig,
}

struct Entry {
    launcher: Arc<BrowserLauncher>,
    bridge: BrowserBridge,
    /// Held while an action runs on this profile.
    busy: Arc<Mutex<()>>,
    last_used: Instant,
}

/// A running browser that could be closed: last use, profile, launcher, busy lock.
type Slot = (Instant, String, Arc<BrowserLauncher>, Arc<Mutex<()>>);

/// The pool. Cheap to share behind an `Arc`.
pub struct BrowserPool {
    cfg: PoolConfig,
    entries: Mutex<HashMap<String, Entry>>,
    /// Serialises launch and eviction decisions.
    capacity: Mutex<()>,
}

fn failure(msg: impl Into<String>) -> OperationResult {
    OperationResult {
        ok: false,
        result: None,
        error: Some(msg.into()),
    }
}

impl BrowserPool {
    pub fn new(cfg: PoolConfig) -> Result<Arc<Self>> {
        if cfg.max_browsers == 0 {
            bail!("max_browsers must be at least 1");
        }
        std::fs::create_dir_all(&cfg.profiles_dir)
            .with_context(|| format!("creating {}", cfg.profiles_dir.display()))?;
        Ok(Arc::new(Self {
            cfg,
            entries: Mutex::new(HashMap::new()),
            capacity: Mutex::new(()),
        }))
    }

    fn profile_dir(&self, name: &str) -> PathBuf {
        self.cfg.profiles_dir.join(name)
    }

    /// Profiles on disk (plus `default`, which always exists logically).
    pub fn profiles(&self) -> Vec<String> {
        let mut v: Vec<String> = std::fs::read_dir(&self.cfg.profiles_dir)
            .map(|rd| {
                rd.filter_map(|e| e.ok())
                    .filter(|e| e.file_type().map(|t| t.is_dir()).unwrap_or(false))
                    .filter_map(|e| e.file_name().into_string().ok())
                    .filter(|n| valid_profile_name(n))
                    .collect()
            })
            .unwrap_or_default();
        if !v.iter().any(|p| p == DEFAULT_PROFILE) {
            v.push(DEFAULT_PROFILE.to_string());
        }
        v.sort();
        v
    }

    /// Profiles whose browser is running.
    pub async fn running(&self) -> Vec<String> {
        let entries = self.entries.lock().await;
        let mut v = Vec::new();
        for (name, e) in entries.iter() {
            if e.launcher.is_running().await {
                v.push(name.clone());
            }
        }
        v.sort();
        v
    }

    /// True if any profile's extension is connected.
    pub async fn any_connected(&self) -> bool {
        self.entries
            .lock()
            .await
            .values()
            .any(|e| e.bridge.is_connected())
    }

    async fn entry(
        &self,
        name: &str,
    ) -> Result<(Arc<BrowserLauncher>, BrowserBridge, Arc<Mutex<()>>)> {
        let mut entries = self.entries.lock().await;
        if let Some(e) = entries.get(name) {
            return Ok((e.launcher.clone(), e.bridge.clone(), e.busy.clone()));
        }
        let socket = self.cfg.socket_dir.join(format!("bridge-{name}.sock"));
        let bridge = BrowserBridge::bind(&socket).await?;
        let mut launch = self.cfg.launch.clone();
        launch.profile_dir = self.profile_dir(name);
        launch.bridge_socket = socket;
        // Lets people tell the windows apart in the viewer.
        launch
            .extra_args
            .push(format!("--window-name=Hexactra: {name}"));
        let launcher = BrowserLauncher::new(launch, bridge.clone());
        launcher.spawn_idle_watcher();
        let busy = Arc::new(Mutex::new(()));
        entries.insert(
            name.to_string(),
            Entry {
                launcher: launcher.clone(),
                bridge: bridge.clone(),
                busy: busy.clone(),
                last_used: Instant::now(),
            },
        );
        Ok((launcher, bridge, busy))
    }

    /// Make room for `name` and start its browser, closing the least
    /// recently used idle browser when the pool is full.
    async fn ensure_started(
        &self,
        name: &str,
        launcher: &Arc<BrowserLauncher>,
        deadline: Instant,
    ) -> Result<()> {
        loop {
            {
                let _cap = self.capacity.lock().await;
                if launcher.is_running().await {
                    drop(_cap);
                    return launcher.ensure_running().await;
                }
                // Running browsers other than this one, oldest first.
                let mut others: Vec<Slot> = Vec::new();
                for (n, e) in self.entries.lock().await.iter() {
                    if n != name && e.launcher.is_running().await {
                        others.push((e.last_used, n.clone(), e.launcher.clone(), e.busy.clone()));
                    }
                }
                if others.len() < self.cfg.max_browsers {
                    return launcher.ensure_running().await;
                }
                others.sort_by_key(|o| o.0);
                for (_, other, l, busy) in others {
                    // Only close a browser that is not executing an action.
                    if let Ok(_guard) = busy.try_lock() {
                        tracing::info!(closing = %other, starting = %name, "browser pool full; closing the least recently used browser");
                        l.shutdown().await;
                        return launcher.ensure_running().await;
                    }
                }
            }
            if Instant::now() >= deadline {
                bail!(
                    "all {} browser slot(s) are busy with other profiles; try again or raise --max-browsers",
                    self.cfg.max_browsers
                );
            }
            tokio::time::sleep(Duration::from_millis(200)).await;
        }
    }

    /// Run one action on a profile's browser.
    pub async fn execute(
        &self,
        profile: &str,
        op_id: Uuid,
        action: &RemoteAction,
        deadline: DateTime<Utc>,
    ) -> OperationResult {
        if !valid_profile_name(profile) {
            return failure(format!("invalid profile name {profile:?}"));
        }
        let (launcher, bridge, busy) = match self.entry(profile).await {
            Ok(e) => e,
            Err(e) => return failure(format!("profile {profile}: {e:#}")),
        };
        let _busy = busy.lock().await; // per-profile ordering
        let left = (deadline - Utc::now()).to_std().unwrap_or(Duration::ZERO);
        if let Err(e) = self
            .ensure_started(profile, &launcher, Instant::now() + left)
            .await
        {
            return failure(format!("browser unavailable for profile {profile}: {e:#}"));
        }
        let r = bridge.execute(op_id, action, deadline).await;
        launcher.touch().await;
        if let Some(e) = self.entries.lock().await.get_mut(profile) {
            e.last_used = Instant::now();
        }
        r
    }

    /// Start a profile's browser now (e.g. at startup).
    pub async fn start(&self, profile: &str, timeout: Duration) -> Result<()> {
        if !valid_profile_name(profile) {
            bail!("invalid profile name {profile:?}");
        }
        let (launcher, _bridge, busy) = self.entry(profile).await?;
        let _busy = busy.lock().await;
        self.ensure_started(profile, &launcher, Instant::now() + timeout)
            .await
    }

    /// Close every browser (in parallel).
    pub async fn shutdown(&self) {
        let launchers: Vec<_> = self
            .entries
            .lock()
            .await
            .values()
            .map(|e| e.launcher.clone())
            .collect();
        let tasks: Vec<_> = launchers
            .into_iter()
            .map(|l| tokio::spawn(async move { l.shutdown().await }))
            .collect();
        for t in tasks {
            let _ = t.await;
        }
    }

    /// Profile directory root (for logs and status).
    pub fn profiles_dir(&self) -> &Path {
        &self.cfg.profiles_dir
    }
}

/// Move a pre-profiles single profile directory to `<profiles_dir>/default`.
pub fn migrate_single_profile(
    old: Option<&std::path::Path>,
    profiles_dir: &std::path::Path,
) -> Result<()> {
    let Some(old) = old else { return Ok(()) };
    let target = profiles_dir.join(DEFAULT_PROFILE);
    if old == target || !old.is_dir() || target.exists() {
        return Ok(());
    }
    std::fs::create_dir_all(profiles_dir)?;
    std::fs::rename(old, &target).with_context(|| {
        format!(
            "moving profile {} to {} (move it yourself, or pass --profiles-dir)",
            old.display(),
            target.display()
        )
    })?;
    tracing::info!(from = %old.display(), to = %target.display(), "moved the single profile to the default profile");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::launcher::tests_support::fake_browser;

    fn pool(dir: &Path, max: usize) -> Arc<BrowserPool> {
        BrowserPool::new(PoolConfig {
            profiles_dir: dir.join("profiles"),
            socket_dir: dir.join("run"),
            max_browsers: max,
            launch: LaunchConfig {
                browser: fake_browser(dir),
                profile_dir: PathBuf::new(),
                extension_dir: None,
                extra_args: vec![],
                idle_shutdown: None,
                native_host: PathBuf::from("/usr/local/bin/hexactra-native-host"),
                bridge_socket: PathBuf::new(),
                startup_timeout: Duration::from_secs(10),
            },
        })
        .unwrap()
    }

    async fn act(p: &BrowserPool, profile: &str) -> serde_json::Value {
        let r = p
            .execute(
                profile,
                Uuid::new_v4(),
                &RemoteAction::Tabs,
                Utc::now() + chrono::Duration::seconds(10),
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
    async fn profiles_are_isolated_and_capacity_one_switches_browsers() {
        if !python_available() {
            return;
        }
        let dir = tempfile::tempdir().unwrap();
        let p = pool(dir.path(), 1);
        assert_eq!(p.profiles(), vec!["default"]);

        let a = act(&p, "travel").await;
        assert!(a["profile"].as_str().unwrap().ends_with("profiles/travel"));
        assert_eq!(p.running().await, vec!["travel"]);

        // Switching profile closes the other browser at capacity 1.
        let b = act(&p, "work").await;
        assert!(b["profile"].as_str().unwrap().ends_with("profiles/work"));
        assert_eq!(p.running().await, vec!["work"]);
        assert_eq!(p.profiles(), vec!["default", "travel", "work"]);

        // Back to travel: relaunched with its own profile directory.
        let again = act(&p, "travel").await;
        assert_eq!(again["launches"], 2);
        p.shutdown().await;
    }

    #[tokio::test]
    async fn capacity_two_runs_profiles_side_by_side() {
        if !python_available() {
            return;
        }
        let dir = tempfile::tempdir().unwrap();
        let p = pool(dir.path(), 2);
        act(&p, "travel").await;
        act(&p, "work").await;
        assert_eq!(p.running().await, vec!["travel", "work"]);
        assert!(p.any_connected().await);
        p.shutdown().await;
    }

    #[test]
    fn single_profile_directory_becomes_default() {
        let dir = tempfile::tempdir().unwrap();
        let old = dir.path().join("profile");
        std::fs::create_dir_all(old.join("Default")).unwrap();
        std::fs::write(old.join("Default/Cookies"), b"x").unwrap();
        let profiles = dir.path().join("profiles");
        migrate_single_profile(Some(&old), &profiles).unwrap();
        assert!(profiles.join("default/Default/Cookies").exists());
        assert!(!old.exists());
        // Idempotent, and never overwrites an existing default profile.
        std::fs::create_dir_all(&old).unwrap();
        migrate_single_profile(Some(&old), &profiles).unwrap();
        assert!(old.exists());
        assert!(profiles.join("default/Default/Cookies").exists());
        migrate_single_profile(None, &profiles).unwrap();
    }

    #[tokio::test]
    async fn invalid_profile_names_are_refused() {
        let dir = tempfile::tempdir().unwrap();
        let p = pool(dir.path(), 1);
        let r = p
            .execute("../x", Uuid::new_v4(), &RemoteAction::Tabs, Utc::now())
            .await;
        assert!(r.error.unwrap().contains("invalid profile"));
    }
}
