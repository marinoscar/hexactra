//! Scoped credentials over real HTTP (#210).

use std::time::Duration;

use hexactra_client::{ControlClient, HostClient};
use hexactra_control::runtime::{self, ApiState, RuntimeStore};
use hexactra_core::remote::{CreateSessionRequest, RegisterHostRequest, RemoteAction};
use serde_json::json;

const OPERATOR: &str = "operator-token-0123456789abcdefgh";

async fn start() -> String {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    tokio::spawn(runtime::serve(
        listener,
        ApiState::new(RuntimeStore::new(), OPERATOR),
        std::future::pending(),
    ));
    url
}

async fn status(method: reqwest::Method, url: &str, token: &str) -> u16 {
    reqwest::Client::new()
        .request(method, url)
        .bearer_auth(token)
        .json(&json!({}))
        .send()
        .await
        .unwrap()
        .status()
        .as_u16()
}

#[tokio::test]
async fn service_and_host_tokens_are_scoped() {
    let url = start().await;
    let operator = ControlClient::new(&url, OPERATOR).unwrap();

    // Operator mints a service token (e.g. for the console).
    let created = operator.create_service_token("console").await.unwrap();
    let service_token = created["token"].as_str().unwrap().to_string();
    assert!(service_token.starts_with("hxs_"));
    let service = ControlClient::new(&url, &service_token).unwrap();

    // Service token: client routes yes, operator and host routes no.
    assert!(service.hosts().await.unwrap().is_empty());
    assert_eq!(
        service
            .create_service_token("x")
            .await
            .unwrap_err()
            .status(),
        Some(403)
    );
    assert_eq!(
        status(
            reqwest::Method::POST,
            &format!("{url}/v1/hosts/register"),
            &service_token
        )
        .await,
        403
    );

    // Service token creates a single-use enrollment.
    let enrollment = service
        .create_enrollment(Some("vps"), Some(Duration::from_secs(600)))
        .await
        .unwrap();
    let et = enrollment["enrollment_token"].as_str().unwrap().to_string();
    assert!(et.starts_with("hxe_"));

    // The enrollment token is not a bearer credential.
    assert_eq!(
        status(reqwest::Method::GET, &format!("{url}/v1/hosts"), &et).await,
        401
    );

    // Host exchanges it (public route) for its own credential.
    let e = HostClient::enroll(&url, &et, "", "1.0").await.unwrap();
    assert!(e.host_token.starts_with("hxh_"));
    assert_eq!(
        HostClient::enroll(&url, &et, "again", "1.0")
            .await
            .unwrap_err()
            .status(),
        Some(403),
        "enrollment tokens are single use"
    );
    let hosts = service.hosts().await.unwrap();
    assert_eq!(hosts[0].id, e.host_id);
    assert_eq!(hosts[0].name, "vps");

    // Host credential: its own host routes only.
    let host = HostClient::new(&url, &e.host_token).unwrap();
    let reg = host
        .register(&RegisterHostRequest {
            name: "vps".into(),
            version: "1.0".into(),
            host_id: Some(uuid::Uuid::new_v4()), // ignored: bound to the credential
            viewer_url: None,
        })
        .await
        .unwrap();
    assert_eq!(reg.host_id, e.host_id);
    host.next(e.host_id, true, Duration::from_millis(10))
        .await
        .unwrap();
    assert_eq!(
        host.next(uuid::Uuid::new_v4(), true, Duration::from_millis(10))
            .await
            .unwrap_err()
            .status(),
        Some(403),
        "a host cannot poll as another host"
    );
    assert_eq!(
        status(
            reqwest::Method::GET,
            &format!("{url}/v1/sessions"),
            &e.host_token
        )
        .await,
        403
    );

    // The service token drives the host end to end.
    let session = service
        .create_session(&CreateSessionRequest::default())
        .await
        .unwrap();
    let h2 = host.clone();
    let hid = e.host_id;
    tokio::spawn(async move {
        let op = h2
            .next(hid, true, Duration::from_secs(5))
            .await
            .unwrap()
            .unwrap();
        h2.report(
            hid,
            op.id,
            &hexactra_core::remote::OperationResult {
                ok: true,
                result: Some(json!({"tabs": []})),
                error: None,
            },
        )
        .await
        .unwrap();
    });
    let op = service
        .act(session.id, RemoteAction::Tabs, Some(Duration::from_secs(5)))
        .await
        .unwrap();
    assert_eq!(op.state, hexactra_core::remote::OperationState::Succeeded);

    // Revoking the host cuts it off and ends its sessions.
    service.revoke_host(e.host_id).await.unwrap();
    assert_eq!(
        host.next(e.host_id, true, Duration::from_millis(10))
            .await
            .unwrap_err()
            .status(),
        Some(401)
    );
    assert!(service.hosts().await.unwrap().is_empty());
    assert_eq!(
        service.session(session.id).await.unwrap().status,
        hexactra_core::remote::RemoteSessionStatus::Ended
    );
}

#[tokio::test]
async fn operator_token_still_works_for_hosts() {
    // Single-token setups (the operator token everywhere) keep working.
    let url = start().await;
    let host = HostClient::new(&url, OPERATOR).unwrap();
    let id = host
        .register(&RegisterHostRequest {
            name: "legacy".into(),
            version: "0".into(),
            host_id: None,
            viewer_url: None,
        })
        .await
        .unwrap()
        .host_id;
    host.next(id, true, Duration::from_millis(10))
        .await
        .unwrap();
    let client = ControlClient::new(&url, OPERATOR).unwrap();
    assert_eq!(client.hosts().await.unwrap().len(), 1);
}
