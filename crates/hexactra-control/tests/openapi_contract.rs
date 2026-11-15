//! The committed `api/openapi.yaml` is the generated document, and the
//! document covers every `/v1` route the server mounts (#216).
//!
//! Regenerate with:
//! `cargo run -q -p hexactra-control -- openapi > api/openapi.yaml`

use std::collections::BTreeSet;
use std::path::PathBuf;

fn root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..")
}

#[test]
fn committed_spec_matches_the_code() {
    let committed = std::fs::read_to_string(root().join("api/openapi.yaml")).unwrap();
    let generated = hexactra_control::runtime::openapi::yaml();
    assert!(
        committed == generated,
        "api/openapi.yaml is stale; run: cargo run -q -p hexactra-control -- openapi > api/openapi.yaml"
    );
}

/// `(METHOD, path)` for every `.route("…", get(..).post(..))` in the runtime.
fn mounted_routes() -> BTreeSet<(String, String)> {
    let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("src/runtime");
    let mut out = BTreeSet::new();
    for entry in std::fs::read_dir(dir).unwrap() {
        let path = entry.unwrap().path();
        if path.extension().and_then(|e| e.to_str()) != Some("rs") {
            continue;
        }
        let src = std::fs::read_to_string(&path).unwrap();
        let mut rest = src.as_str();
        while let Some(i) = rest.find(".route(") {
            rest = &rest[i + ".route(".len()..];
            // The call's text up to its matching parenthesis.
            let mut depth = 1;
            let mut end = 0;
            for (j, c) in rest.char_indices() {
                match c {
                    '(' => depth += 1,
                    ')' => {
                        depth -= 1;
                        if depth == 0 {
                            end = j;
                            break;
                        }
                    }
                    _ => {}
                }
            }
            let call = &rest[..end];
            let Some(q1) = call.find('"') else { continue };
            let q2 = q1 + 1 + call[q1 + 1..].find('"').unwrap();
            let route = &call[q1 + 1..q2];
            for m in ["get", "post", "put", "patch", "delete"] {
                let needle = format!("{m}(");
                let mut s = &call[q2..];
                while let Some(k) = s.find(&needle) {
                    let before = s[..k].chars().last();
                    if !matches!(before, Some(c) if c.is_alphanumeric() || c == '_') {
                        out.insert((m.to_uppercase(), route.to_string()));
                        break;
                    }
                    s = &s[k + needle.len()..];
                }
            }
        }
    }
    out
}

#[test]
fn every_mounted_route_is_documented_and_nothing_else() {
    let doc: serde_yaml::Value =
        serde_yaml::from_str(&hexactra_control::runtime::openapi::yaml()).unwrap();
    let mut documented = BTreeSet::new();
    for (path, item) in doc["paths"].as_mapping().unwrap() {
        for (method, _) in item.as_mapping().unwrap() {
            let m = method.as_str().unwrap();
            if ["get", "post", "put", "patch", "delete"].contains(&m) {
                documented.insert((m.to_uppercase(), path.as_str().unwrap().to_string()));
            }
        }
    }
    let mounted = mounted_routes();
    assert!(
        mounted.len() > 30,
        "route scan found too few routes: {mounted:?}"
    );
    let missing: Vec<_> = mounted.difference(&documented).collect();
    let extra: Vec<_> = documented.difference(&mounted).collect();
    assert!(
        missing.is_empty(),
        "routes missing from the OpenAPI document: {missing:?}"
    );
    assert!(
        extra.is_empty(),
        "documented routes that are not mounted: {extra:?}"
    );
}
