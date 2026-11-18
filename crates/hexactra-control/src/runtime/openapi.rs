//! OpenAPI document for `/v1`, generated from the handlers (#216).
//!
//! `hexactra-control openapi` prints it; `api/openapi.yaml` is that output,
//! and `tests/openapi_contract.rs` fails when the two drift or a route is
//! missing from the document.

#![allow(unused_imports)]

pub use hexactra_core::remote::*;
pub use serde_json::Value as Object;
use utoipa::openapi::security::{HttpAuthScheme, HttpBuilder, SecurityScheme};
use utoipa::{Modify, OpenApi, ToSchema};
pub use uuid::Uuid;

pub use super::credentials::{EnrollmentView, ServiceTokenView};
pub use super::credentials_api::{
    CreateEnrollmentRequest, CreateServiceTokenRequest, CreatedEnrollment, CreatedServiceToken,
    EnrollRequest, EnrollResponse,
};
pub use super::events::FabricEvent;

macro_rules! list {
    ($name:ident, $field:ident, $item:ty) => {
        #[derive(serde::Serialize, ToSchema)]
        pub struct $name {
            pub $field: Vec<$item>,
        }
    };
}
list!(HostList, hosts, HostView);
list!(SessionList, sessions, SessionView);
list!(HandoffList, handoffs, HandoffView);
list!(WebhookList, webhooks, WebhookView);
list!(DeliveryList, deliveries, WebhookDelivery);
list!(HostCommandList, commands, HostCommandView);
list!(EnrollmentList, enrollments, EnrollmentView);
list!(ServiceTokenList, service_tokens, ServiceTokenView);

struct Bearer;

impl Modify for Bearer {
    fn modify(&self, openapi: &mut utoipa::openapi::OpenApi) {
        let c = openapi.components.get_or_insert_with(Default::default);
        c.add_security_scheme(
            "bearer",
            SecurityScheme::Http(
                HttpBuilder::new()
                    .scheme(HttpAuthScheme::Bearer)
                    .description(Some(
                        "Operator token, service token (`hxs_…`) for client routes, or a host token (`hxh_…`) for that host's agent routes",
                    ))
                    .build(),
            ),
        );
    }
}

#[derive(OpenApi)]
#[openapi(
    info(
        title = "Hexactra Fabric API",
        description = "Remote browser control: hosts, sessions and actions, human handoffs, webhooks, host commands, artifacts and the event stream. Generated from the server code; see docs/remote-control-api.md for the guide.",
    ),
    servers((url = "http://127.0.0.1:8787", description = "Default local bind")),
    security(("bearer" = [])),
    modifiers(&Bearer),
    paths(
        super::api::health,
        super::api::list_hosts,
        super::api::register_host,
        super::api::next_operation,
        super::api::host_offline,
        super::api::post_result,
        super::api::list_sessions,
        super::api::create_session,
        super::api::get_session,
        super::api::end_session,
        super::api::run_action,
        super::api::get_operation,
        super::api::get_artifact,
        super::host_commands_api::create_command,
        super::host_commands_api::list_commands,
        super::host_commands_api::get_command,
        super::host_commands_api::post_result,
        super::events_api::events,
        super::handoff_api::create,
        super::handoff_api::list,
        super::handoff_api::read,
        super::handoff_api::claim,
        super::handoff_api::cancel,
        super::handoff_api::form,
        super::handoff_api::respond,
        super::webhook_api::create,
        super::webhook_api::list,
        super::webhook_api::remove,
        super::webhook_api::test,
        super::webhook_api::deliveries,
        super::credentials_api::enroll,
        super::credentials_api::create_enrollment,
        super::credentials_api::list_enrollments,
        super::credentials_api::revoke_host,
        super::credentials_api::create_service_token,
        super::credentials_api::list_service_tokens,
        super::credentials_api::revoke_service_token,
        super::desktop::create_desktop_session,
        super::desktop::client_connect,
        super::desktop::host_connect,
        super::takeover::take_over,
        super::takeover::renew,
        super::takeover::release,
        super::takeover::current,
    ),
    components(schemas(ScreenshotResult)),
    tags(
        (name = "sessions", description = "Sessions, actions and operations"),
        (name = "hosts", description = "Registered hosts"),
        (name = "host-commands", description = "Manage a host's profiles and browsers"),
        (name = "handoffs", description = "Ask a person for help"),
        (name = "webhooks", description = "Channels that reach a person"),
        (name = "events", description = "Server-sent event stream"),
        (name = "artifacts", description = "Short-lived screenshot bytes"),
        (name = "credentials", description = "Host enrollment and service tokens"),
        (name = "agent", description = "Routes used by host agents"),
        (name = "desktop", description = "Remote desktop tunnels to a node (the WebSocket legs are `GET /v1/desktop/{tunnel_id}/connect` and `GET /v1/hosts/{host_id}/desktop/{tunnel_id}`)"),
        (name = "health", description = "Liveness"),
    )
)]
pub struct ApiDoc;

/// The document as YAML (what `api/openapi.yaml` holds).
pub fn yaml() -> String {
    let mut doc = ApiDoc::openapi();
    doc.info.version = env!("CARGO_PKG_VERSION").to_string();
    doc.to_yaml().expect("OpenAPI document serializes")
}
