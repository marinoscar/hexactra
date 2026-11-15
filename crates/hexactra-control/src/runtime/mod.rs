//! Remote browser control runtime (epic #173): the `/v1` API, the in-memory
//! host/session/operation store and the server entry point used by the
//! `hexactra-control` binary.

pub mod api;
pub mod credentials;
mod credentials_api;
pub mod handoff;
mod handoff_api;
pub mod store;
mod webhook_api;
pub mod webhooks;

use std::net::SocketAddr;
use std::path::{Path, PathBuf};

use anyhow::{bail, Context, Result};

pub use api::{router, ApiState};
pub use store::RuntimeStore;

/// Resolve the API token: explicit value, then a token file, then a generated
/// token persisted to `default_file` with mode 0600.
///
/// Returns the token and, when one was generated, the file it was written to.
pub fn resolve_token(
    explicit: Option<String>,
    token_file: Option<&Path>,
    default_file: &Path,
) -> Result<(String, Option<PathBuf>)> {
    if let Some(t) = explicit.filter(|t| !t.trim().is_empty()) {
        check_token_strength(&t)?;
        return Ok((t.trim().to_string(), None));
    }
    let file = token_file.unwrap_or(default_file);
    if file.exists() {
        let t = std::fs::read_to_string(file)
            .with_context(|| format!("reading token file {}", file.display()))?;
        let t = t.trim().to_string();
        check_token_strength(&t)?;
        return Ok((t, None));
    }
    if token_file.is_some() {
        bail!("token file {} does not exist", file.display());
    }
    let token = generate_token();
    write_secret_file(file, &token)?;
    Ok((token, Some(file.to_path_buf())))
}

fn check_token_strength(t: &str) -> Result<()> {
    if t.trim().len() < 24 {
        bail!("API token must be at least 24 characters");
    }
    Ok(())
}

/// 32 random bytes, hex encoded.
pub fn generate_token() -> String {
    use rand::RngCore;
    let mut b = [0u8; 32];
    rand::rngs::OsRng.fill_bytes(&mut b);
    hex::encode(b)
}

fn write_secret_file(path: &Path, contents: &str) -> Result<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).with_context(|| format!("creating {}", dir.display()))?;
    }
    #[cfg(unix)]
    {
        use std::io::Write;
        use std::os::unix::fs::OpenOptionsExt;
        let mut f = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(path)
            .with_context(|| format!("creating {}", path.display()))?;
        f.write_all(contents.as_bytes())?;
        f.write_all(b"\n")?;
    }
    #[cfg(not(unix))]
    std::fs::write(path, format!("{contents}\n"))?;
    Ok(())
}

/// Refuse to listen on a non-loopback address unless explicitly allowed.
pub fn check_bind(addr: &SocketAddr, allow_remote: bool) -> Result<()> {
    if !addr.ip().is_loopback() && !allow_remote {
        bail!(
            "refusing to bind {addr}: not a loopback address. Use an SSH tunnel or a \
             private network, or pass --allow-remote-bind to listen on {}",
            addr.ip()
        );
    }
    Ok(())
}

/// Serve the `/v1` API until `shutdown` resolves.
pub async fn serve(
    listener: tokio::net::TcpListener,
    state: ApiState,
    shutdown: impl std::future::Future<Output = ()> + Send + 'static,
) -> Result<()> {
    state.webhooks.spawn_dispatcher(&state.store);
    axum::serve(listener, router(state))
        .with_graceful_shutdown(shutdown)
        .await
        .context("server error")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bind_policy() {
        assert!(check_bind(&"127.0.0.1:1".parse().unwrap(), false).is_ok());
        assert!(check_bind(&"[::1]:1".parse().unwrap(), false).is_ok());
        assert!(check_bind(&"0.0.0.0:1".parse().unwrap(), false).is_err());
        assert!(check_bind(&"0.0.0.0:1".parse().unwrap(), true).is_ok());
    }

    #[test]
    fn token_generated_once_and_private() {
        let dir = tempfile::tempdir().unwrap();
        let f = dir.path().join("sub/api-token");
        let (t1, created) = resolve_token(None, None, &f).unwrap();
        assert_eq!(created.as_deref(), Some(f.as_path()));
        let (t2, created2) = resolve_token(None, None, &f).unwrap();
        assert_eq!(t1, t2);
        assert!(created2.is_none());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&f).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o600);
        }
    }

    #[test]
    fn short_or_missing_tokens_rejected() {
        let dir = tempfile::tempdir().unwrap();
        assert!(resolve_token(Some("short".into()), None, &dir.path().join("t")).is_err());
        assert!(resolve_token(
            None,
            Some(&dir.path().join("missing")),
            &dir.path().join("t")
        )
        .is_err());
    }
}
