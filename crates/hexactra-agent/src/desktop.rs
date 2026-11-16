//! Where this host's desktop server listens (#336), so the fabric can relay a
//! remote-desktop session to it (#338). The target is always local: a Unix
//! socket, or a loopback TCP port. It is never reachable from the network.

use std::net::SocketAddr;
use std::path::PathBuf;

/// The local desktop server (`--desktop-vnc` / `HEXACTRA_DESKTOP_VNC`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DesktopTarget {
    /// `unix:/path/to/vnc.sock`: an RFB server on a Unix socket.
    Unix(PathBuf),
    /// `tcp:127.0.0.1:5900`: an RFB server on a loopback port.
    Tcp(SocketAddr),
    /// `x11vnc`: the person's own X11 desktop (attended mode, #341). The
    /// agent starts x11vnc on a private Unix socket only while someone
    /// views it, and stops it 30 seconds after the last viewer leaves.
    X11vncOnDemand,
}

impl std::str::FromStr for DesktopTarget {
    type Err = String;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        let s = s.trim();
        if s == "x11vnc" {
            return Ok(DesktopTarget::X11vncOnDemand);
        }
        if let Some(path) = s.strip_prefix("unix:") {
            let path = PathBuf::from(path);
            if !path.is_absolute() {
                return Err(format!("desktop socket must be an absolute path: {s}"));
            }
            return Ok(DesktopTarget::Unix(path));
        }
        if let Some(addr) = s.strip_prefix("tcp:") {
            let addr: SocketAddr = addr
                .parse()
                .map_err(|_| format!("expected tcp:127.0.0.1:<port>, got {s}"))?;
            if !addr.ip().is_loopback() {
                return Err(format!(
                    "the desktop server must listen on loopback only, got {s}"
                ));
            }
            return Ok(DesktopTarget::Tcp(addr));
        }
        Err(format!(
            "expected unix:/path/to/socket, tcp:127.0.0.1:<port> or x11vnc, got {s}"
        ))
    }
}

impl std::fmt::Display for DesktopTarget {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            DesktopTarget::Unix(p) => write!(f, "unix:{}", p.display()),
            DesktopTarget::Tcp(a) => write!(f, "tcp:{a}"),
            DesktopTarget::X11vncOnDemand => write!(f, "x11vnc"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_unix_and_loopback_tcp() {
        assert_eq!(
            "unix:/run/user/1000/hexactra/vnc.sock".parse::<DesktopTarget>(),
            Ok(DesktopTarget::Unix(
                "/run/user/1000/hexactra/vnc.sock".into()
            ))
        );
        assert_eq!(
            "tcp:127.0.0.1:5900".parse::<DesktopTarget>(),
            Ok(DesktopTarget::Tcp("127.0.0.1:5900".parse().unwrap()))
        );
        assert!("tcp:[::1]:5900".parse::<DesktopTarget>().is_ok());
    }

    #[test]
    fn refuses_network_and_relative_targets() {
        assert!("tcp:0.0.0.0:5900".parse::<DesktopTarget>().is_err());
        assert!("tcp:192.168.1.5:5900".parse::<DesktopTarget>().is_err());
        assert!("unix:vnc.sock".parse::<DesktopTarget>().is_err());
        assert!("vnc://127.0.0.1:5900".parse::<DesktopTarget>().is_err());
    }

    #[test]
    fn displays_round_trip() {
        for s in ["unix:/tmp/x.sock", "tcp:127.0.0.1:5900", "x11vnc"] {
            assert_eq!(s.parse::<DesktopTarget>().unwrap().to_string(), s);
        }
    }
}
