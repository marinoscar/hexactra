//! The node's end of a remote desktop tunnel (#338, docs/nodes.md).
//!
//! On [`HostCommand::OpenDesktop`] the agent connects to its local desktop
//! server (a Unix socket or a loopback port, never the network), then dials
//! the fabric's host leg `GET /v1/hosts/{id}/desktop/{tunnel_id}` over the
//! same outbound HTTPS it uses for work, with its own host credential, and
//! pipes bytes both ways. The node opens no inbound port.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::sync::Semaphore;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::HeaderValue;
use tokio_tungstenite::tungstenite::Message;
use uuid::Uuid;

use crate::desktop::DesktopTarget;

/// Desktops a node shares at once.
pub const MAX_OPEN: usize = 2;
const LOCAL_CONNECT: Duration = Duration::from_secs(5);
const DIAL: Duration = Duration::from_secs(15);
/// Largest message accepted from the fabric (matches its relay limit).
const MAX_MESSAGE: usize = 1 << 20;

/// Why a desktop could not be opened; `code()` is the stable prefix reported
/// to the fabric.
#[derive(Debug, thiserror::Error)]
pub enum DesktopError {
    #[error("desktop_unavailable: this host has no desktop to share")]
    Unavailable,
    #[error("desktop_busy: {MAX_OPEN} desktops are already open on this host")]
    Busy,
    #[error("vnc_unavailable: cannot reach the local desktop server at {target}: {reason}")]
    Vnc { target: String, reason: String },
    #[error("tunnel_failed: {0}")]
    Tunnel(String),
    #[error("desktop_unavailable:wayland: this desktop session is Wayland, which blocks screen sharing; log in with an X11 session (\"Ubuntu on Xorg\")")]
    Wayland,
}

/// The person's X11 desktop shared on demand (attended mode, #341): x11vnc
/// runs only while someone views it, on a Unix socket in a 0700 directory,
/// and the person sees a notice while it runs.
pub struct OnDemandVnc {
    /// x11vnc (overridable for tests).
    pub binary: PathBuf,
    /// Where its socket goes (a private directory, created 0700).
    pub dir: PathBuf,
    /// Grace after the last viewer leaves before x11vnc stops.
    pub grace: Duration,
    state: tokio::sync::Mutex<OnDemandState>,
}

#[derive(Default)]
struct OnDemandState {
    child: Option<tokio::process::Child>,
    viewers: usize,
    generation: u64,
}

impl OnDemandVnc {
    pub fn new(binary: PathBuf, dir: PathBuf) -> Self {
        Self {
            binary,
            dir,
            grace: Duration::from_secs(30),
            state: Default::default(),
        }
    }

    /// The default for this user: `x11vnc` and `$XDG_RUNTIME_DIR/hexactra/vnc`.
    pub fn from_env() -> Self {
        let runtime = std::env::var_os("XDG_RUNTIME_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(std::env::temp_dir);
        Self::new(
            std::env::var_os("HEXACTRA_X11VNC")
                .map(PathBuf::from)
                .unwrap_or_else(|| "x11vnc".into()),
            runtime.join("hexactra").join("vnc"),
        )
    }

    fn socket(&self) -> PathBuf {
        self.dir.join("vnc.sock")
    }

    /// Wayland blocks the tools that share a live desktop (x11vnc on
    /// XWayland shows a black screen), so a Wayland session is refused even
    /// when it sets DISPLAY.
    pub fn wayland() -> bool {
        Self::wayland_in(|k| std::env::var(k).ok())
    }

    pub fn wayland_in(env: impl Fn(&str) -> Option<String>) -> bool {
        env("XDG_SESSION_TYPE").is_some_and(|t| t == "wayland")
            || (env("WAYLAND_DISPLAY").is_some() && env("DISPLAY").is_none())
    }

    /// Starts x11vnc if needed and connects to it; counts the viewer.
    async fn connect(&self) -> Result<tokio::net::UnixStream, String> {
        let mut st = self.state.lock().await;
        let running = match st.child.as_mut() {
            Some(c) => c.try_wait().ok().flatten().is_none(),
            None => false,
        };
        if !running {
            std::fs::create_dir_all(&self.dir).map_err(|e| e.to_string())?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let _ = std::fs::set_permissions(&self.dir, std::fs::Permissions::from_mode(0o700));
            }
            let _ = std::fs::remove_file(self.socket());
            let display = std::env::var("DISPLAY")
                .map_err(|_| "no DISPLAY: not in an X11 desktop session".to_string())?;
            let mut cmd = tokio::process::Command::new(&self.binary);
            cmd.args(["-display", &display])
                // No TCP listener: only the Unix socket in our 0700 directory.
                .args(["-rfbport", "0", "-unixsock"])
                .arg(self.socket())
                .args(["-shared", "-forever", "-nopw", "-noxdamage", "-quiet"])
                .stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .kill_on_drop(true);
            if let Ok(auth) = std::env::var("XAUTHORITY") {
                cmd.args(["-auth", &auth]);
            }
            st.child = Some(
                cmd.spawn()
                    .map_err(|e| format!("starting {}: {e}", self.binary.display()))?,
            );
        }
        let deadline = tokio::time::Instant::now() + LOCAL_CONNECT;
        let stream = loop {
            match tokio::net::UnixStream::connect(self.socket()).await {
                Ok(s) => break s,
                Err(e) if tokio::time::Instant::now() >= deadline => {
                    return Err(format!("x11vnc did not start: {e}"))
                }
                Err(_) => tokio::time::sleep(Duration::from_millis(100)).await,
            }
        };
        st.viewers += 1;
        st.generation += 1;
        Ok(stream)
    }

    /// One viewer left; x11vnc stops after the grace period if nobody else views.
    async fn release(self: Arc<Self>) {
        let generation = {
            let mut st = self.state.lock().await;
            st.viewers = st.viewers.saturating_sub(1);
            if st.viewers > 0 {
                return;
            }
            st.generation
        };
        tokio::time::sleep(self.grace).await;
        let mut st = self.state.lock().await;
        if st.viewers == 0 && st.generation == generation {
            if let Some(mut c) = st.child.take() {
                let _ = c.kill().await;
                tracing::info!("stopped sharing the desktop (no viewer)");
            }
            let _ = std::fs::remove_file(self.socket());
        }
    }

    /// Whether x11vnc runs now.
    pub async fn running(&self) -> bool {
        let mut st = self.state.lock().await;
        match st.child.as_mut() {
            Some(c) => c.try_wait().ok().flatten().is_none(),
            None => false,
        }
    }
}

/// Tells the person at the machine that someone views their desktop.
fn notify(summary: &str, body: &str) {
    let _ = std::process::Command::new("notify-send")
        .args(["--app-name=Hexactra", "--icon=video-display", summary, body])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn();
}

/// Opens desktops for this host.
#[derive(Clone)]
pub struct DesktopBridge {
    target: Option<DesktopTarget>,
    control_url: String,
    token: String,
    slots: Arc<Semaphore>,
    on_demand: Option<Arc<OnDemandVnc>>,
}

trait Stream: AsyncRead + AsyncWrite + Unpin + Send {}
impl<T: AsyncRead + AsyncWrite + Unpin + Send> Stream for T {}

impl DesktopBridge {
    pub fn new(target: Option<DesktopTarget>, control_url: &str, token: &str) -> Self {
        Self {
            control_url: control_url.trim_end_matches('/').to_string(),
            token: token.to_string(),
            slots: Arc::new(Semaphore::new(MAX_OPEN)),
            on_demand: (target == Some(DesktopTarget::X11vncOnDemand))
                .then(|| Arc::new(OnDemandVnc::from_env())),
            target,
        }
    }

    /// Uses this on-demand provider (tests).
    pub fn with_on_demand(mut self, v: OnDemandVnc) -> Self {
        self.on_demand = Some(Arc::new(v));
        self
    }

    /// The fabric WebSocket URL of a tunnel's host leg.
    pub fn host_leg_url(&self, host_id: Uuid, tunnel_id: Uuid) -> String {
        let base = if let Some(rest) = self.control_url.strip_prefix("https://") {
            format!("wss://{rest}")
        } else if let Some(rest) = self.control_url.strip_prefix("http://") {
            format!("ws://{rest}")
        } else {
            self.control_url.clone()
        };
        format!("{base}/v1/hosts/{host_id}/desktop/{tunnel_id}")
    }

    async fn connect_local(&self) -> Result<Box<dyn Stream>, DesktopError> {
        let target = self.target.as_ref().ok_or(DesktopError::Unavailable)?;
        let vnc = |e: String| DesktopError::Vnc {
            target: target.to_string(),
            reason: e,
        };
        let s: Box<dyn Stream> = match target {
            #[cfg(unix)]
            DesktopTarget::Unix(path) => Box::new(
                tokio::time::timeout(LOCAL_CONNECT, tokio::net::UnixStream::connect(path))
                    .await
                    .map_err(|_| vnc("timed out".into()))?
                    .map_err(|e| vnc(e.to_string()))?,
            ),
            #[cfg(not(unix))]
            DesktopTarget::Unix(_) => {
                return Err(vnc("Unix sockets are not supported here".into()))
            }
            DesktopTarget::X11vncOnDemand => {
                if OnDemandVnc::wayland() {
                    return Err(DesktopError::Wayland);
                }
                let v = self.on_demand.as_ref().ok_or(DesktopError::Unavailable)?;
                Box::new(v.connect().await.map_err(vnc)?)
            }
            DesktopTarget::Tcp(addr) => Box::new(
                tokio::time::timeout(LOCAL_CONNECT, tokio::net::TcpStream::connect(addr))
                    .await
                    .map_err(|_| vnc("timed out".into()))?
                    .map_err(|e| vnc(e.to_string()))?,
            ),
        };
        Ok(s)
    }

    /// Connects the local desktop to the fabric and pipes it in the
    /// background. Returns once both ends are connected.
    pub async fn open(&self, host_id: Uuid, tunnel_id: Uuid) -> Result<(), DesktopError> {
        self.open_for(host_id, tunnel_id, None).await
    }

    /// As [`open`](Self::open), naming who views (for the on-screen notice).
    pub async fn open_for(
        &self,
        host_id: Uuid,
        tunnel_id: Uuid,
        viewer: Option<&str>,
    ) -> Result<(), DesktopError> {
        if self.target.is_none() {
            return Err(DesktopError::Unavailable);
        }
        let permit = self
            .slots
            .clone()
            .try_acquire_owned()
            .map_err(|_| DesktopError::Busy)?;
        let local = self.connect_local().await?;
        let shared = self
            .on_demand
            .clone()
            .filter(|_| self.target == Some(DesktopTarget::X11vncOnDemand));
        let release = |v: Option<Arc<OnDemandVnc>>| async move {
            if let Some(v) = v {
                v.release().await;
            }
        };
        let mut req = self
            .host_leg_url(host_id, tunnel_id)
            .into_client_request()
            .map_err(|e| DesktopError::Tunnel(e.to_string()))?;
        req.headers_mut().insert(
            "authorization",
            HeaderValue::from_str(&format!("Bearer {}", self.token))
                .map_err(|_| DesktopError::Tunnel("invalid credential".into()))?,
        );
        let config = tokio_tungstenite::tungstenite::protocol::WebSocketConfig::default()
            .max_message_size(Some(MAX_MESSAGE))
            .max_frame_size(Some(MAX_MESSAGE));
        let dialed = tokio::time::timeout(
            DIAL,
            tokio_tungstenite::connect_async_with_config(req, Some(config), false),
        )
        .await;
        let (ws, _) = match dialed {
            Ok(Ok(ws)) => ws,
            // The error never includes the request headers (the credential).
            Ok(Err(e)) => {
                release(shared).await;
                return Err(DesktopError::Tunnel(e.to_string()));
            }
            Err(_) => {
                release(shared).await;
                return Err(DesktopError::Tunnel(
                    "timed out connecting to the fabric".into(),
                ));
            }
        };
        tracing::info!(%tunnel_id, "desktop tunnel connected");
        let who = viewer.unwrap_or("Someone").to_string();
        if shared.is_some() {
            notify(
                "Your desktop is being viewed",
                &format!("{who} is viewing this desktop through Hexactra."),
            );
        }
        tokio::spawn(async move {
            let (up, down) = pipe(local, ws).await;
            tracing::info!(%tunnel_id, bytes_up = up, bytes_down = down, "desktop tunnel closed");
            if shared.is_some() {
                notify(
                    "Desktop viewing ended",
                    &format!("{who} stopped viewing this desktop."),
                );
            }
            release(shared).await;
            drop(permit);
        });
        Ok(())
    }
}

/// Pipes until either side ends. Returns (bytes sent to the viewer, bytes received).
async fn pipe<W>(local: Box<dyn Stream>, ws: W) -> (u64, u64)
where
    W: futures_util::Stream<Item = Result<Message, tokio_tungstenite::tungstenite::Error>>
        + futures_util::Sink<Message>
        + Unpin,
{
    let (mut lr, mut lw) = tokio::io::split(local);
    let (mut wtx, mut wrx) = ws.split();
    let mut buf = vec![0u8; 64 * 1024];
    let (mut up, mut down) = (0u64, 0u64);
    loop {
        tokio::select! {
            n = lr.read(&mut buf) => match n {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    up += n as u64;
                    if wtx.send(Message::Binary(buf[..n].to_vec().into())).await.is_err() { break; }
                }
            },
            m = wrx.next() => match m {
                Some(Ok(Message::Binary(b))) => {
                    down += b.len() as u64;
                    if lw.write_all(&b).await.is_err() { break; }
                }
                Some(Ok(Message::Ping(p))) => { let _ = wtx.send(Message::Pong(p)).await; }
                Some(Ok(Message::Close(_))) | None | Some(Err(_)) => break,
                Some(Ok(_)) => {}
            },
        }
    }
    let _ = wtx.send(Message::Close(None)).await;
    let _ = lw.shutdown().await;
    (up, down)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::net::{TcpListener, UnixListener};

    const RFB: &[u8] = b"RFB 003.008\n";

    /// A fake fabric host leg: accepts one WebSocket, checks the credential.
    async fn fake_fabric() -> (
        String,
        tokio::sync::oneshot::Receiver<(
            String,
            tokio_tungstenite::WebSocketStream<tokio::net::TcpStream>,
        )>,
    ) {
        let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", l.local_addr().unwrap());
        let (tx, rx) = tokio::sync::oneshot::channel();
        tokio::spawn(async move {
            let (s, _) = l.accept().await.unwrap();
            let mut auth = String::new();
            let ws = tokio_tungstenite::accept_hdr_async(
                s,
                |req: &tokio_tungstenite::tungstenite::handshake::server::Request, resp| {
                    auth = format!(
                        "{} {}",
                        req.uri().path(),
                        req.headers()
                            .get("authorization")
                            .and_then(|v| v.to_str().ok())
                            .unwrap_or("")
                    );
                    Ok(resp)
                },
            )
            .await
            .unwrap();
            let _ = tx.send((auth, ws));
        });
        (url, rx)
    }

    #[tokio::test]
    async fn pipes_a_local_vnc_socket_to_the_fabric() {
        let dir = tempfile::tempdir().unwrap();
        let sock = dir.path().join("vnc.sock");
        let vnc = UnixListener::bind(&sock).unwrap();
        let (got_tx, got_rx) = tokio::sync::oneshot::channel::<Vec<u8>>();
        tokio::spawn(async move {
            let (mut s, _) = vnc.accept().await.unwrap();
            s.write_all(RFB).await.unwrap();
            let mut b = [0u8; 12];
            s.read_exact(&mut b).await.unwrap();
            let _ = got_tx.send(b.to_vec());
        });
        let (url, fabric) = fake_fabric().await;
        let bridge = DesktopBridge::new(Some(DesktopTarget::Unix(sock)), &url, "hxh_host_token");
        let (host, tunnel) = (Uuid::new_v4(), Uuid::new_v4());
        bridge.open(host, tunnel).await.unwrap();
        let (auth, mut ws) = fabric.await.unwrap();
        assert_eq!(
            auth,
            format!("/v1/hosts/{host}/desktop/{tunnel} Bearer hxh_host_token")
        );
        match ws.next().await.unwrap().unwrap() {
            Message::Binary(b) => assert_eq!(&b[..], RFB),
            m => panic!("{m:?}"),
        }
        ws.send(Message::Binary(RFB.to_vec().into())).await.unwrap();
        assert_eq!(got_rx.await.unwrap(), RFB);
    }

    #[tokio::test]
    async fn reports_why_a_desktop_cannot_open() {
        let none = DesktopBridge::new(None, "http://127.0.0.1:1", "t");
        assert!(matches!(
            none.open(Uuid::new_v4(), Uuid::new_v4()).await,
            Err(DesktopError::Unavailable)
        ));
        let gone = DesktopBridge::new(
            Some(DesktopTarget::Unix("/nonexistent/vnc.sock".into())),
            "http://127.0.0.1:1",
            "t",
        );
        let e = gone.open(Uuid::new_v4(), Uuid::new_v4()).await.unwrap_err();
        assert!(e.to_string().starts_with("vnc_unavailable: "), "{e}");
    }

    #[test]
    fn wayland_sessions_are_refused() {
        let env = |pairs: &'static [(&'static str, &'static str)]| {
            move |k: &str| {
                pairs
                    .iter()
                    .find(|(n, _)| *n == k)
                    .map(|(_, v)| v.to_string())
            }
        };
        assert!(OnDemandVnc::wayland_in(env(&[
            ("XDG_SESSION_TYPE", "wayland"),
            ("DISPLAY", ":0")
        ])));
        assert!(OnDemandVnc::wayland_in(env(&[(
            "WAYLAND_DISPLAY",
            "wayland-0"
        )])));
        assert!(!OnDemandVnc::wayland_in(env(&[
            ("XDG_SESSION_TYPE", "x11"),
            ("DISPLAY", ":0")
        ])));
        assert!(!OnDemandVnc::wayland_in(env(&[("DISPLAY", ":0")])));
    }

    /// A fake x11vnc: listens on the -unixsock path, greets each viewer with
    /// RFB, records it ran, and runs until killed.
    fn fake_x11vnc(dir: &std::path::Path) -> PathBuf {
        let script = dir.join("x11vnc");
        std::fs::write(
            &script,
            format!(
                "#!/usr/bin/env python3\nimport os,socket,sys\nargs=sys.argv\npath=args[args.index('-unixsock')+1]\nassert args[args.index('-rfbport')+1]=='0'\nopen('{}','a').write('start\\n')\ns=socket.socket(socket.AF_UNIX);s.bind(path);s.listen(4)\nwhile True:\n  c,_=s.accept();c.sendall(b'RFB 003.008\\n')\n",
                dir.join("starts").display()
            ),
        )
        .unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        script
    }

    #[tokio::test]
    async fn shares_the_x11_desktop_only_while_someone_views_it() {
        if std::process::Command::new("python3")
            .arg("--version")
            .output()
            .is_err()
        {
            return;
        }
        std::env::set_var("DISPLAY", ":0");
        let dir = tempfile::tempdir().unwrap();
        let mut v = OnDemandVnc::new(fake_x11vnc(dir.path()), dir.path().join("vnc"));
        v.grace = Duration::from_millis(300);
        let (url, fabric) = fake_fabric().await;
        let bridge = DesktopBridge::new(Some(DesktopTarget::X11vncOnDemand), &url, "hxh_t")
            .with_on_demand(v);
        let shared = bridge.on_demand.clone().unwrap();
        assert!(!shared.running().await, "nothing runs before anyone views");
        bridge
            .open_for(Uuid::new_v4(), Uuid::new_v4(), Some("Person A"))
            .await
            .unwrap();
        assert!(shared.running().await);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(dir.path().join("vnc"))
                .unwrap()
                .permissions()
                .mode();
            assert_eq!(mode & 0o777, 0o700, "the socket directory is private");
        }
        let (_, mut ws) = fabric.await.unwrap();
        match ws.next().await.unwrap().unwrap() {
            Message::Binary(b) => assert_eq!(&b[..], RFB),
            m => panic!("{m:?}"),
        }
        // The viewer leaves: x11vnc stops after the grace period.
        ws.close(None).await.unwrap();
        drop(ws);
        tokio::time::sleep(Duration::from_millis(900)).await;
        assert!(!shared.running().await, "x11vnc stops once nobody views");
        assert_eq!(
            std::fs::read_to_string(dir.path().join("starts")).unwrap(),
            "start\n"
        );
    }

    #[test]
    fn host_leg_urls_follow_the_fabric_scheme() {
        let b = DesktopBridge::new(None, "https://console.example.test/fabric/", "t");
        let (h, t) = (Uuid::nil(), Uuid::nil());
        assert_eq!(
            b.host_leg_url(h, t),
            format!("wss://console.example.test/fabric/v1/hosts/{h}/desktop/{t}")
        );
        let b = DesktopBridge::new(None, "http://fabric-control:8787", "t");
        assert!(b
            .host_leg_url(h, t)
            .starts_with("ws://fabric-control:8787/v1/hosts/"));
    }
}
