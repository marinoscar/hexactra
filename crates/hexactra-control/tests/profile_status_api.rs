//! Per-profile sign-in status from the agent to `GET /v1/hosts` (E48.1, #927),
//! over real HTTP.
//!
//! The agent reports with `POST /v1/hosts/{id}/profile-status` (a body, so an
//! email is never in a URL or an access log). An agent that never reports
//! leaves its profiles `unknown`. The email reaches the host list (display
//! data for the owner) and nothing the control plane logs or traces.

use std::io::Write;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use hexactra_client::{ControlClient, HostClient, HostPollStatus};
use hexactra_control::runtime::{self, ApiState, RuntimeStore};
use hexactra_core::remote::{
    ProfileAccount, ProfileSignin, ProfileStatusReport, RegisterHostRequest, SigninState,
};

const TOKEN: &str = "secret-test-token-0123456789abcdef";
const EMAIL: &str = "canary-owner-7f3a@example.com";

#[derive(Clone, Default)]
struct LogBuf(Arc<Mutex<Vec<u8>>>);

impl Write for LogBuf {
    fn write(&mut self, b: &[u8]) -> std::io::Result<usize> {
        self.0.lock().unwrap().extend_from_slice(b);
        Ok(b.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

impl<'a> tracing_subscriber::fmt::MakeWriter<'a> for LogBuf {
    type Writer = LogBuf;
    fn make_writer(&'a self) -> Self::Writer {
        self.clone()
    }
}

async fn start() -> (String, RuntimeStore) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let store = RuntimeStore::new();
    let state = ApiState::with_webhooks(
        store.clone(),
        TOKEN,
        hexactra_control::runtime::webhooks::Webhooks::in_memory(),
    );
    tokio::spawn(runtime::serve(listener, state, std::future::pending()));
    (url, store)
}

async fn register(host: &HostClient, name: &str) -> uuid::Uuid {
    let id = host
        .register(&RegisterHostRequest {
            name: name.into(),
            version: "0".into(),
            host_id: None,
            viewer_url: None,
            mode: None,
            desktop: true,
        })
        .await
        .unwrap()
        .host_id;
    host.poll(
        id,
        &HostPollStatus {
            browser_connected: false,
            on_demand: true,
            profiles: Some((vec!["default".into(), "work".into()], vec!["work".into()])),
            accepts_commands: true,
        },
        Duration::from_millis(10),
    )
    .await
    .unwrap();
    id
}

#[tokio::test]
async fn reported_status_reaches_the_host_list_and_no_log() {
    let logs = LogBuf::default();
    let _ = tracing_subscriber::fmt()
        .with_writer(logs.clone())
        .with_max_level(tracing::Level::TRACE)
        .with_ansi(false)
        .try_init();
    let (url, _store) = start().await;
    let host = HostClient::new(&url, TOKEN).unwrap();
    let client = ControlClient::new(&url, TOKEN).unwrap();
    let id = register(&host, "node").await;

    // Not reported yet (an older agent): every profile is unknown.
    let h = client.hosts().await.unwrap();
    let h = h.iter().find(|h| h.id == id).unwrap();
    assert_eq!(h.profile_status.len(), 2);
    assert!(h
        .profile_status
        .iter()
        .all(|p| p.signin == SigninState::Unknown && p.accounts.is_empty()));
    assert_eq!(h.profiles, vec!["default", "work"]);
    assert_eq!(h.running_profiles, vec!["work"]);

    host.report_profile_status(
        id,
        &ProfileStatusReport {
            profiles: vec![
                ProfileSignin {
                    name: "work".into(),
                    signin: SigninState::SignedIn,
                    accounts: vec![ProfileAccount {
                        provider: "google".into(),
                        email: EMAIL.into(),
                        state: SigninState::SignedIn,
                    }],
                    checked_at: Some(chrono::Utc::now()),
                },
                ProfileSignin {
                    name: "default".into(),
                    signin: SigninState::SignedOut,
                    accounts: vec![],
                    checked_at: Some(chrono::Utc::now()),
                },
            ],
        },
    )
    .await
    .unwrap();

    let h = client.hosts().await.unwrap();
    let h = h.iter().find(|h| h.id == id).unwrap();
    let work = h.profile_status.iter().find(|p| p.name == "work").unwrap();
    assert!(work.running);
    assert_eq!(work.signin, SigninState::SignedIn);
    assert_eq!(work.accounts[0].email, EMAIL);
    let default = h
        .profile_status
        .iter()
        .find(|p| p.name == "default")
        .unwrap();
    assert_eq!(default.signin, SigninState::SignedOut);
    // Existing fields keep their meaning.
    assert_eq!(h.profiles, vec!["default", "work"]);
    assert_eq!(h.running_profiles, vec!["work"]);

    // The status change is on the event stream, without the email.
    let raw = reqwest::Client::new()
        .get(format!("{url}/v1/events"))
        .bearer_auth(TOKEN)
        .query(&[("after", "0")])
        .timeout(Duration::from_millis(500))
        .send()
        .await
        .unwrap();
    let body = String::from_utf8_lossy(&raw.bytes().await.unwrap_or_default()).to_string();
    assert!(!body.contains(EMAIL));

    let out = String::from_utf8(logs.0.lock().unwrap().clone()).unwrap();
    assert!(out.contains("profile sign-in status reported"), "{out}");
    assert!(!out.contains(EMAIL), "email leaked into logs: {out}");
}

#[tokio::test]
async fn an_unknown_host_is_refused() {
    let (url, store) = start().await;
    let host = HostClient::new(&url, TOKEN).unwrap();
    let id = register(&host, "a").await;
    // Unknown host id: 404.
    let err = host
        .report_profile_status(uuid::Uuid::new_v4(), &ProfileStatusReport::default())
        .await
        .unwrap_err();
    assert!(
        err.to_string().contains("404") || err.to_string().contains("not found"),
        "{err}"
    );
    // The real host still reports.
    host.report_profile_status(id, &ProfileStatusReport::default())
        .await
        .unwrap();
    assert_eq!(store.list_hosts().len(), 1);
}
