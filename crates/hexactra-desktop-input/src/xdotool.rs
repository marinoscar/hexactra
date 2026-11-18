//! The node's OS desktop, driven like a person at the machine (epic #366).
//!
//! `desktop_*` remote actions reach whatever the browser extension cannot:
//! native file pickers and dialogs, permission prompts, other windows. The
//! host agent runs them itself against its own X11 display (`DISPLAY`):
//!
//! - pointer and keyboard with `xdotool`;
//! - the screen with ImageMagick `import -window root`, or `xwd` + `convert`.
//!
//! Commands are run directly with an argument vector, never through a shell,
//! so text and key names are never interpreted.

use std::process::Stdio;
use std::time::Duration;

use base64::Engine;
use hexactra_core::remote::{MouseButton, OperationResult, RemoteAction};
use serde_json::{json, Value};
use tokio::io::AsyncWriteExt;
use tokio::process::Command;

/// Packages that provide the tools, for error messages.
pub const XDOTOOL_PACKAGE: &str = "xdotool";
pub const SCREENSHOT_PACKAGE: &str = "imagemagick";

/// Steps of a drag (intermediate pointer moves).
const DRAG_STEPS: i64 = 12;
/// Delay between typed characters, in milliseconds (a fast typist).
const TYPE_DELAY_MS: &str = "12";

fn xbutton(b: MouseButton) -> &'static str {
    match b {
        MouseButton::Left => "1",
        MouseButton::Middle => "2",
        MouseButton::Right => "3",
    }
}

/// The `xdotool` arguments for a pointer or keyboard action, or `None` for
/// `desktop_screenshot` (and for actions that are not desktop actions).
pub fn xdotool_args(action: &RemoteAction) -> Option<Vec<String>> {
    let s = |v: &str| v.to_string();
    let n = |v: i64| v.to_string();
    Some(match action {
        RemoteAction::DesktopClick {
            x,
            y,
            button,
            click_count,
        } => vec![
            s("mousemove"),
            n(*x),
            n(*y),
            s("click"),
            s("--repeat"),
            click_count.unwrap_or(1).to_string(),
            s("--delay"),
            s("80"),
            s(xbutton(*button)),
        ],
        RemoteAction::DesktopMove { x, y } => vec![s("mousemove"), n(*x), n(*y)],
        RemoteAction::DesktopDrag {
            from_x,
            from_y,
            to_x,
            to_y,
        } => {
            let mut a = vec![
                s("mousemove"),
                n(*from_x),
                n(*from_y),
                s("mousedown"),
                s("1"),
            ];
            for i in 1..=DRAG_STEPS {
                a.extend([
                    s("sleep"),
                    s("0.02"),
                    s("mousemove"),
                    n(from_x + (to_x - from_x) * i / DRAG_STEPS),
                    n(from_y + (to_y - from_y) * i / DRAG_STEPS),
                ]);
            }
            a.extend([s("mouseup"), s("1")]);
            a
        }
        RemoteAction::DesktopType { text } => {
            vec![
                s("type"),
                s("--delay"),
                s(TYPE_DELAY_MS),
                s("--"),
                text.clone(),
            ]
        }
        RemoteAction::DesktopKey { key } => {
            // Several chords may be given separated by spaces ("ctrl+a BackSpace").
            let mut a = vec![s("key"), s("--clearmodifiers"), s("--")];
            a.extend(key.split_whitespace().map(str::to_string));
            a
        }
        RemoteAction::DesktopScroll { x, y, dy } => {
            let mut a = Vec::new();
            if let (Some(x), Some(y)) = (x, y) {
                a.extend([s("mousemove"), n(*x), n(*y)]);
            }
            // Wheel buttons: 4 scrolls up, 5 down.
            let button = if *dy < 0 { "4" } else { "5" };
            a.extend([
                s("click"),
                s("--repeat"),
                dy.unsigned_abs().max(1).to_string(),
                s("--delay"),
                s("30"),
                s(button),
            ]);
            a
        }
        _ => return None,
    })
}

async fn run(program: &str, args: &[String], timeout: Duration) -> Result<Vec<u8>, String> {
    let child = Command::new(program)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| spawn_error(program, &e))?;
    let out = tokio::time::timeout(timeout, child.wait_with_output())
        .await
        .map_err(|_| format!("{program} did not finish within {timeout:?}"))?
        .map_err(|e| format!("{program}: {e}"))?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        return Err(format!("{program} failed ({}): {}", out.status, err.trim()));
    }
    Ok(out.stdout)
}

fn spawn_error(program: &str, e: &std::io::Error) -> String {
    if e.kind() == std::io::ErrorKind::NotFound {
        let package = if program == "xdotool" {
            XDOTOOL_PACKAGE
        } else {
            SCREENSHOT_PACKAGE
        };
        format!("{program} is not installed on this node: install the {package} package (sudo apt install {package})")
    } else {
        format!("starting {program}: {e}")
    }
}

/// The screen size, from `xdotool getdisplaygeometry`.
async fn geometry(timeout: Duration) -> Option<(u32, u32)> {
    let out = run("xdotool", &["getdisplaygeometry".into()], timeout)
        .await
        .ok()?;
    parse_geometry(&String::from_utf8_lossy(&out))
}

/// Parse `"1920 1080"`.
pub fn parse_geometry(s: &str) -> Option<(u32, u32)> {
    let mut it = s.split_whitespace().map(str::parse::<u32>);
    match (it.next(), it.next()) {
        (Some(Ok(w)), Some(Ok(h))) => Some((w, h)),
        _ => None,
    }
}

/// A JPEG of the whole screen.
async fn capture(timeout: Duration) -> Result<Vec<u8>, String> {
    let import_args: Vec<String> = ["-window", "root", "-quality", "80", "jpeg:-"]
        .iter()
        .map(|s| s.to_string())
        .collect();
    match run("import", &import_args, timeout).await {
        Ok(bytes) if !bytes.is_empty() => return Ok(bytes),
        Ok(_) => {}
        Err(e) if !e.contains("not installed") => {
            tracing::debug!(error = %e, "import failed; trying xwd");
        }
        Err(_) => {}
    }
    // Fallback: xwd for the capture, convert for the encoding.
    let xwd = run("xwd", &["-root".into(), "-silent".into()], timeout)
        .await
        .map_err(|e| format!("cannot capture the screen: {e}"))?;
    let mut convert = Command::new("convert")
        .args(["xwd:-", "-quality", "80", "jpeg:-"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| spawn_error("convert", &e))?;
    let mut stdin = convert.stdin.take().expect("piped stdin");
    let writer = tokio::spawn(async move {
        let _ = stdin.write_all(&xwd).await;
    });
    let out = tokio::time::timeout(timeout, convert.wait_with_output())
        .await
        .map_err(|_| "convert did not finish in time".to_string())?
        .map_err(|e| format!("convert: {e}"))?;
    let _ = writer.await;
    if !out.status.success() || out.stdout.is_empty() {
        return Err(format!(
            "convert failed: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    Ok(out.stdout)
}

/// Run one `desktop_*` action on this machine's display.
pub async fn execute(action: &RemoteAction, timeout: Duration) -> OperationResult {
    let fail = |e: String| OperationResult {
        navigation_blocked: Vec::new(),
        ok: false,
        result: None,
        error: Some(e),
    };
    if let Err(e) = action.validate() {
        return fail(e.0);
    }
    if std::env::var_os("DISPLAY").is_none() {
        return fail("this node has no X11 display (DISPLAY is not set)".into());
    }
    let result: Result<Value, String> = match action {
        RemoteAction::DesktopScreenshot => match capture(timeout).await {
            Ok(bytes) => {
                let mut v = json!({
                    "mime": "image/jpeg",
                    "data": base64::engine::general_purpose::STANDARD.encode(bytes),
                });
                if let Some((w, h)) = geometry(timeout).await {
                    v["width"] = json!(w);
                    v["height"] = json!(h);
                }
                Ok(v)
            }
            Err(e) => Err(e),
        },
        other => match xdotool_args(other) {
            Some(args) => run("xdotool", &args, timeout).await.map(|_| json!({})),
            None => Err(format!("{} is not a desktop action", other.kind())),
        },
    };
    match result {
        Ok(v) => OperationResult {
            navigation_blocked: Vec::new(),
            ok: true,
            result: Some(v),
            error: None,
        },
        Err(e) => fail(e),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(v: Value) -> Vec<String> {
        let a: RemoteAction = serde_json::from_value(v).unwrap();
        xdotool_args(&a).unwrap()
    }

    #[test]
    fn click_moves_then_clicks() {
        assert_eq!(
            args(json!({"type": "desktop_click", "x": 10, "y": 20})),
            [
                "mousemove",
                "10",
                "20",
                "click",
                "--repeat",
                "1",
                "--delay",
                "80",
                "1"
            ]
        );
        assert_eq!(
            args(
                json!({"type": "desktop_click", "x": 1, "y": 2, "button": "right", "click_count": 2})
            )[5..],
            ["2", "--delay", "80", "3"]
        );
    }

    #[test]
    fn typing_is_a_single_argument_after_the_separator() {
        // Text starting with "-" or containing shell syntax is never parsed.
        assert_eq!(
            args(json!({"type": "desktop_type", "text": "--help; rm -rf ~"})),
            ["type", "--delay", "12", "--", "--help; rm -rf ~"]
        );
    }

    #[test]
    fn key_chords_are_split_on_spaces() {
        assert_eq!(
            args(json!({"type": "desktop_key", "key": "ctrl+a BackSpace"})),
            ["key", "--clearmodifiers", "--", "ctrl+a", "BackSpace"]
        );
    }

    #[test]
    fn drag_moves_in_steps() {
        let a = args(
            json!({"type": "desktop_drag", "from_x": 0, "from_y": 0, "to_x": 120, "to_y": 24}),
        );
        assert_eq!(&a[..5], ["mousemove", "0", "0", "mousedown", "1"]);
        assert_eq!(&a[a.len() - 2..], ["mouseup", "1"]);
        let moves: Vec<_> = a
            .windows(3)
            .filter(|w| w[0] == "mousemove")
            .map(|w| (w[1].clone(), w[2].clone()))
            .collect();
        assert_eq!(moves.len() as i64, DRAG_STEPS + 1);
        assert_eq!(
            moves.last().unwrap(),
            &("120".to_string(), "24".to_string())
        );
    }

    #[test]
    fn scroll_uses_wheel_buttons() {
        assert_eq!(
            args(json!({"type": "desktop_scroll", "dy": -3})),
            ["click", "--repeat", "3", "--delay", "30", "4"]
        );
        assert_eq!(
            args(json!({"type": "desktop_scroll", "x": 5, "y": 6, "dy": 2}))[..3],
            ["mousemove", "5", "6"]
        );
    }

    #[test]
    fn non_desktop_actions_have_no_plan() {
        assert!(xdotool_args(&RemoteAction::Tabs).is_none());
        assert!(xdotool_args(&RemoteAction::DesktopScreenshot).is_none());
    }

    #[test]
    fn geometry_parses() {
        assert_eq!(parse_geometry("1920 1080\n"), Some((1920, 1080)));
        assert_eq!(parse_geometry("nope"), None);
    }

    #[test]
    fn missing_tool_names_the_package() {
        let e = std::io::Error::from(std::io::ErrorKind::NotFound);
        assert!(spawn_error("xdotool", &e).contains("apt install xdotool"));
        assert!(spawn_error("import", &e).contains("imagemagick"));
    }

    #[tokio::test]
    async fn refuses_invalid_actions_before_running_anything() {
        let a = RemoteAction::DesktopKey { key: String::new() };
        let r = execute(&a, Duration::from_secs(1)).await;
        assert!(!r.ok);
    }
}
