//! A session's allowed sites (#508).
//!
//! A session opened with `allowed_domains` may only load top-level pages on
//! those sites. The browser extension enforces the list for every top-level
//! navigation, including the ones a page starts by itself (redirects,
//! scripts, `window.open`), and reports each blocked one. Subresources are
//! not blocked.
//!
//! Matching: a host is allowed when it equals a listed domain or is a
//! subdomain of one, case-insensitively. An IP literal is allowed only when
//! it is listed itself. An empty list allows every site.
//!
//! The extension carries the same rules in TypeScript
//! (`apps/chrome-extension/src/site-policy.ts`); both are tested against the
//! same cases.

use std::net::IpAddr;

/// Most domains one session may list.
pub const MAX_ALLOWED_DOMAINS: usize = 100;

/// Normalizes one listed domain: lowercased, without a trailing dot, a
/// scheme, a path or a port. Rejects anything that is not a plain host name
/// or IP literal, and wildcards (`*.example.com` is written `example.com`,
/// which already covers its subdomains).
pub fn normalize_allowed_domain(raw: &str) -> Result<String, String> {
    let mut s = raw.trim().to_ascii_lowercase();
    for scheme in ["https://", "http://"] {
        if let Some(rest) = s.strip_prefix(scheme) {
            s = rest.to_string();
        }
    }
    if let Some(i) = s.find('/') {
        s.truncate(i);
    }
    // IPv6 literal in brackets, optionally with a port.
    if let Some(rest) = s.strip_prefix('[') {
        let Some(end) = rest.find(']') else {
            return Err(format!("{raw:?} is not a valid domain"));
        };
        let ip = &rest[..end];
        return match ip.parse::<IpAddr>() {
            Ok(IpAddr::V6(v6)) => Ok(v6.to_string()),
            _ => Err(format!("{raw:?} is not a valid domain")),
        };
    }
    if s.parse::<IpAddr>().is_ok() {
        return Ok(s);
    }
    if let Some((host, port)) = s.rsplit_once(':') {
        if !port.is_empty() && port.chars().all(|c| c.is_ascii_digit()) {
            s = host.to_string();
        }
    }
    let s = s.trim_end_matches('.').to_string();
    let valid_label = |l: &str| {
        !l.is_empty()
            && l.len() <= 63
            && !l.starts_with('-')
            && !l.ends_with('-')
            && l.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
    };
    if s.is_empty() || s.len() > 253 || !s.split('.').all(valid_label) {
        return Err(format!(
            "{raw:?} is not a valid domain (write example.com; it covers its subdomains)"
        ));
    }
    Ok(s)
}

/// Normalizes a whole list, dropping duplicates and keeping the order.
pub fn normalize_allowed_domains(raw: &[String]) -> Result<Vec<String>, String> {
    if raw.len() > MAX_ALLOWED_DOMAINS {
        return Err(format!(
            "at most {MAX_ALLOWED_DOMAINS} allowed domains per session"
        ));
    }
    let mut out: Vec<String> = Vec::with_capacity(raw.len());
    for d in raw {
        let n = normalize_allowed_domain(d)?;
        if !out.contains(&n) {
            out.push(n);
        }
    }
    Ok(out)
}

/// The host of a URL, lowercased, without brackets or a port. `None` for
/// URLs without a host (`about:blank`, `data:`).
pub fn url_host(url: &str) -> Option<String> {
    let rest = url.split_once("://")?.1;
    let authority = rest.split(['/', '?', '#']).next()?;
    let authority = authority.rsplit_once('@').map_or(authority, |(_, h)| h);
    if let Some(v6) = authority.strip_prefix('[') {
        return v6.split_once(']').map(|(h, _)| h.to_ascii_lowercase());
    }
    let host = authority.split(':').next()?;
    if host.is_empty() {
        None
    } else {
        Some(host.trim_end_matches('.').to_ascii_lowercase())
    }
}

/// Whether `host` may be loaded under `allowed` (normalized entries).
pub fn host_allowed(host: &str, allowed: &[String]) -> bool {
    if allowed.is_empty() {
        return true;
    }
    let host = host
        .trim()
        .trim_start_matches('[')
        .trim_end_matches(']')
        .trim_end_matches('.')
        .to_ascii_lowercase();
    if host.is_empty() {
        return false;
    }
    if let Ok(ip) = host.parse::<IpAddr>() {
        return allowed
            .iter()
            .any(|d| d.parse::<IpAddr>().is_ok_and(|a| a == ip));
    }
    allowed.iter().any(|d| {
        d.parse::<IpAddr>().is_err()
            && (host == *d
                || (host.len() > d.len()
                    && host.ends_with(d.as_str())
                    && host.as_bytes()[host.len() - d.len() - 1] == b'.'))
    })
}

/// Whether a top-level navigation to `url` is allowed. URLs without a host
/// (`about:blank`) are always allowed; other non-`http(s)` schemes follow
/// their host when they have one.
pub fn url_allowed(url: &str, allowed: &[String]) -> bool {
    if allowed.is_empty() {
        return true;
    }
    match url_host(url) {
        Some(h) => host_allowed(&h, allowed),
        None => true,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn list(v: &[&str]) -> Vec<String> {
        normalize_allowed_domains(&v.iter().map(|s| s.to_string()).collect::<Vec<_>>()).unwrap()
    }

    #[test]
    fn normalizes_entries() {
        assert_eq!(
            normalize_allowed_domain("Example.COM").unwrap(),
            "example.com"
        );
        assert_eq!(
            normalize_allowed_domain("https://example.com/a/b").unwrap(),
            "example.com"
        );
        assert_eq!(
            normalize_allowed_domain("example.com:8443").unwrap(),
            "example.com"
        );
        assert_eq!(
            normalize_allowed_domain("example.com.").unwrap(),
            "example.com"
        );
        assert_eq!(normalize_allowed_domain("10.0.0.5").unwrap(), "10.0.0.5");
        assert_eq!(normalize_allowed_domain("[::1]:80").unwrap(), "::1");
        assert!(normalize_allowed_domain("*.example.com").is_err());
        assert!(normalize_allowed_domain("").is_err());
        assert!(normalize_allowed_domain("exa mple.com").is_err());
        assert!(normalize_allowed_domain("-bad.com").is_err());
        assert_eq!(list(&["a.com", "A.com", "b.com"]), vec!["a.com", "b.com"]);
        let many: Vec<String> = (0..=MAX_ALLOWED_DOMAINS)
            .map(|i| format!("d{i}.com"))
            .collect();
        assert!(normalize_allowed_domains(&many).is_err());
    }

    #[test]
    fn exact_and_subdomains_match() {
        let a = list(&["example.com"]);
        assert!(host_allowed("example.com", &a));
        assert!(host_allowed("WWW.Example.com", &a));
        assert!(host_allowed("a.b.example.com", &a));
        assert!(!host_allowed("badexample.com", &a));
        assert!(!host_allowed("example.com.evil.net", &a));
        assert!(!host_allowed("evil.net", &a));
        assert!(!host_allowed("com", &a));
    }

    #[test]
    fn ip_literals_only_when_listed() {
        let a = list(&["example.com"]);
        assert!(!host_allowed("93.184.216.34", &a));
        assert!(!host_allowed("[::1]", &a));
        let b = list(&["127.0.0.1", "::1"]);
        assert!(host_allowed("127.0.0.1", &b));
        assert!(host_allowed("[::1]", &b));
        assert!(!host_allowed("127.0.0.2", &b));
        // An IP entry never matches a name as a suffix.
        assert!(!host_allowed("x.127.0.0.1", &b));
    }

    #[test]
    fn empty_list_allows_everything() {
        assert!(host_allowed("anything.test", &[]));
        assert!(url_allowed("https://anything.test/", &[]));
    }

    #[test]
    fn urls() {
        let a = list(&["example.com"]);
        assert_eq!(
            url_host("https://user@Sub.Example.com:8080/p?q#f").as_deref(),
            Some("sub.example.com")
        );
        assert_eq!(url_host("http://[::1]:3000/").as_deref(), Some("::1"));
        assert_eq!(url_host("about:blank"), None);
        assert!(url_allowed("https://www.example.com/x", &a));
        assert!(!url_allowed("https://evil.test/", &a));
        assert!(url_allowed("about:blank", &a));
    }
}
