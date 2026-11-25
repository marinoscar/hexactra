//! Remote desktop tunnels over real HTTP and WebSockets (#338): the viewer's
//! leg and the node's leg meet at the fabric, which relays bytes both ways,
//! with single-use tokens, per-host limits, timeouts and audit events.

use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use hexactra_client::{HostClient, HostPollStatus};
use hexactra_control::runtime::desktop::{DesktopTunnels, Limits};
use hexactra_control::runtime::{self, ApiState, RuntimeStore};
use hexactra_core::remote::{HostCommand, HostMode, HostWork, RegisterHostRequest};
use serde_json::{json, Value};
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::HeaderValue;
use tokio_tungstenite::tungstenite::Message;

const OPERATOR: &str = "operator-token-0123456789abcdefgh";
const RFB: &[u8] = b"RFB 003.008\n";

struct Fabric {
    url: String,
    store: RuntimeStore,
}

async fn start(limits: Limits) -> Fabric {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let store = RuntimeStore::new();
    let mut state = ApiState::new(store.clone(), OPERATOR);
    state.desktop = DesktopTunnels::new(limits);
    tokio::spawn(runtime::serve(listener, state, std::future::pending()));
    Fabric { url, store }
}

async fn register(url: &str, name: &str, desktop: bool) -> (HostClient, uuid::Uuid) {
    let host = HostClient::new(url, OPERATOR).unwrap();
    let id = host
        .register(&RegisterHostRequest {
            name: name.into(),
            version: "0".into(),
            host_id: None,
            viewer_url: None,
            mode: Some(HostMode::Unattended),
            desktop,
            bluetooth: None,
        })
        .await
        .unwrap()
        .host_id;
    (host, id)
}

async fn open(url: &str, host: uuid::Uuid) -> reqwest::Response {
    reqwest::Client::new()
        .post(format!("{url}/v1/hosts/{host}/desktop-sessions"))
        .bearer_auth(OPERATOR)
        .json(&json!({ "actor": { "user_id": "u1", "display_name": "Person A" } }))
        .send()
        .await
        .unwrap()
}

fn ws_url(url: &str, path: &str) -> String {
    format!("{}{path}", url.replacen("http", "ws", 1))
}

type Ws =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

async fn dial(url: &str, path: &str, token: &str) -> Result<Ws, u16> {
    let mut req = ws_url(url, path).into_client_request().unwrap();
    req.headers_mut().insert(
        "authorization",
        HeaderValue::from_str(&format!("Bearer {token}")).unwrap(),
    );
    match tokio_tungstenite::connect_async(req).await {
        Ok((ws, _)) => Ok(ws),
        Err(tokio_tungstenite::tungstenite::Error::Http(r)) => Err(r.status().as_u16()),
        Err(e) => panic!("unexpected websocket error: {e}"),
    }
}

/// The node's side: poll the OpenDesktop command, then connect the host leg.
async fn host_leg(url: &str, host: &HostClient, id: uuid::Uuid) -> Ws {
    let status = HostPollStatus {
        browser_connected: true,
        on_demand: true,
        profiles: None,
        accepts_commands: true,
    };
    let work = host
        .poll(id, &status, Duration::from_secs(2))
        .await
        .unwrap();
    let Some(HostWork::Command { command }) = work else {
        panic!("expected the OpenDesktop command, got {work:?}");
    };
    let HostCommand::OpenDesktop { tunnel_id, .. } = command.command else {
        panic!("expected OpenDesktop");
    };
    dial(
        url,
        &format!("/v1/hosts/{id}/desktop/{tunnel_id}"),
        OPERATOR,
    )
    .await
    .unwrap()
}

async fn next_binary(ws: &mut Ws) -> Vec<u8> {
    loop {
        match tokio::time::timeout(Duration::from_secs(5), ws.next())
            .await
            .unwrap()
        {
            Some(Ok(Message::Binary(b))) => return b.to_vec(),
            Some(Ok(Message::Ping(_) | Message::Pong(_))) => continue,
            other => panic!("expected binary, got {other:?}"),
        }
    }
}

async fn close_code(ws: &mut Ws) -> u16 {
    loop {
        match tokio::time::timeout(Duration::from_secs(5), ws.next())
            .await
            .unwrap()
        {
            Some(Ok(Message::Close(Some(f)))) => return f.code.into(),
            Some(Ok(Message::Close(None))) | None => return 1005,
            Some(Ok(_)) => continue,
            Some(Err(e)) => panic!("{e}"),
        }
    }
}

fn events(store: &RuntimeStore, kind: &str) -> Vec<Value> {
    store
        .log
        .recent()
        .into_iter()
        .filter(|e| e.kind == kind)
        .map(|e| e.data)
        .collect()
}

#[tokio::test]
async fn relays_the_desktop_both_ways_and_audits_it() {
    let f = start(Limits::default()).await;
    let (host, id) = register(&f.url, "mini-pc", true).await;
    let r = open(&f.url, id).await;
    assert_eq!(r.status(), 201);
    let s: Value = r.json().await.unwrap();
    let token = s["connect_token"].as_str().unwrap().to_string();
    assert!(token.starts_with("hxd_"));
    let tunnel = s["tunnel_id"].as_str().unwrap().to_string();

    let viewer_path = format!("/v1/desktop/{tunnel}/connect");
    let url = f.url.clone();
    let t = token.clone();
    let viewer = tokio::spawn(async move { dial(&url, &viewer_path, &t).await.unwrap() });
    let mut node = host_leg(&f.url, &host, id).await;
    let mut viewer = viewer.await.unwrap();

    // The server speaks first in RFB.
    node.send(Message::Binary(RFB.to_vec().into()))
        .await
        .unwrap();
    assert_eq!(next_binary(&mut viewer).await, RFB);
    viewer
        .send(Message::Binary(RFB.to_vec().into()))
        .await
        .unwrap();
    assert_eq!(next_binary(&mut node).await, RFB);

    // The token works once.
    assert_eq!(
        dial(&f.url, &format!("/v1/desktop/{tunnel}/connect"), &token)
            .await
            .unwrap_err(),
        401
    );

    viewer.close(None).await.unwrap();
    assert_eq!(close_code(&mut node).await, 1000);
    tokio::time::sleep(Duration::from_millis(100)).await;
    let opened = events(&f.store, "desktop.opened");
    assert_eq!(opened.len(), 1);
    let closed = events(&f.store, "desktop.closed");
    assert_eq!(closed[0]["reason"], "viewer_closed");
    assert_eq!(closed[0]["bytes_up"], RFB.len());
    assert_eq!(closed[0]["bytes_down"], RFB.len());
    // The connect token is in no event.
    let all = serde_json::to_string(&f.store.log.recent()).unwrap();
    assert!(!all.contains(&token));
    assert!(
        all.contains("Person A"),
        "the requested event names who asked"
    );
}

#[tokio::test]
async fn refuses_bad_tokens_unknown_tunnels_and_another_hosts_tunnel() {
    let f = start(Limits::default()).await;
    let (_host, id) = register(&f.url, "a", true).await;
    let (_other, other_id) = register(&f.url, "b", true).await;
    let s: Value = open(&f.url, id).await.json().await.unwrap();
    let tunnel = s["tunnel_id"].as_str().unwrap();
    let path = format!("/v1/desktop/{tunnel}/connect");
    assert_eq!(dial(&f.url, &path, "hxd_wrong").await.unwrap_err(), 401);
    assert_eq!(
        dial(&f.url, &path, OPERATOR).await.unwrap_err(),
        401,
        "a client token is not a desktop token"
    );
    let unknown = uuid::Uuid::new_v4();
    assert_eq!(
        dial(&f.url, &format!("/v1/desktop/{unknown}/connect"), "hxd_x")
            .await
            .unwrap_err(),
        401
    );
    // Host leg: the tunnel belongs to host `a`.
    assert_eq!(
        dial(
            &f.url,
            &format!("/v1/hosts/{other_id}/desktop/{tunnel}"),
            OPERATOR
        )
        .await
        .unwrap_err(),
        404
    );
    assert_eq!(
        dial(
            &f.url,
            &format!("/v1/hosts/{id}/desktop/{tunnel}"),
            "not-a-token"
        )
        .await
        .unwrap_err(),
        401
    );
    // Clients cannot queue OpenDesktop themselves.
    let r = reqwest::Client::new()
        .post(format!("{}/v1/hosts/{id}/commands", f.url))
        .bearer_auth(OPERATOR)
        .json(&json!({ "command": { "type": "open_desktop", "tunnel_id": unknown, "expires_at": "2030-01-01T00:00:00Z" } }))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 400);
}

#[tokio::test]
async fn offline_no_desktop_unknown_and_limits() {
    let f = start(Limits {
        per_host: 1,
        ..Limits::default()
    })
    .await;
    let (_h, no_desktop) = register(&f.url, "attended", false).await;
    let r = open(&f.url, no_desktop).await;
    assert_eq!(r.status(), 409);
    assert_eq!(
        r.json::<Value>().await.unwrap()["error"],
        "desktop_unavailable"
    );
    assert_eq!(open(&f.url, uuid::Uuid::new_v4()).await.status(), 404);

    let (_host, id) = register(&f.url, "node", true).await;
    assert_eq!(open(&f.url, id).await.status(), 201);
    let r = open(&f.url, id).await;
    assert_eq!(r.status(), 429);
    assert_eq!(
        r.json::<Value>().await.unwrap()["error"],
        "too_many_desktops"
    );

    let (_h2, id2) = register(&f.url, "node2", true).await;
    f.store.set_host_offline(id2).unwrap();
    let r = open(&f.url, id2).await;
    assert_eq!(r.status(), 409);
    assert_eq!(r.json::<Value>().await.unwrap()["error"], "host_offline");
    // Needs a client token.
    let anon = reqwest::Client::new()
        .post(format!("{}/v1/hosts/{id}/desktop-sessions", f.url))
        .send()
        .await
        .unwrap();
    assert_eq!(anon.status(), 401);
}

#[tokio::test]
async fn closes_the_viewer_when_the_node_never_connects() {
    let f = start(Limits {
        host_wait: Duration::from_millis(300),
        ..Limits::default()
    })
    .await;
    let (_host, id) = register(&f.url, "node", true).await;
    let s: Value = open(&f.url, id).await.json().await.unwrap();
    let path = format!("/v1/desktop/{}/connect", s["tunnel_id"].as_str().unwrap());
    let mut viewer = dial(&f.url, &path, s["connect_token"].as_str().unwrap())
        .await
        .unwrap();
    assert_eq!(close_code(&mut viewer).await, 4504);
}

#[tokio::test]
async fn closes_an_idle_tunnel() {
    let f = start(Limits {
        idle: Duration::from_millis(400),
        ..Limits::default()
    })
    .await;
    let (host, id) = register(&f.url, "node", true).await;
    let s: Value = open(&f.url, id).await.json().await.unwrap();
    let path = format!("/v1/desktop/{}/connect", s["tunnel_id"].as_str().unwrap());
    let url = f.url.clone();
    let token = s["connect_token"].as_str().unwrap().to_string();
    let viewer = tokio::spawn(async move { dial(&url, &path, &token).await.unwrap() });
    let mut node = host_leg(&f.url, &host, id).await;
    let mut viewer = viewer.await.unwrap();
    assert_eq!(close_code(&mut viewer).await, 4408);
    assert_eq!(close_code(&mut node).await, 4408);
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert_eq!(events(&f.store, "desktop.closed")[0]["reason"], "idle");
}

async fn take(url: &str, host: uuid::Uuid, user: &str, name: &str) -> reqwest::Response {
    reqwest::Client::new()
        .post(format!("{url}/v1/hosts/{host}/takeover"))
        .bearer_auth(OPERATOR)
        .json(&json!({ "actor": { "user_id": user, "display_name": name }, "ttl_s": 60 }))
        .send()
        .await
        .unwrap()
}

#[tokio::test]
async fn takeover_pauses_actions_and_is_held_by_one_person() {
    use hexactra_client::ControlClient;
    use hexactra_core::remote::{CreateSessionRequest, RemoteAction};
    let f = start(Limits::default()).await;
    let (host, id) = register(&f.url, "node", true).await;
    // A connected browser, so a session can be created.
    let status = HostPollStatus {
        browser_connected: true,
        on_demand: false,
        profiles: None,
        accepts_commands: true,
    };
    host.poll(id, &status, Duration::from_millis(10))
        .await
        .unwrap();
    let client = ControlClient::new(&f.url, OPERATOR).unwrap();
    let session = client
        .create_session(&CreateSessionRequest::default())
        .await
        .unwrap();

    let r = take(&f.url, id, "u1", "Person A").await;
    assert_eq!(r.status(), 201);
    let lease: Value = r.json().await.unwrap();
    let lease_id = lease["lease_id"].as_str().unwrap().to_string();

    // Someone else cannot take it; the same person extends it.
    let held = take(&f.url, id, "u2", "Person B").await;
    assert_eq!(held.status(), 409);
    assert_eq!(
        held.json::<Value>().await.unwrap()["error"],
        "takeover_held"
    );
    let again: Value = take(&f.url, id, "u1", "Person A")
        .await
        .json()
        .await
        .unwrap();
    assert_eq!(again["lease_id"].as_str().unwrap(), lease_id);

    // The agent's next action waits.
    let nav = RemoteAction::Navigate {
        url: "https://example.test".into(),
        tab_id: None,
    };
    let err = client
        .act(session.id, nav.clone(), Some(Duration::from_millis(100)))
        .await
        .unwrap_err();
    assert_eq!(err.status(), Some(409));
    assert!(err.to_string().contains("takeover_active"), "{err}");

    let renew = reqwest::Client::new()
        .post(format!("{}/v1/hosts/{id}/takeover/{lease_id}/renew", f.url))
        .bearer_auth(OPERATOR)
        .json(&json!({ "ttl_s": 120 }))
        .send()
        .await
        .unwrap();
    assert_eq!(renew.status(), 200);
    let del = reqwest::Client::new()
        .delete(format!("{}/v1/hosts/{id}/takeover/{lease_id}", f.url))
        .bearer_auth(OPERATOR)
        .send()
        .await
        .unwrap();
    assert_eq!(del.status(), 204);
    // Released: the action is queued again (it times out here: no browser runs it).
    let err = client
        .act(session.id, nav.clone(), Some(Duration::from_millis(100)))
        .await;
    assert!(err
        .as_ref()
        .map(|_| true)
        .unwrap_or_else(|e| e.status() != Some(409)));
    let kinds: Vec<String> = f.store.log.recent().into_iter().map(|e| e.kind).collect();
    for k in ["takeover.started", "takeover.renewed", "takeover.released"] {
        assert!(kinds.iter().any(|x| x == k), "missing {k}");
    }
}

#[tokio::test]
async fn input_reaches_the_node_only_while_the_viewer_holds_the_lease() {
    let f = start(Limits::default()).await;
    let (host, id) = register(&f.url, "node", true).await;
    let s: Value = open(&f.url, id).await.json().await.unwrap(); // actor user_id "u1"
    let path = format!("/v1/desktop/{}/connect", s["tunnel_id"].as_str().unwrap());
    let url = f.url.clone();
    let token = s["connect_token"].as_str().unwrap().to_string();
    let viewer = tokio::spawn(async move { dial(&url, &path, &token).await.unwrap() });
    let mut node = host_leg(&f.url, &host, id).await;
    let mut viewer = viewer.await.unwrap();

    let mut hello = RFB.to_vec();
    hello.extend([1, 1]); // security None, ClientInit
    viewer
        .send(Message::Binary(hello.clone().into()))
        .await
        .unwrap();
    assert_eq!(next_binary(&mut node).await, hello);

    let pointer = [5u8, 1, 0, 10, 0, 20];
    let fb_request = [3u8, 1, 0, 0, 0, 0, 7, 128, 4, 56];
    let mut both = pointer.to_vec();
    both.extend(fb_request);
    viewer
        .send(Message::Binary(both.clone().into()))
        .await
        .unwrap();
    assert_eq!(
        next_binary(&mut node).await,
        fb_request,
        "watching: the click is dropped"
    );

    // Someone else's lease does not let this viewer type either.
    assert_eq!(take(&f.url, id, "u2", "Person B").await.status(), 201);
    viewer
        .send(Message::Binary(both.clone().into()))
        .await
        .unwrap();
    assert_eq!(next_binary(&mut node).await, fb_request);
    let lease: Value = reqwest::Client::new()
        .get(format!("{}/v1/hosts/{id}/takeover", f.url))
        .bearer_auth(OPERATOR)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    reqwest::Client::new()
        .delete(format!(
            "{}/v1/hosts/{id}/takeover/{}",
            f.url,
            lease["lease_id"].as_str().unwrap()
        ))
        .bearer_auth(OPERATOR)
        .send()
        .await
        .unwrap();

    // With its own lease, the viewer's click goes through.
    assert_eq!(take(&f.url, id, "u1", "Person A").await.status(), 201);
    viewer
        .send(Message::Binary(both.clone().into()))
        .await
        .unwrap();
    assert_eq!(next_binary(&mut node).await, both);

    // Not RFB: the tunnel closes.
    viewer
        .send(Message::Binary(vec![42u8].into()))
        .await
        .unwrap();
    assert_eq!(close_code(&mut node).await, 4400);
}
