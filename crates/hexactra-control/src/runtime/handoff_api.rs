//! HTTP routes for human handoffs (#189).
//!
//! Protected (API token): create, list, read/wait, claim a secret, cancel.
//! Public (own auth): `/v1/handoffs/{id}/respond` accepts the API token or the
//! handoff's single-use response token, as JSON or as an HTML form, so any
//! channel (chat bot, automation, emailed link) can answer.

use std::time::Duration;

use axum::{
    body::Bytes,
    extract::{Path, Query, State},
    http::{header, HeaderMap, HeaderValue, StatusCode},
    response::{Html, IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use hexactra_core::remote::{
    ClaimedHandoffValue, CreateHandoffRequest, CreateHandoffResponse, HandoffInput, HandoffOutcome,
    HandoffStatus, HandoffView, RespondHandoffRequest,
};
use serde::Deserialize;
use uuid::Uuid;

use super::api::{ApiState, AppError};
use super::handoff::Responder;

/// Header channels may use to send the response token.
pub const RESPONSE_TOKEN_HEADER: &str = "x-hexactra-response-token";
const MAX_HANDOFF_WAIT: Duration = Duration::from_secs(120);

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

async fn list(State(s): State<ApiState>, Query(q): Query<ListQuery>) -> impl IntoResponse {
    Json(serde_json::json!({ "handoffs": s.store.list_handoffs(q.session_id, q.pending) }))
}

#[derive(Deserialize)]
struct WaitQuery {
    wait_ms: Option<u64>,
}

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

async fn claim(
    State(s): State<ApiState>,
    Path(id): Path<Uuid>,
) -> Result<Json<ClaimedHandoffValue>, AppError> {
    let value = s.store.claim_handoff_secret(id)?;
    tracing::info!(handoff_id = %id, "handoff secret claimed");
    Ok(Json(ClaimedHandoffValue { value }))
}

async fn cancel(
    State(s): State<ApiState>,
    Path(id): Path<Uuid>,
) -> Result<Json<HandoffView>, AppError> {
    Ok(Json(s.store.respond_handoff(
        id,
        Responder::Operator,
        RespondHandoffRequest {
            outcome: HandoffOutcome::Cancelled,
            channel: Some("api".into()),
            ..Default::default()
        },
    )?))
}

fn bearer(headers: &HeaderMap) -> Option<&str> {
    headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
}

#[derive(Deserialize)]
struct FormBody {
    #[serde(default)]
    token: Option<String>,
    #[serde(default)]
    outcome: Option<String>,
    #[serde(default)]
    value: Option<String>,
}

/// `POST /v1/handoffs/{id}/respond` — JSON (`RespondHandoffRequest`) or an
/// HTML form submission.
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
        let f: FormBody = match serde_urlencoded::from_bytes(&body) {
            Ok(f) => f,
            Err(_) => {
                return page(
                    StatusCode::BAD_REQUEST,
                    "Invalid form",
                    "The form could not be read.",
                )
            }
        };
        let outcome = if f.outcome.as_deref() == Some("cancelled") {
            HandoffOutcome::Cancelled
        } else {
            HandoffOutcome::Completed
        };
        (
            RespondHandoffRequest {
                outcome,
                value: f.value,
                response_token: None,
                channel: Some("web-form".into()),
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

    let responder = match (bearer(&headers), token.as_deref()) {
        (Some(b), _) if s.token_matches(b) => Responder::Operator,
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
    let field = match h.input {
        HandoffInput::None => String::new(),
        HandoffInput::Text => {
            r#"<label>Your answer<input name="value" required maxlength="4096" autocomplete="off"></label>"#.into()
        }
        HandoffInput::Secret => {
            r#"<label>Code<input name="value" type="password" required maxlength="4096" autocomplete="one-time-code" inputmode="text"></label>"#.into()
        }
        HandoffInput::Choice => {
            let opts: String = h
                .choices
                .iter()
                .map(|c| format!(r#"<option value="{0}">{0}</option>"#, esc(c)))
                .collect();
            format!(r#"<label>Choose<select name="value" required>{opts}</select></label>"#)
        }
    };
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
    let done_label = if h.input == HandoffInput::None {
        "I've done it"
    } else {
        "Submit"
    };
    let body = format!(
        r#"<p class=kind>{kind:?} · expires {expires}</p>
<p class=prompt>{prompt}</p>{page_info}{viewer}
<form method="post" action="respond">
<input type="hidden" name="token" value="{token}">
{field}
<div class=row><button name="outcome" value="completed">{done_label}</button>
<button name="outcome" value="cancelled" class=secondary formnovalidate>Cancel the task</button></div>
</form>"#,
        kind = h.kind,
        expires = h.expires_at.format("%H:%M UTC"),
        prompt = esc(&h.prompt),
        token = esc(&token),
    );
    html(StatusCode::OK, "Hexactra needs you", &body)
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
@media (prefers-color-scheme:dark){{body{{color:#eee;background:#161616}}input,select{{background:#222;color:#eee}}}}
h1{{font-size:1.3rem}}.prompt{{font-size:1.1rem}}.muted,.kind{{color:#777;font-size:.9rem;word-break:break-all}}
label{{display:block;margin:1rem 0}}input,select{{display:block;width:100%;padding:.6rem;font-size:1rem;margin-top:.3rem;box-sizing:border-box}}
.row{{display:flex;gap:.5rem;flex-wrap:wrap}}button{{padding:.6rem 1rem;font-size:1rem;border:0;border-radius:6px;background:#1a5fd0;color:#fff}}
button.secondary{{background:#777}}
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
