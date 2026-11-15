//! HTTP routes for human handoffs (#189).
//!
//! Protected (API token): create, list, read/wait, cancel, and the
//! deprecated claim of a secret (operator and service tokens only; a
//! `type_secret` action types a secret without returning it, #287).
//! Public (own auth): `/v1/handoffs/{id}/respond` accepts the API token or the
//! handoff's single-use response token, as JSON or as an HTML form, so any
//! channel (chat bot, automation, emailed link) can answer.

#[allow(unused_imports)]
use super::openapi::*;
use std::time::Duration;

use axum::{
    body::Bytes,
    extract::{Extension, Path, Query, State},
    http::{header, HeaderMap, HeaderValue, StatusCode},
    response::{Html, IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use hexactra_core::remote::{
    ClaimedHandoffValue, CreateHandoffRequest, CreateHandoffResponse, HandoffInput, HandoffOutcome,
    HandoffRisk, HandoffStatus, HandoffView, RespondHandoffRequest,
};
use serde::Deserialize;
use uuid::Uuid;

use super::api::{ApiState, AppError};
use super::credentials::Principal;
use super::handoff::Responder;

/// Header channels may use to send the response token.
pub const RESPONSE_TOKEN_HEADER: &str = "x-hexactra-response-token";
const MAX_HANDOFF_WAIT: Duration = Duration::from_secs(120);

#[allow(deprecated)] // `claim` stays served while callers move to `type_secret`.
pub(super) fn protected_routes() -> Router<ApiState> {
    Router::new()
        .route("/v1/sessions/{id}/handoffs", post(create))
        .route("/v1/handoffs", get(list))
        .route("/v1/handoffs/{id}", get(read))
        .route("/v1/handoffs/{id}/claim", post(claim))
        .route("/v1/handoffs/{id}/cancel", post(cancel))
}

pub(super) fn public_routes() -> Router<ApiState> {
    Router::new().route("/v1/handoffs/{id}/respond", get(form).post(respond))
}

pub fn respond_path(id: Uuid) -> String {
    format!("/v1/handoffs/{id}/respond")
}

#[utoipa::path(
    post,
    path = "/v1/sessions/{id}/handoffs",
    tag = "handoffs",
    params(("id" = Uuid, Path,)),
    request_body = CreateHandoffRequest,
    responses((status = 201, body = CreateHandoffResponse), (status = 400, description = "Invalid request"), (status = 409, description = "Session ended or a handoff is pending"), (status = 401, description = "Missing or invalid token"), (status = 403, description = "Token not allowed here"))
)]
async fn create(
    State(s): State<ApiState>,
    Path(session_id): Path<Uuid>,
    Json(req): Json<CreateHandoffRequest>,
) -> Result<impl IntoResponse, AppError> {
    let (handoff, response_token) = s.store.create_handoff(session_id, req)?;
    tracing::info!(handoff_id = %handoff.id, %session_id, kind = ?handoff.kind, "handoff created");
    let respond_path = respond_path(handoff.id);
    Ok((
        StatusCode::CREATED,
        Json(CreateHandoffResponse {
            handoff,
            response_token,
            respond_path,
        }),
    ))
}

#[derive(Deserialize)]
struct ListQuery {
    session_id: Option<Uuid>,
    #[serde(default)]
    pending: bool,
}

#[utoipa::path(
    get,
    path = "/v1/handoffs",
    tag = "handoffs",
    params(("session_id" = Option<Uuid>, Query,), ("pending" = Option<bool>, Query,)),
    responses((status = 200, body = HandoffList), (status = 401, description = "Missing or invalid token"), (status = 403, description = "Token not allowed here"))
)]
async fn list(State(s): State<ApiState>, Query(q): Query<ListQuery>) -> impl IntoResponse {
    Json(serde_json::json!({ "handoffs": s.store.list_handoffs(q.session_id, q.pending) }))
}

#[derive(Deserialize)]
struct WaitQuery {
    wait_ms: Option<u64>,
}

#[utoipa::path(
    get,
    path = "/v1/handoffs/{id}",
    tag = "handoffs",
    params(("id" = Uuid, Path,), ("wait_ms" = Option<u64>, Query,)),
    responses((status = 200, body = HandoffView), (status = 404, description = "Unknown handoff"), (status = 401, description = "Missing or invalid token"), (status = 403, description = "Token not allowed here"))
)]
async fn read(
    State(s): State<ApiState>,
    Path(id): Path<Uuid>,
    Query(q): Query<WaitQuery>,
) -> Result<Json<HandoffView>, AppError> {
    Ok(Json(match q.wait_ms {
        Some(ms) if ms > 0 => {
            s.store
                .wait_handoff(id, Duration::from_millis(ms).min(MAX_HANDOFF_WAIT))
                .await?
        }
        _ => s.store.get_handoff(id)?,
    }))
}

#[utoipa::path(
    post,
    path = "/v1/handoffs/{id}/claim",
    tag = "handoffs",
    params(("id" = Uuid, Path,)),
    description = "Deprecated: returns a `secret` answer to the caller, once. Use a `type_secret` action (`POST /v1/sessions/{id}/actions`) instead: the control plane types the secret into the page and never returns it. Operator and service tokens only.",
    responses((status = 200, body = ClaimedHandoffValue), (status = 404, description = "Unknown handoff"), (status = 409, description = "`secret_unavailable`: not answered yet, already used, erased or expired"), (status = 422, description = "`handoff_not_secret`"), (status = 401, description = "Missing or invalid token"), (status = 403, description = "Token not allowed here"))
)]
#[deprecated(note = "use a type_secret action; it never returns the secret")]
async fn claim(
    State(s): State<ApiState>,
    Extension(p): Extension<Principal>,
    Path(id): Path<Uuid>,
) -> Result<Response, AppError> {
    // The client router already admits only operator and service tokens;
    // keep the check here so a routing change cannot widen it.
    if !p.is_client() {
        return Err(AppError(
            StatusCode::FORBIDDEN,
            "forbidden",
            "only operator and service tokens may claim a secret".into(),
        ));
    }
    let value = s.store.claim_handoff_secret(id)?;
    tracing::warn!(handoff_id = %id, "handoff secret claimed through the deprecated claim route");
    let mut resp = Json(ClaimedHandoffValue { value }).into_response();
    let h = resp.headers_mut();
    h.insert("deprecation", HeaderValue::from_static("true"));
    h.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    Ok(resp)
}

#[utoipa::path(
    post,
    path = "/v1/handoffs/{id}/cancel",
    tag = "handoffs",
    params(("id" = Uuid, Path,)),
    responses((status = 200, body = HandoffView), (status = 409, description = "Already resolved"), (status = 401, description = "Missing or invalid token"), (status = 403, description = "Token not allowed here"))
)]
async fn cancel(
    State(s): State<ApiState>,
    Extension(p): Extension<Principal>,
    Path(id): Path<Uuid>,
) -> Result<Json<HandoffView>, AppError> {
    let name = service_name(&s, p);
    Ok(Json(s.store.respond_handoff(
        id,
        responder_for(p, name.as_deref()).unwrap_or(Responder::Operator),
        RespondHandoffRequest {
            outcome: HandoffOutcome::Cancelled,
            channel: Some("api".into()),
            ..Default::default()
        },
    )?))
}

/// Name of a service principal's token (its id if it was just revoked).
fn service_name(s: &ApiState, p: Principal) -> Option<String> {
    match p {
        Principal::Service(id) => Some(
            s.credentials
                .service_token_name(id)
                .unwrap_or_else(|| id.to_string()),
        ),
        _ => None,
    }
}

/// The responder for an authenticated client principal.
fn responder_for(p: Principal, service_name: Option<&str>) -> Option<Responder<'_>> {
    match p {
        Principal::Operator => Some(Responder::Operator),
        Principal::Service(_) => Some(Responder::Service(service_name.unwrap_or_default())),
        Principal::Host(_) => None,
    }
}

fn bearer(headers: &HeaderMap) -> Option<&str> {
    headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
}

/// An HTML form submission: `token`, `outcome`, `value`, and `values`
/// repeated once per checked box.
#[derive(Default)]
struct FormBody {
    token: Option<String>,
    outcome: Option<String>,
    value: Option<String>,
    values: Vec<String>,
}

impl FormBody {
    fn parse(body: &[u8]) -> Self {
        let mut f = FormBody::default();
        for (k, v) in url::form_urlencoded::parse(body) {
            let v = v.into_owned();
            match k.as_ref() {
                "token" => f.token = Some(v),
                "outcome" => f.outcome = Some(v),
                "value" => f.value = Some(v),
                "values" => f.values.push(v),
                _ => {}
            }
        }
        f
    }
}

/// `POST /v1/handoffs/{id}/respond` — JSON (`RespondHandoffRequest`) or an
/// HTML form submission.
#[utoipa::path(
    post,
    path = "/v1/handoffs/{id}/respond",
    tag = "handoffs",
    params(("id" = Uuid, Path,)),
    request_body(content = RespondHandoffRequest, description = "JSON with the response token (`response_token` or the `X-Hexactra-Response-Token` header) or an operator or service token (`Authorization: Bearer`), or an HTML form with `token`, `outcome`, `value` and `values` (repeated)"),
    security(()),
    responses((status = 200, body = HandoffView), (status = 403, description = "Invalid or used token"), (status = 409, description = "Already resolved"))
)]
async fn respond(
    State(s): State<ApiState>,
    Path(id): Path<Uuid>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let is_form = headers
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .map(|v| v.starts_with("application/x-www-form-urlencoded"))
        .unwrap_or(false);

    let (req, token) = if is_form {
        let f = FormBody::parse(&body);
        let outcome = if f.outcome.as_deref() == Some("cancelled") {
            HandoffOutcome::Cancelled
        } else {
            HandoffOutcome::Completed
        };
        (
            RespondHandoffRequest {
                outcome,
                value: f.value,
                values: Some(f.values),
                response_token: None,
                channel: Some("web-form".into()),
                answered_by: None,
            },
            f.token,
        )
    } else {
        match serde_json::from_slice::<RespondHandoffRequest>(&body) {
            Ok(r) => {
                let t = r.response_token.clone().or_else(|| {
                    headers
                        .get(RESPONSE_TOKEN_HEADER)
                        .and_then(|v| v.to_str().ok())
                        .map(str::to_string)
                });
                (r, t)
            }
            Err(e) => {
                return AppError(StatusCode::BAD_REQUEST, "invalid_request", e.to_string())
                    .into_response()
            }
        }
    };

    let principal = bearer(&headers)
        .and_then(|b| s.principal(b))
        .filter(|p| p.is_client());
    let name = principal.and_then(|p| service_name(&s, p));
    let responder = match (
        principal.and_then(|p| responder_for(p, name.as_deref())),
        token.as_deref(),
    ) {
        (Some(r), _) => r,
        (_, Some(t)) => Responder::Token(t),
        _ => {
            let e = AppError(
                StatusCode::UNAUTHORIZED,
                "unauthorized",
                "send the API token or the handoff's response token".into(),
            );
            return if is_form {
                page(StatusCode::UNAUTHORIZED, "Not authorized", &e.2)
            } else {
                e.into_response()
            };
        }
    };

    match s.store.respond_handoff(id, responder, req) {
        Ok(v) if is_form => {
            let msg = if v.status == HandoffStatus::Cancelled {
                "Cancelled. The agent has been told to stop."
            } else {
                "Thanks. The agent will continue."
            };
            page(StatusCode::OK, "Done", msg)
        }
        Ok(v) => Json(v).into_response(),
        Err(e) => {
            let e = AppError::from(e);
            if is_form {
                page(e.0, "Could not submit", &e.2)
            } else {
                e.into_response()
            }
        }
    }
}

#[derive(Deserialize)]
struct FormQuery {
    token: Option<String>,
}

/// `GET /v1/handoffs/{id}/respond?token=` — a minimal page for link channels.
#[utoipa::path(
    get,
    path = "/v1/handoffs/{id}/respond",
    tag = "handoffs",
    params(("id" = Uuid, Path,), ("token" = String, Query, description = "The handoff response token")),
    security(()),
    responses((status = 200, description = "Answer page", content_type = "text/html", body = String), (status = 401, description = "Missing token"), (status = 403, description = "Invalid or used token"))
)]
async fn form(
    State(s): State<ApiState>,
    Path(id): Path<Uuid>,
    Query(q): Query<FormQuery>,
) -> Response {
    let Some(token) = q.token else {
        return page(
            StatusCode::UNAUTHORIZED,
            "Link incomplete",
            "This link is missing its token.",
        );
    };
    let h = match s.store.check_handoff_token(id, &token) {
        Ok(h) => h,
        Err(_) => {
            return page(
                StatusCode::FORBIDDEN,
                "Link no longer valid",
                "This request was already answered, cancelled or expired.",
            )
        }
    };
    if h.status != HandoffStatus::Pending {
        return page(
            StatusCode::CONFLICT,
            "Already handled",
            "This request is no longer open.",
        );
    }
    let field = question_field(&h);
    let page_info = h
        .page
        .as_ref()
        .map(|p| {
            format!(
                "<p class=muted>Page: {} {}</p>",
                esc(p.title.as_deref().unwrap_or("")),
                esc(p.url.as_deref().unwrap_or(""))
            )
        })
        .unwrap_or_default();
    let viewer = h
        .viewer_url
        .as_deref()
        .map(|u| {
            format!(
                r#"<p><a href="{0}" target="_blank" rel="noopener noreferrer">Open the remote browser</a> to do this, then come back here.</p>"#,
                esc(u)
            )
        })
        .unwrap_or_default();
    let buttons = match h.input {
        HandoffInput::Confirm => {
            let approve = esc(h.confirm_label.as_deref().unwrap_or("Approve"));
            let deny = esc(h.deny_label.as_deref().unwrap_or("Deny"));
            let class = if h.risk == Some(HandoffRisk::Low) {
                ""
            } else {
                " class=danger"
            };
            format!(
                r#"<button name="value" value="approve"{class}>{approve}</button>
<button name="value" value="deny">{deny}</button>"#
            )
        }
        HandoffInput::None | HandoffInput::Takeover => {
            r#"<button name="outcome" value="completed">Done</button>"#.into()
        }
        _ => r#"<button name="outcome" value="completed">Submit</button>"#.into(),
    };
    let takeover = if h.input == HandoffInput::Takeover {
        "<p>Take over the browser, finish this step yourself, then press Done.</p>"
    } else {
        ""
    };
    let body = format!(
        r#"<p class=kind>{kind:?} · expires {expires}</p>
<p class=prompt>{prompt}</p>{page_info}{viewer}{takeover}
<form method="post" action="respond">
<input type="hidden" name="token" value="{token}">
{field}
<div class=row>{buttons}
<button name="outcome" value="cancelled" class=secondary formnovalidate>Cancel the task</button></div>
</form>"#,
        kind = h.kind,
        expires = h.expires_at.format("%H:%M UTC"),
        prompt = esc(&h.prompt),
        token = esc(&token),
    );
    html(StatusCode::OK, "Hexactra needs you", &body)
}

/// Format a number constraint for an HTML attribute.
fn num(v: f64) -> String {
    format!("{v}")
}

/// The answer field for a handoff's question (plain HTML, no script).
fn question_field(h: &HandoffView) -> String {
    let c = &h.constraints;
    let max_length = c.text_max_length();
    match h.input {
        HandoffInput::None | HandoffInput::Takeover | HandoffInput::Confirm => String::new(),
        HandoffInput::Text => {
            if c.multiline == Some(true) {
                format!(
                    r#"<label>Your answer<textarea name="value" required maxlength="{max_length}" rows="5" autocomplete="off"></textarea></label>"#
                )
            } else {
                let pattern = c
                    .pattern
                    .as_deref()
                    .map(|p| {
                        format!(
                            r#" pattern="{}" title="Answer in the required format""#,
                            esc(p)
                        )
                    })
                    .unwrap_or_default();
                format!(
                    r#"<label>Your answer<input name="value" required maxlength="{max_length}"{pattern} autocomplete="off"></label>"#
                )
            }
        }
        HandoffInput::Secret => format!(
            r#"<label>Code<input name="value" type="password" required maxlength="{max_length}" autocomplete="one-time-code" inputmode="text"></label>"#
        ),
        HandoffInput::Number => {
            let mut attrs = String::new();
            if let Some(v) = c.min {
                attrs.push_str(&format!(r#" min="{}""#, num(v)));
            }
            if let Some(v) = c.max {
                attrs.push_str(&format!(r#" max="{}""#, num(v)));
            }
            let step = c.step.map(num).unwrap_or_else(|| "any".into());
            let unit = c
                .unit
                .as_deref()
                .map(|u| format!(" ({})", esc(u)))
                .unwrap_or_default();
            format!(
                r#"<label>Your answer{unit}<input name="value" type="number" required step="{step}"{attrs} inputmode="decimal" autocomplete="off"></label>"#
            )
        }
        HandoffInput::Choice | HandoffInput::MultiChoice => {
            let multi = h.input == HandoffInput::MultiChoice;
            let (kind, name) = if multi {
                ("checkbox", "values")
            } else {
                ("radio", "value")
            };
            let opts: String = h
                .choices
                .iter()
                .enumerate()
                .map(|(i, o)| {
                    let required = if !multi && i == 0 { " required" } else { "" };
                    let desc = o
                        .description
                        .as_deref()
                        .map(|d| format!("<span class=muted>{}</span>", esc(d)))
                        .unwrap_or_default();
                    format!(
                        r#"<label class=opt><input type="{kind}" name="{name}" value="{id}"{required}><span>{label}{desc}</span></label>"#,
                        id = esc(&o.id),
                        label = esc(&o.label),
                    )
                })
                .collect();
            let legend = if multi {
                let (min, max) = c.selection_bounds(h.choices.len());
                if min == max {
                    format!("Choose {min}")
                } else {
                    format!("Choose {min} to {max}")
                }
            } else {
                "Choose one".into()
            };
            format!("<fieldset><legend>{legend}</legend>{opts}</fieldset>")
        }
    }
}

fn esc(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#39;"),
            _ => out.push(c),
        }
    }
    out
}

fn page(status: StatusCode, title: &str, message: &str) -> Response {
    html(status, title, &format!("<p>{}</p>", esc(message)))
}

fn html(status: StatusCode, title: &str, body: &str) -> Response {
    let doc = format!(
        r#"<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>{title}</title>
<style>
body{{font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:2rem auto;padding:0 1rem;color:#1b1b1b;background:#fff}}
@media (prefers-color-scheme:dark){{body{{color:#eee;background:#161616}}input,select,textarea{{background:#222;color:#eee}}}}
h1{{font-size:1.3rem}}.prompt{{font-size:1.1rem}}.muted,.kind{{color:#777;font-size:.9rem;word-break:break-all}}
label{{display:block;margin:1rem 0}}input,select,textarea{{display:block;width:100%;padding:.6rem;font-size:1rem;margin-top:.3rem;box-sizing:border-box;font-family:inherit}}
fieldset{{border:0;padding:0;margin:1rem 0}}legend{{padding:0}}label.opt{{display:flex;gap:.6rem;align-items:flex-start;margin:.6rem 0}}
label.opt input{{width:auto;margin:.3rem 0 0}}label.opt .muted{{display:block}}
.row{{display:flex;gap:.5rem;flex-wrap:wrap}}button{{padding:.6rem 1rem;font-size:1rem;border:0;border-radius:6px;background:#1a5fd0;color:#fff}}
button.secondary{{background:#777}}button.danger{{background:#b3261e}}
</style></head><body><h1>{title}</h1>{body}</body></html>"#,
        title = esc(title),
    );
    let mut resp = (status, Html(doc)).into_response();
    let h = resp.headers_mut();
    h.insert(
        header::CONTENT_SECURITY_POLICY,
        HeaderValue::from_static(
            "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'",
        ),
    );
    h.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    h.insert(
        header::REFERRER_POLICY,
        HeaderValue::from_static("no-referrer"),
    );
    h.insert(header::X_FRAME_OPTIONS, HeaderValue::from_static("DENY"));
    resp
}

#[cfg(test)]
mod tests {
    use super::esc;

    #[test]
    fn escapes_html() {
        assert_eq!(
            esc(r#"<script>alert("x")</script>&'"#),
            "&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;&amp;&#39;"
        );
    }
}
