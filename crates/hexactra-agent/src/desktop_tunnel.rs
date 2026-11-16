//! The node's end of a remote desktop tunnel (#338, docs/nodes.md).
//!
//! On [`HostCommand::OpenDesktop`] the agent connects to its local desktop
//! server (a Unix socket or a loopback port, never the network), then dials
//! the fabric's host leg `GET /v1/hosts/{id}/desktop/{tunnel_id}` over the
//! same outbound HTTPS it uses for work, with its own host credential, and
//! pipes bytes both ways. The node opens no inbound port.

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
}

/// Opens desktops for this host.
#[derive(Clone)]
pub struct DesktopBridge {
    target: Option<DesktopTarget>,
    control_url: String,
    token: String,
    slots: Arc<Semaphore>,
}

trait Stream: AsyncRead + AsyncWrite + Unpin + Send {}
impl<T: AsyncRead + AsyncWrite + Unpin + Send> Stream for T {}

impl DesktopBridge {
    pub fn new(target: Option<DesktopTarget>, control_url: &str, token: &str) -> Self {
        Self {
            target,
            control_url: control_url.trim_end_matches('/').to_string(),
            token: token.to_string(),
            slots: Arc::new(Semaphore::new(MAX_OPEN)),
        }
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
        if self.target.is_none() {
            return Err(DesktopError::Unavailable);
        }
        let permit = self
            .slots
            .clone()
            .try_acquire_owned()
            .map_err(|_| DesktopError::Busy)?;
        let local = self.connect_local().await?;
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
        let (ws, _) = tokio::time::timeout(
            DIAL,
            tokio_tungstenite::connect_async_with_config(req, Some(config), false),
        )
        .await
        .map_err(|_| DesktopError::Tunnel("timed out connecting to the fabric".into()))?
        // The error never includes the request headers (the credential).
        .map_err(|e| DesktopError::Tunnel(e.to_string()))?;
        tracing::info!(%tunnel_id, "desktop tunnel connected");
        tokio::spawn(async move {
            let (up, down) = pipe(local, ws).await;
            tracing::info!(%tunnel_id, bytes_up = up, bytes_down = down, "desktop tunnel closed");
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
