//! A page's origin as a secrets provider binds to it.
//!
//! The same rules as Vault's agent credential guide: `scheme://host[:port]`,
//! host lower-cased (IDN as punycode), default port dropped, path, query,
//! fragment and userinfo dropped, `https` only except on loopback.
//!
//! An [`Origin`] is built **only** from a URL the browser reported
//! ([`Origin::from_browser_url`]), or from an origin a provider stores for
//! an item ([`Origin::from_stored`]). It has no `Deserialize` and no
//! `From<String>`: nothing a model or a page wrote can become one.

use std::fmt;

use hexactra_core::remote::MatchKind;
use url::{Host, Url};

/// Why a URL is not an origin a value may be bound to.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum OriginError {
    #[error("not a URL")]
    Invalid,
    #[error("scheme {0:?} is not https (http is only for localhost, 127.0.0.1 and [::1])")]
    Scheme(String),
    #[error("the URL has no host")]
    NoHost,
}

/// A normalised `scheme://host[:port]`.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct Origin {
    scheme: &'static str,
    /// Lower-case; IDN as punycode; IPv6 in brackets.
    host: String,
    /// `None` for the scheme's default port.
    port: Option<u16>,
    host_is_ip_or_local: bool,
}

fn is_loopback_host(h: &Host<&str>) -> bool {
    match h {
        Host::Domain(d) => *d == "localhost",
        Host::Ipv4(ip) => ip.octets() == [127, 0, 0, 1],
        Host::Ipv6(ip) => ip.is_loopback(),
    }
}

impl Origin {
    /// The origin of a URL the browser reported for a tab's top-level
    /// document. Anything but `https` (or `http` on loopback) is refused.
    pub fn from_browser_url(url: &str) -> Result<Origin, OriginError> {
        let u = Url::parse(url.trim()).map_err(|_| OriginError::Invalid)?;
        Self::from_url(&u)
    }

    /// The origin an item is stored for. A bare host (`app.example.test`)
    /// means `https://app.example.test`, as in Vault.
    pub fn from_stored(origin: &str) -> Result<Origin, OriginError> {
        let o = origin.trim();
        if o.is_empty() {
            return Err(OriginError::Invalid);
        }
        if o.contains("://") {
            Self::from_browser_url(o)
        } else {
            Self::from_browser_url(&format!("https://{o}"))
        }
    }

    fn from_url(u: &Url) -> Result<Origin, OriginError> {
        let host = u.host().ok_or(OriginError::NoHost)?;
        let scheme = match u.scheme() {
            "https" => "https",
            "http" if is_loopback_host(&host) => "http",
            other => return Err(OriginError::Scheme(other.to_string())),
        };
        let host_is_ip_or_local = !matches!(host, Host::Domain(_)) || is_loopback_host(&host);
        let host_str = match &host {
            Host::Domain(d) => d.to_ascii_lowercase(),
            Host::Ipv4(ip) => ip.to_string(),
            Host::Ipv6(ip) => format!("[{ip}]"),
        };
        if host_str.is_empty() {
            return Err(OriginError::NoHost);
        }
        Ok(Origin {
            scheme,
            host: host_str,
            // `url` already drops the default port of http and https.
            port: u.port(),
            host_is_ip_or_local,
        })
    }

    pub fn scheme(&self) -> &str {
        self.scheme
    }

    pub fn host(&self) -> &str {
        &self.host
    }

    /// The registrable domain (eTLD+1) of the host, when it has one: not
    /// for an IP literal, `localhost` or a bare public suffix.
    pub fn registrable_domain(&self) -> Option<&str> {
        if self.host_is_ip_or_local {
            return None;
        }
        psl::domain_str(&self.host)
    }

    /// Whether the two origins are the same `scheme://host[:port]`.
    pub fn matches_exact(&self, other: &Origin) -> bool {
        self == other
    }

    /// Whether the two origins share a registrable domain and a scheme
    /// (`login.example.test` and `app.example.test`). For information only:
    /// a site match is never fillable.
    pub fn matches_site(&self, other: &Origin) -> bool {
        self.scheme == other.scheme
            && match (self.registrable_domain(), other.registrable_domain()) {
                (Some(a), Some(b)) => a == b,
                _ => false,
            }
    }

    /// How a stored origin relates to this (the page's) origin.
    pub fn match_kind(&self, stored: &Origin) -> Option<MatchKind> {
        if self.matches_exact(stored) {
            Some(MatchKind::Exact)
        } else if self.matches_site(stored) {
            Some(MatchKind::Site)
        } else {
            None
        }
    }
}

impl fmt::Display for Origin {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}://{}", self.scheme, self.host)?;
        if let Some(p) = self.port {
            write!(f, ":{p}")?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn o(u: &str) -> Origin {
        Origin::from_browser_url(u).unwrap()
    }

    #[test]
    fn normalises_case_default_port_and_path() {
        assert_eq!(
            o("HTTPS://App.Example.TEST:443/a/b?c=d#e").to_string(),
            "https://app.example.test"
        );
        assert_eq!(
            o("https://user:pw@app.example.test/").to_string(),
            "https://app.example.test"
        );
        // A non-default port is part of the origin.
        assert_eq!(
            o("https://app.example.test:8443/").to_string(),
            "https://app.example.test:8443"
        );
        assert_ne!(
            o("https://app.example.test:8443"),
            o("https://app.example.test")
        );
    }

    #[test]
    fn https_only_except_loopback() {
        assert_eq!(
            Origin::from_browser_url("http://app.example.test/").unwrap_err(),
            OriginError::Scheme("http".into())
        );
        assert_eq!(
            o("http://localhost:3000/x").to_string(),
            "http://localhost:3000"
        );
        assert_eq!(o("http://127.0.0.1/").to_string(), "http://127.0.0.1");
        assert_eq!(o("http://[::1]:8080/").to_string(), "http://[::1]:8080");
        // Only the loopback addresses Vault names, not the rest of 127/8 or a LAN host.
        assert!(Origin::from_browser_url("http://192.168.1.5/").is_err());
        assert!(Origin::from_browser_url("http://localhost.example.test/").is_err());
        for bad in [
            "about:blank",
            "chrome://settings",
            "file:///etc/passwd",
            "data:text/html,x",
            "javascript:alert(1)",
            "ftp://example.test",
            "",
            "not a url",
            "https://",
        ] {
            assert!(Origin::from_browser_url(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn idn_hosts_are_punycode() {
        let a = o("https://bücher.example.test/");
        assert_eq!(a.to_string(), "https://xn--bcher-kva.example.test");
        assert_eq!(a, o("https://xn--bcher-kva.example.test"));
        assert_eq!(a, o("https://BÜCHER.example.test"));
    }

    #[test]
    fn look_alike_hosts_never_match() {
        let page = o("https://app.example.test");
        for other in [
            "https://app.example.test.evil.test",
            "https://app-example.test",
            "https://appexample.test",
            "https://evil.test/app.example.test",
            "https://app.example.test@evil.test",
        ] {
            let other = o(other);
            assert!(!page.matches_exact(&other), "{other}");
            assert!(!page.matches_site(&other), "{other}");
            assert_eq!(page.match_kind(&other), None, "{other}");
        }
        // A homograph label (Cyrillic "а" for the Latin one) on the same
        // registrable domain is a sibling: never exact, so never fillable.
        let homograph = o("https://аpp.example.test");
        assert_eq!(homograph.to_string(), "https://xn--pp-6kc.example.test");
        assert!(!page.matches_exact(&homograph));
        assert_eq!(page.match_kind(&homograph), Some(MatchKind::Site));
        // ... and one on another domain matches nothing at all.
        assert_eq!(page.match_kind(&o("https://аpp.exаmple.test")), None);
    }

    #[test]
    fn site_match_is_not_exact() {
        let page = o("https://login.example.test");
        let app = o("https://app.example.test");
        assert!(!page.matches_exact(&app));
        assert!(page.matches_site(&app));
        assert_eq!(page.match_kind(&app), Some(MatchKind::Site));
        assert_eq!(page.match_kind(&page.clone()), Some(MatchKind::Exact));
        // A different port or scheme is a different origin; a different
        // scheme is not even a site match.
        let other_port = o("https://login.example.test:8443");
        assert!(!page.matches_exact(&other_port));
        assert!(page.matches_site(&other_port));
        assert!(!o("http://localhost").matches_site(&o("https://localhost")));
    }

    #[test]
    fn registrable_domain_respects_the_public_suffix_list() {
        // `co.uk` is a public suffix: two sites under it are not the same site.
        assert!(!o("https://a.co.uk").matches_site(&o("https://b.co.uk")));
        assert!(o("https://www.shop.co.uk").matches_site(&o("https://pay.shop.co.uk")));
        assert_eq!(
            o("https://pay.shop.co.uk").registrable_domain(),
            Some("shop.co.uk")
        );
        // IP literals and localhost only ever match themselves.
        assert_eq!(o("http://127.0.0.1").registrable_domain(), None);
        assert!(!o("http://127.0.0.1:1").matches_site(&o("http://127.0.0.1:2")));
        assert!(!o("http://localhost:1").matches_site(&o("http://localhost:2")));
    }

    #[test]
    fn stored_origins_accept_a_bare_host() {
        assert_eq!(
            Origin::from_stored("App.Example.Test").unwrap(),
            o("https://app.example.test")
        );
        assert_eq!(
            Origin::from_stored("https://app.example.test/login").unwrap(),
            o("https://app.example.test")
        );
        assert!(Origin::from_stored("").is_err());
        assert!(Origin::from_stored("http://app.example.test").is_err());
    }
}
