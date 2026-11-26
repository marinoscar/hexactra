//! Agent side of the local browser bridge (#176).
//!
//! Listens on a Unix socket (see [`hexactra_core::bridge::bridge_socket_path`]).
//! The native messaging host that Chrome spawns for the Hexactra extension
//! connects here; the agent sends `request` frames and receives `response`
//! frames correlated by id.
//!
//! Security: the socket directory is created with mode 0700, the socket with
//! 0600, and connections from any other Unix user are refused (SO_PEERCRED).

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use anyhow::{Context, Result};
use chrono::{DateTime, Utc};
use hexactra_core::bridge::{read_frame, write_frame, MAX_FROM_EXTENSION, MAX_TO_EXTENSION};
use hexactra_core::remote::{BlockedNavigation, OperationResult, RemoteAction};
use serde::{Deserialize, Serialize};
use tokio::net::{UnixListener, UnixStream};
use tokio::sync::{mpsc, oneshot};
use uuid::Uuid;

use crate::signin::{live_unknown_reason, parse_live_frame, SigninCheck};

#[derive(Serialize)]
struct RequestFrame<'a> {
    #[serde(rename = "type")]
    kind: &'static str,
    id: String,
    action: &'a RemoteAction,
    deadline_ms: i64,
    /// The session's allowed sites (#508). Always sent, so an empty list
    /// lifts the previous session's confinement on this browser.
    allowed_domains: &'a [String],
}

#[derive(Deserialize)]
struct IncomingFrame {
    #[serde(rename = "type")]
    kind: String,
    #[serde(default)]
    id: Option<String>,
    #[serde(default)]
    ok: Option<bool>,
    #[serde(default)]
    result: Option<serde_json::Value>,
    #[serde(default)]
    error: Option<String>,
    #[serde(default)]
    version: Option<String>,
    /// Top-level navigations the extension blocked since the last action.
    #[serde(default)]
    navigation_blocked: Vec<BlockedNavigation>,
}

struct Connection {
    id: u64,
    tx: mpsc::Sender<Vec<u8>>,
    hello: bool,
}

#[derive(Default)]
struct Inner {
    conn: Option<Connection>,
    next_conn_id: u64,
    pending: HashMap<String, (u64, oneshot::Sender<OperationResult>)>,
    extension_version: Option<String>,
    /// Receives the extension's live sign-in checks (E48, #928).
    signin_sink: Option<SigninSink>,
}

/// Where a bridge hands the extension's live sign-in checks.
pub type SigninSink = Arc<dyn Fn(SigninCheck) + Send + Sync>;

/// Handle to the bridge. Cheap to clone.
#[derive(Clone)]
pub struct BrowserBridge {
    inner: Arc<Mutex<Inner>>,
    socket: PathBuf,
}

/// The agent stops waiting for the browser this long before an action's
/// deadline, so its report reaches the control plane before the control plane
/// times the action out as "not reported in time" (#382).
pub const REPORT_MARGIN: Duration = Duration::from_secs(2);

/// How long to wait for the extension's answer: the time left, minus a
/// margin to report it (at most a fifth of the time left).
pub fn reply_wait(deadline: DateTime<Utc>, now: DateTime<Utc>) -> Duration {
    let left = (deadline - now).to_std().unwrap_or(Duration::ZERO);
    (left - REPORT_MARGIN.min(left / 5)).max(Duration::from_millis(100))
}

fn failure(msg: impl Into<String>) -> OperationResult {
    OperationResult {
        navigation_blocked: Vec::new(),
        ok: false,
        result: None,
        error: Some(msg.into()),
    }
}

#[cfg(unix)]
fn secure_dir(dir: &Path) -> Result<()> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::create_dir_all(dir).with_context(|| format!("creating {}", dir.display()))?;
    std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))
        .with_context(|| format!("securing {}", dir.display()))?;
    Ok(())
}

impl BrowserBridge {
    /// Bind the socket and start accepting the native host's connections.
    pub async fn bind(socket: &Path) -> Result<Self> {
        if let Some(dir) = socket.parent() {
            secure_dir(dir)?;
        }
        if socket.exists() {
            // A live agent would still accept; a stale socket refuses.
            if UnixStream::connect(socket).await.is_ok() {
                anyhow::bail!(
                    "another host agent is already listening on {}",
                    socket.display()
                );
            }
            std::fs::remove_file(socket)
                .with_context(|| format!("removing stale {}", socket.display()))?;
        }
        let listener =
            UnixListener::bind(socket).with_context(|| format!("binding {}", socket.display()))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(socket, std::fs::Permissions::from_mode(0o600))?;
        }
        let bridge = Self {
            inner: Arc::new(Mutex::new(Inner::default())),
            socket: socket.to_path_buf(),
        };
        let b = bridge.clone();
        tokio::spawn(async move { b.accept_loop(listener).await });
        tracing::info!(socket = %socket.display(), "browser bridge listening");
        Ok(bridge)
    }

    /// Socket path.
    pub fn socket(&self) -> &Path {
        &self.socket
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// True when the extension is connected and has said hello.
    pub fn is_connected(&self) -> bool {
        self.lock().conn.as_ref().map(|c| c.hello).unwrap_or(false)
    }

    /// Version reported by the connected extension.
    pub fn extension_version(&self) -> Option<String> {
        self.lock().extension_version.clone()
    }

    async fn accept_loop(self, listener: UnixListener) {
        loop {
            let stream = match listener.accept().await {
                Ok((s, _)) => s,
                Err(e) => {
                    tracing::warn!(error = %e, "bridge accept failed");
                    tokio::time::sleep(Duration::from_millis(200)).await;
                    continue;
                }
            };
            #[cfg(unix)]
            {
                let own = unsafe { libc::getuid() };
                match stream.peer_cred() {
                    Ok(c) if c.uid() == own => {}
                    Ok(c) => {
                        tracing::warn!(
                            peer_uid = c.uid(),
                            "refused bridge connection from another user"
                        );
                        continue;
                    }
                    Err(e) => {
                        tracing::warn!(error = %e, "could not verify bridge peer; refusing");
                        continue;
                    }
                }
            }
            self.attach(stream);
        }
    }

    fn attach(&self, stream: UnixStream) {
        let (mut rd, mut wr) = stream.into_split();
        let (tx, mut rx) = mpsc::channel::<Vec<u8>>(64);
        let conn_id = {
            let mut inner = self.lock();
            inner.next_conn_id += 1;
            let id = inner.next_conn_id;
            if inner.conn.is_some() {
                tracing::info!("replacing previous native host connection");
            }
            inner.conn = Some(Connection {
                id,
                tx,
                hello: false,
            });
            id
        };
        tracing::info!(conn_id, "native host connected");

        tokio::spawn(async move {
            while let Some(f) = rx.recv().await {
                if let Err(e) = write_frame(&mut wr, &f, MAX_TO_EXTENSION).await {
                    tracing::warn!(error = %e, "writing to native host failed");
                    break;
                }
            }
        });

        let bridge = self.clone();
        tokio::spawn(async move {
            loop {
                match read_frame(&mut rd, MAX_FROM_EXTENSION).await {
                    Ok(Some(f)) => bridge.on_frame(conn_id, &f),
                    Ok(None) => break,
                    Err(e) => {
                        tracing::warn!(error = %e, "reading from native host failed");
                        break;
                    }
                }
            }
            bridge.detach(conn_id);
        });
    }

    fn on_frame(&self, conn_id: u64, frame: &[u8]) {
        // The live sign-in check (E48): only state and email cross, and the
        // frame is never logged (it holds the email).
        if let Some(check) = parse_live_frame(frame) {
            // Why a check could not tell: a fixed value, never frame text.
            if let Some(reason) = live_unknown_reason(frame) {
                tracing::info!(reason = %reason, "live sign-in check could not tell");
            } else if check.signin == hexactra_core::remote::SigninState::Unknown {
                tracing::info!(reason = "inconsistent", "live sign-in check could not tell");
            }
            let sink = self.lock().signin_sink.clone();
            match sink {
                Some(sink) => sink(check),
                None => tracing::debug!("ignoring a sign-in status: nobody tracks it"),
            }
            return;
        }
        let msg: IncomingFrame = match serde_json::from_slice(frame) {
            Ok(m) => m,
            Err(e) => {
                tracing::warn!(error = %e, "ignoring malformed frame from extension");
                return;
            }
        };
        let mut inner = self.lock();
        match msg.kind.as_str() {
            "hello" => {
                if let Some(c) = inner.conn.as_mut().filter(|c| c.id == conn_id) {
                    c.hello = true;
                }
                inner.extension_version = msg.version;
                tracing::info!(version = ?inner.extension_version, "browser extension connected");
            }
            "response" => {
                let Some(id) = msg.id else { return };
                match inner.pending.remove(&id) {
                    Some((_, tx)) => {
                        let ok = msg.ok.unwrap_or(false);
                        let _ = tx.send(OperationResult {
                            ok,
                            result: msg.result,
                            error: if ok {
                                None
                            } else {
                                Some(msg.error.unwrap_or_else(|| "action failed".into()))
                            },
                            navigation_blocked: msg
                                .navigation_blocked
                                .into_iter()
                                .take(50)
                                .collect(),
                        });
                    }
                    None => tracing::debug!(%id, "response for unknown or expired request"),
                }
            }
            "pong" => {}
            other => tracing::debug!(kind = other, "ignoring frame"),
        }
    }

    fn detach(&self, conn_id: u64) {
        let mut inner = self.lock();
        if inner.conn.as_ref().map(|c| c.id) == Some(conn_id) {
            inner.conn = None;
            tracing::info!(conn_id, "native host disconnected");
        }
        let stale: Vec<String> = inner
            .pending
            .iter()
            .filter(|(_, (c, _))| *c == conn_id)
            .map(|(k, _)| k.clone())
            .collect();
        for k in stale {
            if let Some((_, tx)) = inner.pending.remove(&k) {
                let _ = tx.send(failure("browser disconnected before replying"));
            }
        }
    }

    /// Wait up to `max` for the extension to connect.
    pub async fn wait_connected(&self, max: Duration) -> bool {
        let end = tokio::time::Instant::now() + max;
        loop {
            if self.is_connected() {
                return true;
            }
            if tokio::time::Instant::now() >= end {
                return false;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    }

    /// Hand the extension's live sign-in checks to `sink`.
    pub fn on_signin(&self, sink: SigninSink) {
        self.lock().signin_sink = Some(sink);
    }

    /// Ask the extension to check the Google sign-in now (E48). Returns
    /// false if the request could not be sent.
    pub async fn request_signin_check(&self) -> bool {
        let sender = {
            let inner = self.lock();
            match inner.conn.as_ref().filter(|c| c.hello) {
                Some(c) => c.tx.clone(),
                None => return false,
            }
        };
        sender
            .send(br#"{"type":"check_signin"}"#.to_vec())
            .await
            .is_ok()
    }

    /// Ask the extension to close the browser's windows (graceful
    /// shutdown). Returns false if the request could not be sent.
    pub async fn request_shutdown(&self) -> bool {
        let sender = {
            let inner = self.lock();
            match inner.conn.as_ref().filter(|c| c.hello) {
                Some(c) => c.tx.clone(),
                None => return false,
            }
        };
        sender
            .send(br#"{"type":"shutdown"}"#.to_vec())
            .await
            .is_ok()
    }

    /// Execute one action in the browser, waiting until `deadline`. If the
    /// extension is momentarily disconnected (for example right after an
    /// agent restart), wait up to 5 seconds for it to reconnect first.
    pub async fn execute(
        &self,
        op_id: Uuid,
        action: &RemoteAction,
        deadline: DateTime<Utc>,
    ) -> OperationResult {
        self.execute_in(op_id, action, deadline, &[]).await
    }

    /// [`Self::execute`] in a session confined to `allowed_domains` (#508):
    /// the extension applies the list before the action and keeps it until
    /// the next one.
    pub async fn execute_in(
        &self,
        op_id: Uuid,
        action: &RemoteAction,
        deadline: DateTime<Utc>,
        allowed_domains: &[String],
    ) -> OperationResult {
        let grace = (deadline - Utc::now())
            .to_std()
            .unwrap_or(Duration::ZERO)
            .min(Duration::from_secs(5));
        self.wait_connected(grace).await;
        let id = op_id.to_string();
        let frame = RequestFrame {
            kind: "request",
            id: id.clone(),
            action,
            deadline_ms: deadline.timestamp_millis(),
            allowed_domains,
        };
        let payload = match serde_json::to_vec(&frame) {
            Ok(p) => p,
            Err(e) => return failure(format!("cannot encode action: {e}")),
        };
        let (tx, rx) = oneshot::channel();
        let sender = {
            let mut inner = self.lock();
            let Some(conn) = inner.conn.as_ref().filter(|c| c.hello) else {
                return failure("browser extension is not connected to this host");
            };
            let (cid, sender) = (conn.id, conn.tx.clone());
            inner.pending.insert(id.clone(), (cid, tx));
            sender
        };
        if sender.send(payload).await.is_err() {
            self.lock().pending.remove(&id);
            return failure("browser disconnected");
        }
        match tokio::time::timeout(reply_wait(deadline, Utc::now()), rx).await {
            Ok(Ok(r)) => r,
            Ok(Err(_)) => failure("browser disconnected before replying"),
            Err(_) => {
                self.lock().pending.remove(&id);
                failure("browser did not reply before the deadline (the page may be busy, or showing a dialog)")
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};

    async fn fake_extension(socket: &Path) -> UnixStream {
        let mut s = UnixStream::connect(socket).await.unwrap();
        write_frame(&mut s, br#"{"type":"hello","version":"9.9"}"#, 1 << 20)
            .await
            .unwrap();
        s
    }

    async fn wait_connected(b: &BrowserBridge) {
        for _ in 0..100 {
            if b.is_connected() {
                return;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        panic!("bridge never connected");
    }

    #[tokio::test]
    async fn not_connected_fails_fast() {
        let dir = tempfile::tempdir().unwrap();
        let b = BrowserBridge::bind(&dir.path().join("b.sock"))
            .await
            .unwrap();
        let r = b
            .execute(Uuid::new_v4(), &RemoteAction::Tabs, Utc::now())
            .await;
        assert!(!r.ok);
        assert!(r.error.unwrap().contains("not connected"));
    }

    #[tokio::test]
    async fn request_response_round_trip() {
        let dir = tempfile::tempdir().unwrap();
        let sock = dir.path().join("sub/b.sock");
        let b = BrowserBridge::bind(&sock).await.unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(sock.parent().unwrap())
                .unwrap()
                .permissions()
                .mode();
            assert_eq!(mode & 0o777, 0o700);
        }
        let mut ext = fake_extension(&sock).await;
        wait_connected(&b).await;
        assert_eq!(b.extension_version().as_deref(), Some("9.9"));

        let ext_task = tokio::spawn(async move {
            let f = read_frame(&mut ext, 1 << 20).await.unwrap().unwrap();
            let req: Value = serde_json::from_slice(&f).unwrap();
            assert_eq!(req["type"], "request");
            assert_eq!(req["action"]["type"], "tabs");
            let resp =
                json!({"type": "response", "id": req["id"], "ok": true, "result": {"tabs": []}});
            write_frame(&mut ext, resp.to_string().as_bytes(), 1 << 20)
                .await
                .unwrap();
            ext
        });
        let r = b
            .execute(
                Uuid::new_v4(),
                &RemoteAction::Tabs,
                Utc::now() + chrono::Duration::seconds(5),
            )
            .await;
        assert!(r.ok, "{:?}", r.error);
        assert_eq!(r.result.unwrap(), json!({"tabs": []}));
        let _ext = ext_task.await.unwrap();
    }

    #[tokio::test]
    async fn allowed_domains_go_out_and_blocked_navigations_come_back() {
        let dir = tempfile::tempdir().unwrap();
        let sock = dir.path().join("b.sock");
        let b = BrowserBridge::bind(&sock).await.unwrap();
        let mut ext = fake_extension(&sock).await;
        wait_connected(&b).await;
        let ext_task = tokio::spawn(async move {
            let f = read_frame(&mut ext, 1 << 20).await.unwrap().unwrap();
            let req: Value = serde_json::from_slice(&f).unwrap();
            assert_eq!(req["allowed_domains"], json!(["example.com"]));
            let resp = json!({"type": "response", "id": req["id"], "ok": false,
                "error": "navigation_blocked: evil.test is not in this session's allowed sites",
                "navigation_blocked": [{"host": "evil.test", "at": "2026-11-18T10:00:00Z"}]});
            write_frame(&mut ext, resp.to_string().as_bytes(), 1 << 20)
                .await
                .unwrap();
            // An unconfined action still sends the (empty) list, to lift it.
            let f = read_frame(&mut ext, 1 << 20).await.unwrap().unwrap();
            let req: Value = serde_json::from_slice(&f).unwrap();
            assert_eq!(req["allowed_domains"], json!([]));
            let resp = json!({"type": "response", "id": req["id"], "ok": true});
            write_frame(&mut ext, resp.to_string().as_bytes(), 1 << 20)
                .await
                .unwrap();
            ext
        });
        let r = b
            .execute_in(
                Uuid::new_v4(),
                &RemoteAction::Tabs,
                Utc::now() + chrono::Duration::seconds(5),
                &["example.com".to_string()],
            )
            .await;
        assert!(!r.ok);
        assert_eq!(r.navigation_blocked.len(), 1);
        assert_eq!(r.navigation_blocked[0].host, "evil.test");
        let r = b
            .execute(
                Uuid::new_v4(),
                &RemoteAction::Tabs,
                Utc::now() + chrono::Duration::seconds(5),
            )
            .await;
        assert!(r.ok && r.navigation_blocked.is_empty());
        let _ext = ext_task.await.unwrap();
    }

    #[tokio::test]
    async fn disconnect_fails_pending_and_deadline_is_enforced() {
        let dir = tempfile::tempdir().unwrap();
        let sock = dir.path().join("b.sock");
        let b = BrowserBridge::bind(&sock).await.unwrap();

        // Extension that never answers -> deadline.
        let ext = fake_extension(&sock).await;
        wait_connected(&b).await;
        let r = b
            .execute(
                Uuid::new_v4(),
                &RemoteAction::Tabs,
                Utc::now() + chrono::Duration::milliseconds(200),
            )
            .await;
        assert!(r.error.unwrap().contains("deadline"));

        // Extension that disconnects mid-request.
        let b2 = b.clone();
        let pending = tokio::spawn(async move {
            b2.execute(
                Uuid::new_v4(),
                &RemoteAction::Tabs,
                Utc::now() + chrono::Duration::seconds(5),
            )
            .await
        });
        tokio::time::sleep(Duration::from_millis(50)).await;
        drop(ext);
        let r = pending.await.unwrap();
        assert!(!r.ok);
        assert!(r.error.unwrap().contains("disconnected"));
    }

    #[test]
    fn reply_wait_leaves_time_to_report() {
        let now = Utc::now();
        // 45 s: the browser has 43 s, the agent 2 s to report.
        assert_eq!(
            reply_wait(now + chrono::Duration::seconds(45), now),
            Duration::from_secs(43)
        );
        // Short deadlines keep four fifths.
        assert_eq!(
            reply_wait(now + chrono::Duration::seconds(5), now),
            Duration::from_secs(4)
        );
        // Past the deadline: a token wait, never a panic.
        assert_eq!(
            reply_wait(now - chrono::Duration::seconds(1), now),
            Duration::from_millis(100)
        );
    }

    #[tokio::test]
    async fn signin_checks_are_requested_and_reach_the_sink() {
        let dir = tempfile::tempdir().unwrap();
        let sock = dir.path().join("b.sock");
        let b = BrowserBridge::bind(&sock).await.unwrap();
        assert!(!b.request_signin_check().await, "nobody connected yet");
        let (tx, mut rx) = mpsc::unbounded_channel();
        b.on_signin(Arc::new(move |c| {
            let _ = tx.send(c);
        }));
        let mut ext = fake_extension(&sock).await;
        wait_connected(&b).await;
        assert!(b.request_signin_check().await);
        let f = read_frame(&mut ext, 1 << 20).await.unwrap().unwrap();
        assert_eq!(
            serde_json::from_slice::<Value>(&f).unwrap(),
            json!({"type": "check_signin"})
        );
        let status = json!({"type": "profile_status", "signin": "signed_in",
            "accounts": [{"provider": "google", "email": "a@example.com", "state": "signed_in"}]});
        write_frame(&mut ext, status.to_string().as_bytes(), 1 << 20)
            .await
            .unwrap();
        let c = tokio::time::timeout(Duration::from_secs(5), rx.recv())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(c.signin, hexactra_core::remote::SigninState::SignedIn);
        assert_eq!(c.accounts[0].email, "a@example.com");
    }

    #[tokio::test]
    async fn second_agent_refuses_live_socket() {
        let dir = tempfile::tempdir().unwrap();
        let sock = dir.path().join("b.sock");
        let _b = BrowserBridge::bind(&sock).await.unwrap();
        assert!(BrowserBridge::bind(&sock).await.is_err());
    }
}
