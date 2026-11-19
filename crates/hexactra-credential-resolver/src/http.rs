//! The HTTP client provider implementations use.
//!
//! Vault's rules for a runtime that holds a value: never log request or
//! response bodies or headers, cache nothing, time out fast, and treat a
//! redirect as a failure (a redirect would carry the bearer token elsewhere).
//! This builds a client that does all of that. Using it is how a provider
//! holds those rules; the rules themselves live in a test below.

use std::time::Duration;

use reqwest::header::{HeaderMap, HeaderValue, CACHE_CONTROL, PRAGMA};

/// How long a provider call may take, connection included.
pub const PROVIDER_TIMEOUT: Duration = Duration::from_secs(8);
/// How long connecting may take.
pub const PROVIDER_CONNECT_TIMEOUT: Duration = Duration::from_secs(3);

/// The headers every provider request carries: a response must not be cached
/// on the way.
pub fn default_headers() -> HeaderMap {
    let mut h = HeaderMap::new();
    h.insert(CACHE_CONTROL, HeaderValue::from_static("no-store"));
    h.insert(PRAGMA, HeaderValue::from_static("no-cache"));
    h
}

/// A client with a short timeout, no redirects, no cookie jar, no connection
/// reuse across calls (nothing lingers that holds a token), and
/// `Cache-Control: no-store` on every request.
///
/// It never logs: `reqwest` only logs through `tracing` at debug and trace
/// level, and the control plane never enables that for it. A provider must
/// not log a body or a header either, and answers errors with a
/// [`crate::ProviderError`], never a message copied from the response.
pub fn client() -> reqwest::Result<reqwest::Client> {
    reqwest::Client::builder()
        .timeout(PROVIDER_TIMEOUT)
        .connect_timeout(PROVIDER_CONNECT_TIMEOUT)
        .redirect(reqwest::redirect::Policy::none())
        .default_headers(default_headers())
        .pool_max_idle_per_host(0)
        .build()
}

/// Whether a provider's `base_url` is acceptable: `https`, or `http` on
/// loopback (a provider on the same machine), with a host and no userinfo,
/// query or fragment.
pub fn check_base_url(raw: &str) -> Result<url::Url, String> {
    let u = url::Url::parse(raw).map_err(|_| "base_url is not a URL".to_string())?;
    if u.host().is_none() {
        return Err("base_url has no host".into());
    }
    if !u.username().is_empty() || u.password().is_some() {
        return Err("base_url must not carry credentials".into());
    }
    if u.query().is_some() || u.fragment().is_some() {
        return Err("base_url must not have a query or fragment".into());
    }
    match u.scheme() {
        "https" => Ok(u),
        "http" => {
            let loopback = match u.host() {
                Some(url::Host::Domain(d)) => d == "localhost",
                Some(url::Host::Ipv4(ip)) => ip.is_loopback(),
                Some(url::Host::Ipv6(ip)) => ip.is_loopback(),
                None => false,
            };
            if loopback {
                Ok(u)
            } else {
                Err("base_url must be https (http only on loopback)".into())
            }
        }
        _ => Err("base_url must be https (http only on loopback)".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_headers_forbid_caching() {
        let h = default_headers();
        assert_eq!(h[CACHE_CONTROL], "no-store");
        assert_eq!(h[PRAGMA], "no-cache");
    }

    #[test]
    fn the_client_builds_with_short_timeouts() {
        assert!(client().is_ok());
        assert!(PROVIDER_TIMEOUT <= Duration::from_secs(10));
    }

    #[test]
    fn base_urls_are_https_or_loopback() {
        assert!(check_base_url("https://vault.example.test/api/agent/v1").is_ok());
        assert!(check_base_url("http://127.0.0.1:3000").is_ok());
        assert!(check_base_url("http://localhost:3000/x").is_ok());
        assert!(check_base_url("http://vault.example.test").is_err());
        assert!(check_base_url("https://user:pw@vault.example.test").is_err());
        assert!(check_base_url("https://vault.example.test/?token=x").is_err());
        assert!(check_base_url("ftp://vault.example.test").is_err());
        assert!(check_base_url("nonsense").is_err());
    }

    #[tokio::test]
    async fn a_redirect_is_not_followed() {
        use std::io::{Read, Write};
        let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = l.local_addr().unwrap();
        std::thread::spawn(move || {
            if let Ok((mut s, _)) = l.accept() {
                let mut buf = [0u8; 2048];
                let n = s.read(&mut buf).unwrap_or(0);
                let req = String::from_utf8_lossy(&buf[..n]).to_ascii_lowercase();
                assert!(req.contains("cache-control: no-store"), "{req}");
                let _ = s.write_all(
                    b"HTTP/1.1 302 Found\r\nLocation: http://127.0.0.1:1/elsewhere\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                );
            }
        });
        let resp = client()
            .unwrap()
            .get(format!("http://{addr}/"))
            .send()
            .await
            .unwrap();
        assert_eq!(resp.status(), 302);
    }
}
