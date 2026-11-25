//! Per-profile Google sign-in status (E48, #928;
//! `docs/decisions/profile-signin-health.md`).
//!
//! Two checks feed one status per profile:
//!
//! - **Offline** ([`offline_signin`]): the agent reads the profile's
//!   `Default/Preferences` file, read-only. It runs at agent start, after
//!   every browser close (close, restart, crash, idle stop) and on profile
//!   creation. It cannot see `expired`.
//! - **Live** ([`parse_live_frame`]): while the profile's browser runs, the
//!   extension asks Google which accounts the cookie jar holds and sends only
//!   `{ signin, accounts: [{ provider, email, state }] }` over native
//!   messaging. The agent asks it to check again every
//!   [`LIVE_CHECK_INTERVAL`].
//!
//! [`SigninTracker`] combines them: the live result wins while the browser
//! runs, the offline result is used when it is stopped (an account the live
//! check last saw `expired` stays `expired`), and a failure or a
//! disagreement is `unknown`, never `signed_out`.
//!
//! Privacy: an account email is display data for the owner. It is never put
//! in a log line or a span here; [`ProfileAccount`]'s `Debug` redacts it.

use std::collections::{HashMap, HashSet};
use std::io::Read;
use std::path::Path;
use std::sync::Mutex;
use std::time::Duration;

use chrono::{DateTime, Utc};
use hexactra_core::remote::{
    ProfileAccount, ProfileSignin, ProfileStatusReport, SigninState, DEFAULT_PROFILE,
};
use serde_json::Value;
use tokio::sync::Notify;
use tokio::time::Instant;

/// The identity provider the checks cover.
pub const GOOGLE: &str = "google";

/// How often the agent asks a running browser's extension to check again.
pub const LIVE_CHECK_INTERVAL: Duration = Duration::from_secs(10 * 60);

/// Most accounts kept per profile (Google allows ten in one cookie jar).
const MAX_ACCOUNTS: usize = 10;
/// Longest email kept (RFC 5321 limit).
const MAX_EMAIL: usize = 320;
/// Largest `Preferences` file read; a bigger one is `unknown`.
const MAX_PREFERENCES: u64 = 32 << 20;

/// One check's result.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SigninCheck {
    pub signin: SigninState,
    pub accounts: Vec<ProfileAccount>,
    pub checked_at: DateTime<Utc>,
}

impl SigninCheck {
    pub fn unknown() -> Self {
        Self::new(SigninState::Unknown, Vec::new())
    }

    fn new(signin: SigninState, accounts: Vec<ProfileAccount>) -> Self {
        Self {
            signin,
            accounts,
            checked_at: Utc::now(),
        }
    }

    /// Same status, whenever it was checked.
    fn same_status(&self, other: &Self) -> bool {
        self.signin == other.signin && self.accounts == other.accounts
    }
}

fn account(email: &str, state: SigninState) -> ProfileAccount {
    ProfileAccount {
        provider: GOOGLE.to_string(),
        email: email.to_string(),
        state,
    }
}

/// A plausible email: non-empty, bounded, one `@`, no control characters.
fn usable_email(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= MAX_EMAIL
        && s.contains('@')
        && !s.chars().any(|c| c.is_control() || c.is_whitespace())
}

/// The overall state from the accounts: any `signed_in` account makes the
/// profile signed in, else any `expired` makes it expired.
fn overall(accounts: &[ProfileAccount]) -> SigninState {
    if accounts.iter().any(|a| a.state == SigninState::SignedIn) {
        SigninState::SignedIn
    } else if accounts.iter().any(|a| a.state == SigninState::Expired) {
        SigninState::Expired
    } else {
        SigninState::SignedOut
    }
}

/// The offline check on the bytes of a profile's `Default/Preferences`.
///
/// - `account_info` with at least one email: `signed_in` (those accounts).
/// - No account in `account_info` and an empty
///   `gaia_cookie.last_list_accounts_binary_data` (Chrome saw no Google web
///   session at its last check): `signed_out`.
/// - No account but a non-empty cached list (they disagree), no
///   `gaia_cookie` at all, or a file that is not a JSON object (truncated,
///   corrupt, half written): `unknown`.
pub fn offline_signin(prefs: &[u8]) -> SigninCheck {
    let Ok(Value::Object(prefs)) = serde_json::from_slice::<Value>(prefs) else {
        return SigninCheck::unknown();
    };
    let mut emails: Vec<&str> = Vec::new();
    if let Some(Value::Array(list)) = prefs.get("account_info") {
        for a in list {
            if let Some(e) = a.get("email").and_then(Value::as_str) {
                if usable_email(e) && !emails.contains(&e) && emails.len() < MAX_ACCOUNTS {
                    emails.push(e);
                }
            }
        }
    }
    if !emails.is_empty() {
        let accounts = emails
            .into_iter()
            .map(|e| account(e, SigninState::SignedIn))
            .collect();
        return SigninCheck::new(SigninState::SignedIn, accounts);
    }
    let cookie = prefs.get("gaia_cookie");
    // Chrome 158 caches the list as a base64 protobuf; older versions as
    // JSON text. Only emptiness is read: the layout is not an interface.
    let cached = cookie
        .and_then(|c| c.get("last_list_accounts_binary_data"))
        .or_else(|| cookie.and_then(|c| c.get("last_list_accounts_data")));
    match cached {
        Some(Value::String(s)) if s.is_empty() => {
            SigninCheck::new(SigninState::SignedOut, Vec::new())
        }
        _ => SigninCheck::unknown(),
    }
}

/// [`offline_signin`] for the profile at `profile_dir` (its
/// `--user-data-dir`). A missing file (the browser never ran), an
/// unreadable or oversized one is `unknown`. The file is only read.
pub fn offline_signin_dir(profile_dir: &Path) -> SigninCheck {
    let path = profile_dir.join("Default").join("Preferences");
    let mut buf = Vec::new();
    let read =
        std::fs::File::open(&path).and_then(|f| f.take(MAX_PREFERENCES + 1).read_to_end(&mut buf));
    match read {
        Ok(n) if (n as u64) <= MAX_PREFERENCES => offline_signin(&buf),
        _ => SigninCheck::unknown(),
    }
}

/// The live check's frame from the extension:
/// `{"type":"profile_status","signin":…,"accounts":[{"provider","email","state"}]}`.
///
/// Returns `None` when the frame is not a status frame. A status frame whose
/// content does not hold together (an unknown state, `signed_in` with no
/// usable account, …) is `unknown`. Parse errors are never logged: their
/// text can quote the email.
pub fn parse_live_frame(frame: &[u8]) -> Option<SigninCheck> {
    let v: Value = serde_json::from_slice(frame).ok()?;
    if v.get("type").and_then(Value::as_str) != Some("profile_status") {
        return None;
    }
    Some(parse_live(&v).unwrap_or_else(SigninCheck::unknown))
}

fn parse_state(v: &Value) -> Option<SigninState> {
    serde_json::from_value(v.clone()).ok()
}

fn parse_live(v: &Value) -> Option<SigninCheck> {
    let signin = parse_state(v.get("signin")?)?;
    let mut accounts: Vec<ProfileAccount> = Vec::new();
    if let Some(list) = v.get("accounts") {
        for a in list.as_array()? {
            if a.get("provider").and_then(Value::as_str) != Some(GOOGLE) {
                continue;
            }
            let email = a.get("email").and_then(Value::as_str)?;
            let state = parse_state(a.get("state")?)?;
            if !usable_email(email) {
                return None;
            }
            if !matches!(state, SigninState::SignedIn | SigninState::Expired) {
                continue;
            }
            if accounts.len() < MAX_ACCOUNTS && !accounts.iter().any(|x| x.email == email) {
                accounts.push(account(email, state));
            }
        }
    }
    match signin {
        SigninState::Unknown => Some(SigninCheck::unknown()),
        SigninState::SignedOut => {
            // "Signed out" with a signed-in account disagrees with itself.
            accounts
                .is_empty()
                .then(|| SigninCheck::new(SigninState::SignedOut, Vec::new()))
        }
        SigninState::SignedIn | SigninState::Expired => {
            if accounts.is_empty() || overall(&accounts) != signin {
                return None;
            }
            Some(SigninCheck::new(signin, accounts))
        }
    }
}

#[derive(Default)]
struct Entry {
    offline: Option<SigninCheck>,
    live: Option<SigninCheck>,
    /// The live result is from the browser's current run.
    live_current: bool,
}

/// Combine one profile's checks (decision record, "Combining").
fn combine(e: &Entry, running: bool) -> SigninCheck {
    if running && e.live_current {
        if let Some(live) = &e.live {
            return live.clone();
        }
    }
    let mut base = e.offline.clone().unwrap_or_else(SigninCheck::unknown);
    // Chrome cannot repair a session while stopped: an account the live
    // check last saw expired stays expired while the offline check lists it.
    if let Some(live) = &e.live {
        let expired: HashSet<&str> = live
            .accounts
            .iter()
            .filter(|a| a.state == SigninState::Expired)
            .map(|a| a.email.as_str())
            .collect();
        if base.signin == SigninState::SignedIn && !expired.is_empty() {
            for a in base.accounts.iter_mut() {
                if expired.contains(a.email.as_str()) {
                    a.state = SigninState::Expired;
                }
            }
            base.signin = overall(&base.accounts);
        }
    }
    base
}

/// What the caller must do after [`SigninTracker::observe`].
#[derive(Debug, Default, PartialEq, Eq)]
pub struct SigninWork {
    /// Run the offline check on these profiles (never checked, or their
    /// browser just stopped).
    pub offline: Vec<String>,
    /// Ask these running browsers' extensions to check now.
    pub live: Vec<String>,
}

#[derive(Default)]
struct State {
    entries: HashMap<String, Entry>,
    running: HashSet<String>,
    asked: HashMap<String, Instant>,
}

/// Every profile's checks, and the combined status to report.
#[derive(Default)]
pub struct SigninTracker {
    state: Mutex<State>,
    changed: Notify,
}

impl SigninTracker {
    pub fn new() -> Self {
        Self::default()
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Wait until a check changes a profile's status.
    pub async fn changed(&self) {
        self.changed.notified().await
    }

    /// Store an offline check's result.
    pub fn set_offline(&self, name: &str, check: SigninCheck) {
        let changed = {
            let mut s = self.lock();
            let e = s.entries.entry(name.to_string()).or_default();
            let changed = !e.offline.as_ref().is_some_and(|o| o.same_status(&check));
            e.offline = Some(check);
            changed
        };
        if changed {
            self.changed.notify_one();
        }
    }

    /// Run the offline check on `profile_dir` for `name`.
    pub fn refresh_offline(&self, name: &str, profile_dir: &Path) {
        self.set_offline(name, offline_signin_dir(profile_dir));
    }

    /// Store a live check's result (the browser is running).
    pub fn set_live(&self, name: &str, check: SigninCheck) {
        let changed = {
            let mut s = self.lock();
            let e = s.entries.entry(name.to_string()).or_default();
            let changed =
                !e.live_current || !e.live.as_ref().is_some_and(|l| l.same_status(&check));
            e.live = Some(check);
            e.live_current = true;
            changed
        };
        tracing::debug!(profile = name, "live sign-in check received");
        if changed {
            self.changed.notify_one();
        }
    }

    /// The profile's browser stopped: its live result no longer wins.
    pub fn browser_stopped(&self, name: &str) {
        let mut s = self.lock();
        if let Some(e) = s.entries.get_mut(name) {
            e.live_current = false;
        }
        s.running.remove(name);
        s.asked.remove(name);
    }

    /// Forget a deleted profile.
    pub fn remove(&self, name: &str) {
        let mut s = self.lock();
        s.entries.remove(name);
        s.running.remove(name);
        s.asked.remove(name);
    }

    /// Note which profiles exist and run, and say which checks are due:
    /// the offline check for a profile never checked or whose browser has
    /// stopped since the last call (a crash or an idle stop included), and
    /// the live check for a running browser not asked within
    /// [`LIVE_CHECK_INTERVAL`]. Call [`Self::asked`] once a live request
    /// was sent.
    pub fn observe(&self, profiles: &[String], running: &[String], now: Instant) -> SigninWork {
        let mut work = SigninWork::default();
        let mut s = self.lock();
        let now_running: HashSet<String> = running.iter().cloned().collect();
        let stopped: Vec<String> = s.running.difference(&now_running).cloned().collect();
        for name in &stopped {
            if let Some(e) = s.entries.get_mut(name) {
                e.live_current = false;
            }
            s.asked.remove(name);
            work.offline.push(name.clone());
        }
        for name in profiles {
            if !s.entries.contains_key(name) && !work.offline.contains(name) {
                work.offline.push(name.clone());
            }
        }
        for name in running {
            let due = s
                .asked
                .get(name)
                .is_none_or(|at| now.saturating_duration_since(*at) >= LIVE_CHECK_INTERVAL);
            if due {
                work.live.push(name.clone());
            }
        }
        s.running = now_running;
        work.offline.sort();
        work.live.sort();
        work
    }

    /// A live check request reached `name`'s extension.
    pub fn asked(&self, name: &str, now: Instant) {
        self.lock().asked.insert(name.to_string(), now);
    }

    /// One profile's combined status.
    pub fn status(&self, name: &str, running: bool) -> SigninCheck {
        let s = self.lock();
        match s.entries.get(name) {
            Some(e) => combine(e, running),
            None => SigninCheck::unknown(),
        }
    }

    /// The report for `profiles`, in their order.
    pub fn report(&self, profiles: &[String], running: &[String]) -> ProfileStatusReport {
        let s = self.lock();
        ProfileStatusReport {
            profiles: profiles
                .iter()
                .map(|name| {
                    let e = s.entries.get(name);
                    let c = e
                        .map(|e| combine(e, running.contains(name)))
                        .unwrap_or_else(SigninCheck::unknown);
                    ProfileSignin {
                        name: name.clone(),
                        signin: c.signin,
                        accounts: c.accounts,
                        // A profile never checked has no check time.
                        checked_at: e.map(|_| c.checked_at),
                    }
                })
                .collect(),
        }
    }
}

/// Profile names under `profiles_dir` (plus `default`, which always exists
/// logically), sorted.
pub fn list_profiles(profiles_dir: &Path) -> Vec<String> {
    let mut v: Vec<String> = std::fs::read_dir(profiles_dir)
        .map(|rd| {
            rd.filter_map(|e| e.ok())
                .filter(|e| e.file_type().map(|t| t.is_dir()).unwrap_or(false))
                .filter_map(|e| e.file_name().into_string().ok())
                .filter(|n| hexactra_core::remote::valid_profile_name(n))
                .collect()
        })
        .unwrap_or_default();
    if !v.iter().any(|p| p == DEFAULT_PROFILE) {
        v.push(DEFAULT_PROFILE.to_string());
    }
    v.sort();
    v
}

/// `hexactra-agent doctor`'s sign-in lines: one per profile, from the
/// offline check. Shown on the owner's own terminal, so the email is
/// printed in full here (and nowhere in the logs).
pub fn doctor_lines(profiles_dir: &Path) -> Vec<String> {
    list_profiles(profiles_dir)
        .into_iter()
        .map(|name| {
            let c = offline_signin_dir(&profiles_dir.join(&name));
            doctor_line(&name, &c)
        })
        .collect()
}

fn doctor_line(name: &str, c: &SigninCheck) -> String {
    let ok = if c.signin.needs_signin() {
        "warn"
    } else {
        "ok  "
    };
    let detail = match c.signin {
        SigninState::SignedIn => {
            let emails: Vec<&str> = c.accounts.iter().map(|a| a.email.as_str()).collect();
            format!("signed in to Google as {}", emails.join(", "))
        }
        SigninState::SignedOut => {
            "signed out of Google: sign in from the Fleet page or the node's desktop".to_string()
        }
        SigninState::Expired => {
            "Google needs you to sign in again: use the Fleet page or the node's desktop"
                .to_string()
        }
        SigninState::Unknown => {
            "sign-in status unknown (the browser has not run yet, or its settings could not be read)"
                .to_string()
        }
    };
    format!("{ok} profile {name}: {} ({detail})", c.signin.as_str())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture(name: &str) -> Vec<u8> {
        let path = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("tests/fixtures/preferences")
            .join(name);
        std::fs::read(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()))
    }

    fn emails(c: &SigninCheck) -> Vec<(&str, SigninState)> {
        c.accounts
            .iter()
            .map(|a| (a.email.as_str(), a.state))
            .collect()
    }

    #[test]
    fn a_fresh_profile_is_signed_out() {
        let c = offline_signin(&fixture("signed-out.json"));
        assert_eq!(c.signin, SigninState::SignedOut);
        assert!(c.accounts.is_empty());
    }

    #[test]
    fn account_info_with_an_email_is_signed_in() {
        let c = offline_signin(&fixture("signed-in.json"));
        assert_eq!(c.signin, SigninState::SignedIn);
        assert_eq!(
            emails(&c),
            vec![("owner@example.com", SigninState::SignedIn)]
        );
        assert!(c.accounts.iter().all(|a| a.provider == "google"));
    }

    #[test]
    fn two_accounts_are_both_listed() {
        let c = offline_signin(&fixture("two-accounts.json"));
        assert_eq!(c.signin, SigninState::SignedIn);
        assert_eq!(
            emails(&c),
            vec![
                ("owner@example.com", SigninState::SignedIn),
                ("work@example.org", SigninState::SignedIn)
            ]
        );
    }

    #[test]
    fn a_cached_list_without_account_info_is_unknown() {
        let c = offline_signin(&fixture("cached-list-no-account-info.json"));
        assert_eq!(c.signin, SigninState::Unknown);
    }

    #[test]
    fn truncated_or_corrupt_preferences_are_unknown() {
        let full = fixture("signed-in.json");
        for bytes in [
            &full[..full.len() / 2],
            b"\x00\x01garbage".as_slice(),
            b"",
            b"[]",
            b"null",
        ] {
            assert_eq!(offline_signin(bytes).signin, SigninState::Unknown);
        }
        // No gaia_cookie at all: nothing to go on.
        assert_eq!(
            offline_signin(br#"{"signin":{"allowed":true}}"#).signin,
            SigninState::Unknown
        );
    }

    #[test]
    fn a_missing_file_is_unknown_and_a_real_one_is_read() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(
            offline_signin_dir(&dir.path().join("never-launched")).signin,
            SigninState::Unknown
        );
        let profile = dir.path().join("work");
        std::fs::create_dir_all(profile.join("Default")).unwrap();
        std::fs::write(
            profile.join("Default/Preferences"),
            fixture("signed-out.json"),
        )
        .unwrap();
        assert_eq!(offline_signin_dir(&profile).signin, SigninState::SignedOut);
    }

    fn live(json: &str) -> SigninCheck {
        parse_live_frame(json.as_bytes()).expect("a status frame")
    }

    #[test]
    fn live_frames_are_parsed_and_checked() {
        assert!(parse_live_frame(br#"{"type":"pong"}"#).is_none());
        assert!(parse_live_frame(b"not json").is_none());
        let c = live(
            r#"{"type":"profile_status","signin":"signed_in","accounts":[{"provider":"google","email":"a@example.com","state":"signed_in"}]}"#,
        );
        assert_eq!(c.signin, SigninState::SignedIn);
        assert_eq!(emails(&c), vec![("a@example.com", SigninState::SignedIn)]);
        let c = live(r#"{"type":"profile_status","signin":"signed_out","accounts":[]}"#);
        assert_eq!(c.signin, SigninState::SignedOut);
        let c = live(
            r#"{"type":"profile_status","signin":"expired","accounts":[{"provider":"google","email":"a@example.com","state":"expired"}]}"#,
        );
        assert_eq!(c.signin, SigninState::Expired);
        // Content that does not hold together is unknown, never signed out.
        for bad in [
            r#"{"type":"profile_status","signin":"signed_in","accounts":[]}"#,
            r#"{"type":"profile_status","signin":"signed_out","accounts":[{"provider":"google","email":"a@example.com","state":"signed_in"}]}"#,
            r#"{"type":"profile_status","signin":"maybe"}"#,
            r#"{"type":"profile_status"}"#,
            r#"{"type":"profile_status","signin":"signed_in","accounts":[{"provider":"google","email":"no at sign","state":"signed_in"}]}"#,
        ] {
            assert_eq!(live(bad).signin, SigninState::Unknown, "{bad}");
        }
    }

    fn names(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    fn signed_in(emails: &[(&str, SigninState)]) -> SigninCheck {
        let accounts: Vec<_> = emails.iter().map(|(e, s)| account(e, *s)).collect();
        SigninCheck::new(overall(&accounts), accounts)
    }

    #[test]
    fn live_wins_while_running_and_offline_when_stopped() {
        let t = SigninTracker::new();
        t.set_offline(
            "default",
            signed_in(&[("a@example.com", SigninState::SignedIn)]),
        );
        assert_eq!(t.status("default", false).signin, SigninState::SignedIn);
        t.set_live(
            "default",
            SigninCheck::new(SigninState::SignedOut, Vec::new()),
        );
        assert_eq!(t.status("default", true).signin, SigninState::SignedOut);
        // Stopped: the offline check (refreshed after the close) is used.
        t.browser_stopped("default");
        t.set_offline(
            "default",
            SigninCheck::new(SigninState::SignedOut, Vec::new()),
        );
        assert_eq!(t.status("default", false).signin, SigninState::SignedOut);
        // A live failure is unknown, not signed out.
        t.set_live("default", SigninCheck::unknown());
        assert_eq!(t.status("default", true).signin, SigninState::Unknown);
    }

    #[test]
    fn a_live_expired_account_stays_expired_while_stopped() {
        let t = SigninTracker::new();
        t.set_live(
            "default",
            signed_in(&[
                ("a@example.com", SigninState::Expired),
                ("b@example.com", SigninState::SignedIn),
            ]),
        );
        t.browser_stopped("default");
        // Offline still lists both: a stays expired, b stays signed in.
        t.set_offline(
            "default",
            signed_in(&[
                ("a@example.com", SigninState::SignedIn),
                ("b@example.com", SigninState::SignedIn),
            ]),
        );
        let c = t.status("default", false);
        assert_eq!(c.signin, SigninState::SignedIn);
        assert_eq!(
            emails(&c),
            vec![
                ("a@example.com", SigninState::Expired),
                ("b@example.com", SigninState::SignedIn)
            ]
        );
        // Only the expired account: the profile is expired.
        t.set_offline(
            "default",
            signed_in(&[("a@example.com", SigninState::SignedIn)]),
        );
        assert_eq!(t.status("default", false).signin, SigninState::Expired);
        // A restarted browser has no live result yet: offline plus the carry-over.
        assert_eq!(t.status("default", true).signin, SigninState::Expired);
    }

    #[test]
    fn observe_schedules_offline_and_live_checks() {
        let t = SigninTracker::new();
        let start = Instant::now();
        let profiles = names(&["default", "work"]);
        // Agent start: every profile needs the offline check.
        let w = t.observe(&profiles, &[], start);
        assert_eq!(w.offline, profiles);
        assert!(w.live.is_empty());
        for p in &profiles {
            t.set_offline(p, SigninCheck::unknown());
        }
        // Work starts: ask its extension, once per interval.
        let w = t.observe(&profiles, &names(&["work"]), start);
        assert!(w.offline.is_empty());
        assert_eq!(w.live, names(&["work"]));
        t.asked("work", start);
        let w = t.observe(
            &profiles,
            &names(&["work"]),
            start + Duration::from_secs(60),
        );
        assert!(w.live.is_empty());
        let w = t.observe(
            &profiles,
            &names(&["work"]),
            start + LIVE_CHECK_INTERVAL + Duration::from_secs(1),
        );
        assert_eq!(w.live, names(&["work"]));
        // It stops (a crash or an idle close): offline check again, and its
        // live result no longer wins.
        t.set_live("work", SigninCheck::new(SigninState::SignedOut, Vec::new()));
        let w = t.observe(&profiles, &[], start);
        assert_eq!(w.offline, names(&["work"]));
        assert_eq!(t.status("work", true).signin, SigninState::Unknown);
        // A new profile directory: offline check.
        let w = t.observe(&names(&["default", "new", "work"]), &[], start);
        assert_eq!(w.offline, names(&["new"]));
    }

    #[test]
    fn report_follows_profile_order_and_marks_unchecked_profiles() {
        let t = SigninTracker::new();
        t.set_offline("work", SigninCheck::new(SigninState::SignedOut, Vec::new()));
        let r = t.report(&names(&["default", "work"]), &[]);
        assert_eq!(r.profiles.len(), 2);
        assert_eq!(r.profiles[0].name, "default");
        assert_eq!(r.profiles[0].signin, SigninState::Unknown);
        assert!(r.profiles[0].checked_at.is_none());
        assert_eq!(r.profiles[1].signin, SigninState::SignedOut);
        assert!(r.profiles[1].checked_at.is_some());
    }

    #[tokio::test]
    async fn a_change_wakes_the_reporter_and_a_repeat_does_not() {
        let t = std::sync::Arc::new(SigninTracker::new());
        t.set_offline("default", SigninCheck::unknown());
        // The first store is a change.
        tokio::time::timeout(Duration::from_secs(1), t.changed())
            .await
            .unwrap();
        t.set_offline("default", SigninCheck::unknown());
        assert!(tokio::time::timeout(Duration::from_millis(50), t.changed())
            .await
            .is_err());
        t.set_offline(
            "default",
            SigninCheck::new(SigninState::SignedOut, Vec::new()),
        );
        tokio::time::timeout(Duration::from_secs(1), t.changed())
            .await
            .unwrap();
    }

    #[test]
    fn doctor_prints_each_profile() {
        let dir = tempfile::tempdir().unwrap();
        for (name, file) in [("default", "signed-in.json"), ("work", "signed-out.json")] {
            let d = dir.path().join(name).join("Default");
            std::fs::create_dir_all(&d).unwrap();
            std::fs::write(d.join("Preferences"), fixture(file)).unwrap();
        }
        std::fs::create_dir_all(dir.path().join("fresh")).unwrap();
        let lines = doctor_lines(dir.path());
        assert_eq!(lines.len(), 3);
        assert!(lines[0].starts_with("ok   profile default: signed_in"));
        assert!(lines[0].contains("owner@example.com"));
        assert!(lines[1].contains("profile fresh: unknown"));
        assert!(lines[2].starts_with("warn profile work: signed_out"));
    }
}
