//! Real-display smoke test for the desktop driver (#369). Runs only when
//! `HEXACTRA_X11_SMOKE=1` and `DISPLAY` points at an X server with xdotool
//! and ImageMagick installed, e.g.:
//!
//! ```text
//! Xvfb :77 -screen 0 1280x800x24 & DISPLAY=:77 HEXACTRA_X11_SMOKE=1 \
//!   cargo test -p hexactra-desktop-input --test x11_smoke
//! ```

use std::time::Duration;

use base64::Engine;
use hexactra_core::remote::RemoteAction;
use hexactra_desktop_input::xdotool::execute;
use serde_json::json;

fn enabled() -> bool {
    std::env::var("HEXACTRA_X11_SMOKE").as_deref() == Ok("1")
        && std::env::var_os("DISPLAY").is_some()
}

async fn run(v: serde_json::Value) -> hexactra_core::remote::OperationResult {
    let a: RemoteAction = serde_json::from_value(v).unwrap();
    execute(&a, Duration::from_secs(10)).await
}

#[tokio::test]
async fn drives_a_real_display() {
    if !enabled() {
        eprintln!("skipped: set HEXACTRA_X11_SMOKE=1 with a DISPLAY");
        return;
    }
    let shot = run(json!({"type": "desktop_screenshot"})).await;
    assert!(shot.ok, "{:?}", shot.error);
    let r = shot.result.unwrap();
    assert_eq!(r["mime"], "image/jpeg");
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(r["data"].as_str().unwrap())
        .unwrap();
    assert_eq!(&bytes[..2], &[0xFF, 0xD8], "a JPEG");
    assert!(r["width"].as_u64().unwrap() > 0);

    for v in [
        json!({"type": "desktop_move", "x": 100, "y": 120}),
        json!({"type": "desktop_click", "x": 50, "y": 60, "click_count": 2}),
        json!({"type": "desktop_drag", "from_x": 10, "from_y": 10, "to_x": 200, "to_y": 150}),
        json!({"type": "desktop_scroll", "x": 300, "y": 300, "dy": 2}),
        json!({"type": "desktop_type", "text": "hello -- world"}),
        json!({"type": "desktop_key", "key": "ctrl+a BackSpace"}),
    ] {
        let r = run(v.clone()).await;
        assert!(r.ok, "{v}: {:?}", r.error);
    }
}
