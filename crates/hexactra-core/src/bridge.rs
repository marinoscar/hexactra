//! Local bridge between the host agent and the native messaging host (#176).
//!
//! The host agent listens on a Unix socket; the native messaging host that
//! Chrome spawns for the extension connects to it and relays frames. Frames
//! on the socket are a 4-byte big-endian length followed by a JSON object.
//! (Chrome's own native messaging framing on stdio is native-endian; the
//! native host converts.)

use std::path::PathBuf;

use tokio::io::{AsyncReadExt, AsyncWriteExt};

/// Name the extension uses with `chrome.runtime.connectNative`.
pub const NATIVE_HOST_NAME: &str = "com.hexactra.nativehost";

/// Chrome refuses messages larger than 1 MiB from a native host.
pub const MAX_TO_EXTENSION: usize = 1024 * 1024;

/// Chrome allows up to 64 MiB from the extension to the native host.
pub const MAX_FROM_EXTENSION: usize = 64 * 1024 * 1024;

/// Environment variable overriding the bridge socket path.
pub const BRIDGE_SOCKET_ENV: &str = "HEXACTRA_BRIDGE_SOCKET";

/// Default socket path: `$XDG_RUNTIME_DIR/hexactra/bridge.sock`, falling
/// back to `/tmp/hexactra-<uid>/bridge.sock`. `HEXACTRA_BRIDGE_SOCKET`
/// overrides both.
pub fn bridge_socket_path() -> PathBuf {
    if let Some(p) = std::env::var_os(BRIDGE_SOCKET_ENV).filter(|p| !p.is_empty()) {
        return PathBuf::from(p);
    }
    if let Some(dir) = std::env::var_os("XDG_RUNTIME_DIR").filter(|p| !p.is_empty()) {
        return PathBuf::from(dir).join("hexactra").join("bridge.sock");
    }
    #[cfg(unix)]
    let uid = unsafe { libc::getuid() };
    #[cfg(not(unix))]
    let uid = 0;
    PathBuf::from(format!("/tmp/hexactra-{uid}")).join("bridge.sock")
}

/// Frame I/O errors.
#[derive(Debug, thiserror::Error)]
pub enum FrameError {
    #[error("frame of {0} bytes exceeds the {1}-byte limit")]
    TooLarge(usize, usize),
    #[error(transparent)]
    Io(#[from] std::io::Error),
}

/// Write one big-endian length-prefixed frame.
pub async fn write_frame<W: AsyncWriteExt + Unpin>(
    w: &mut W,
    payload: &[u8],
    max: usize,
) -> Result<(), FrameError> {
    if payload.len() > max {
        return Err(FrameError::TooLarge(payload.len(), max));
    }
    w.write_all(&(payload.len() as u32).to_be_bytes()).await?;
    w.write_all(payload).await?;
    w.flush().await?;
    Ok(())
}

/// Read one big-endian length-prefixed frame. `Ok(None)` on clean EOF.
pub async fn read_frame<R: AsyncReadExt + Unpin>(
    r: &mut R,
    max: usize,
) -> Result<Option<Vec<u8>>, FrameError> {
    let mut len = [0u8; 4];
    match r.read_exact(&mut len).await {
        Ok(_) => {}
        Err(e) if e.kind() == std::io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(e) => return Err(e.into()),
    }
    let len = u32::from_be_bytes(len) as usize;
    if len > max {
        return Err(FrameError::TooLarge(len, max));
    }
    let mut buf = vec![0u8; len];
    r.read_exact(&mut buf).await?;
    Ok(Some(buf))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn frame_round_trip_and_limits() {
        let (mut a, mut b) = tokio::io::duplex(1024);
        write_frame(&mut a, b"{\"x\":1}", 100).await.unwrap();
        assert_eq!(
            read_frame(&mut b, 100).await.unwrap().unwrap(),
            b"{\"x\":1}"
        );
        assert!(matches!(
            write_frame(&mut a, &[0u8; 10], 5).await,
            Err(FrameError::TooLarge(10, 5))
        ));
        write_frame(&mut a, &[b'a'; 50], 100).await.unwrap();
        assert!(matches!(
            read_frame(&mut b, 10).await,
            Err(FrameError::TooLarge(50, 10))
        ));
        drop(a);
        let (mut c, d) = tokio::io::duplex(8);
        drop(d);
        assert!(read_frame(&mut c, 10).await.unwrap().is_none());
    }

    #[test]
    fn socket_path_env_override() {
        // Only checks the override branch; the default depends on the session.
        std::env::set_var(BRIDGE_SOCKET_ENV, "/tmp/x/bridge.sock");
        assert_eq!(bridge_socket_path(), PathBuf::from("/tmp/x/bridge.sock"));
        std::env::remove_var(BRIDGE_SOCKET_ENV);
    }
}
