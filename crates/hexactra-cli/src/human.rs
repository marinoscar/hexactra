//! `hexactra-fabric handoff ...` and `hexactra-fabric webhook ...` (#191).

use std::time::Duration;

use anyhow::{bail, Result};
use clap::{Subcommand, ValueEnum};
use hexactra_client::ControlClient;
use hexactra_core::remote::{
    CreateHandoffRequest, CreateWebhookRequest, HandoffChoice, HandoffChoiceSpec,
    HandoffConstraints, HandoffInput, HandoffKind, HandoffOutcome, HandoffRisk, HandoffStatus,
    HandoffView, OperationState, RemoteAction, RespondHandoffRequest,
};
use uuid::Uuid;

#[derive(Debug, Clone, Copy, ValueEnum)]
pub enum KindArg {
    Captcha,
    Code,
    Passkey,
    Login,
    Confirmation,
    Other,
}

impl From<KindArg> for HandoffKind {
    fn from(k: KindArg) -> Self {
        match k {
            KindArg::Captcha => HandoffKind::Captcha,
            KindArg::Code => HandoffKind::Code,
            KindArg::Passkey => HandoffKind::Passkey,
            KindArg::Login => HandoffKind::Login,
            KindArg::Confirmation => HandoffKind::Confirmation,
            KindArg::Other => HandoffKind::Other,
        }
    }
}

#[derive(Debug, Clone, Copy, ValueEnum)]
pub enum InputArg {
    None,
    Text,
    Secret,
    Choice,
    #[value(alias = "multi_choice")]
    MultiChoice,
    Number,
    Confirm,
    Takeover,
}

impl From<InputArg> for HandoffInput {
    fn from(i: InputArg) -> Self {
        match i {
            InputArg::None => HandoffInput::None,
            InputArg::Text => HandoffInput::Text,
            InputArg::Secret => HandoffInput::Secret,
            InputArg::Choice => HandoffInput::Choice,
            InputArg::MultiChoice => HandoffInput::MultiChoice,
            InputArg::Number => HandoffInput::Number,
            InputArg::Confirm => HandoffInput::Confirm,
            InputArg::Takeover => HandoffInput::Takeover,
        }
    }
}

#[derive(Debug, Clone, Copy, ValueEnum)]
pub enum RiskArg {
    Low,
    High,
}

impl From<RiskArg> for HandoffRisk {
    fn from(r: RiskArg) -> Self {
        match r {
            RiskArg::Low => HandoffRisk::Low,
            RiskArg::High => HandoffRisk::High,
        }
    }
}

/// `--choice` value: `id=label` when the part before `=` is a valid option
/// id, else the whole string (used as both id and label).
fn parse_choice(s: &str) -> HandoffChoiceSpec {
    match s.split_once('=') {
        Some((id, label))
            if !label.trim().is_empty()
                && (1..=64).contains(&id.len())
                && id
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-') =>
        {
            HandoffChoice {
                id: id.into(),
                label: label.into(),
                description: None,
            }
            .into()
        }
        _ => s.into(),
    }
}

/// Answer bounds for `handoff request`; the server rejects any that do
/// not apply to `--input`.
#[derive(clap::Args, Debug, Clone, Default)]
pub struct ConstraintArgs {
    /// text/secret: longest answer in characters (1-4096).
    #[arg(long)]
    max_length: Option<u32>,
    /// text: regex the whole answer must match.
    #[arg(long)]
    pattern: Option<String>,
    /// text: multi-line answer (`--multiline false` rejects newlines).
    #[arg(long, num_args = 0..=1, default_missing_value = "true")]
    multiline: Option<bool>,
    /// number: smallest value.
    #[arg(long, allow_negative_numbers = true)]
    min: Option<f64>,
    /// number: largest value.
    #[arg(long, allow_negative_numbers = true)]
    max: Option<f64>,
    /// number: the answer must be min (or 0) plus a multiple of this.
    #[arg(long)]
    step: Option<f64>,
    /// number: unit shown next to the field.
    #[arg(long)]
    unit: Option<String>,
    /// multi-choice: fewest options to select (default 1).
    #[arg(long)]
    min_selections: Option<u32>,
    /// multi-choice: most options to select (default all).
    #[arg(long)]
    max_selections: Option<u32>,
}

impl From<ConstraintArgs> for HandoffConstraints {
    fn from(a: ConstraintArgs) -> Self {
        HandoffConstraints {
            max_length: a.max_length,
            pattern: a.pattern,
            multiline: a.multiline,
            min: a.min,
            max: a.max,
            step: a.step,
            unit: a.unit,
            min_selections: a.min_selections,
            max_selections: a.max_selections,
        }
    }
}

#[derive(Subcommand, Debug, Clone)]
pub enum HandoffCmd {
    /// Pause the current session and ask a person for help.
    Request {
        #[arg(long, value_enum, default_value = "other")]
        kind: KindArg,
        /// What the person should do.
        #[arg(long)]
        prompt: String,
        #[arg(long, value_enum, default_value = "none")]
        input: InputArg,
        /// An option for --input choice or multi-choice (repeat); `id=label`
        /// gives the option its own id.
        #[arg(long = "choice")]
        choices: Vec<String>,
        #[command(flatten)]
        constraints: ConstraintArgs,
        /// confirm: label of the approve button.
        #[arg(long)]
        confirm_label: Option<String>,
        /// confirm: label of the deny button.
        #[arg(long)]
        deny_label: Option<String>,
        /// confirm: how risky approving is (default high).
        #[arg(long, value_enum)]
        risk: Option<RiskArg>,
        /// How long to wait for a person, in seconds.
        #[arg(long, default_value_t = 600)]
        timeout_s: u64,
        /// Wait for the answer and print it.
        #[arg(long)]
        wait: bool,
    },
    /// List handoffs (pending only unless --all).
    List {
        #[arg(long)]
        all: bool,
    },
    /// Show a handoff, optionally waiting for it to resolve.
    Show {
        id: Uuid,
        #[arg(long, default_value_t = 0)]
        wait_s: u64,
    },
    /// Answer a handoff as the operator.
    Respond {
        id: Uuid,
        /// The answer (text, secret, choice id, number, approve/deny).
        #[arg(long, allow_hyphen_values = true)]
        value: Option<String>,
        /// A selected option id for multi-choice (repeat).
        #[arg(long = "values", conflicts_with = "value")]
        values: Vec<String>,
        /// Who answered, recorded as the response's `by` (e.g. user:42).
        #[arg(long)]
        answered_by: Option<String>,
    },
    /// Cancel a handoff.
    Cancel { id: Uuid },
    /// Type a secret handoff's answer into the page of the handoff's
    /// session. The control plane types it; it is never shown here, and it
    /// can be used once.
    TypeSecret {
        id: Uuid,
        /// CSS selector of the field.
        #[arg(long)]
        selector: String,
        /// Replace the field's current value.
        #[arg(long)]
        clear: bool,
        /// Submit (Enter) after typing.
        #[arg(long)]
        submit: bool,
        #[arg(long)]
        tab: Option<i64>,
    },
}

#[derive(Subcommand, Debug, Clone)]
pub enum WebhookCmd {
    /// Register a channel endpoint. Prints the signing secret once.
    Add {
        url: String,
        /// Event filter (repeat): handoff.*, handoff.created, ..., *.
        #[arg(long = "event")]
        events: Vec<String>,
        #[arg(long)]
        description: Option<String>,
    },
    /// List endpoints.
    List,
    /// Remove an endpoint.
    Remove { id: Uuid },
    /// Send a test event.
    Test { id: Uuid },
    /// Show recent delivery attempts.
    Deliveries { id: Uuid },
}

fn print_json<T: serde::Serialize>(v: &T) -> Result<()> {
    println!("{}", serde_json::to_string_pretty(v)?);
    Ok(())
}

fn summary(h: &HandoffView) -> String {
    format!("{}\t{:?}\t{:?}\t{}", h.id, h.status, h.kind, h.prompt)
}

/// Wait in long-poll chunks until the handoff resolves or `total` passes.
async fn wait_resolved(client: &ControlClient, id: Uuid, total: Duration) -> Result<HandoffView> {
    let end = tokio::time::Instant::now() + total;
    loop {
        let left = end.saturating_duration_since(tokio::time::Instant::now());
        let chunk = left.min(Duration::from_secs(110));
        let h = client.handoff(id, Some(chunk)).await?;
        if h.status != HandoffStatus::Pending || left.is_zero() {
            return Ok(h);
        }
    }
}

/// Hint printed where a secret answer would be.
fn secret_hint(id: Uuid) -> String {
    format!(
        "value: (secret; type it with `hexactra-fabric handoff type-secret {id} --selector <css>`)"
    )
}

/// Print the outcome. A secret answer is never printed (#287).
fn report(h: &HandoffView, json: bool) -> Result<()> {
    if json {
        return print_json(&serde_json::json!({ "handoff": h }));
    }
    let value = h
        .response
        .as_ref()
        .and_then(|r| r.value.clone())
        .or_else(|| {
            h.response
                .as_ref()
                .and_then(|r| r.values.as_ref())
                .map(|v| v.join("\n"))
        });
    let channel = h
        .response
        .as_ref()
        .and_then(|r| r.channel.clone())
        .unwrap_or_default();
    match h.status {
        HandoffStatus::Completed => {
            println!(
                "completed{}",
                if channel.is_empty() {
                    String::new()
                } else {
                    format!(" via {channel}")
                }
            );
            if let Some(v) = value {
                println!("{v}");
            }
            if h.response.as_ref().is_some_and(|r| r.value_withheld) {
                println!("{}", secret_hint(h.id));
            }
            Ok(())
        }
        HandoffStatus::Pending => bail!("still waiting for a person (handoff {})", h.id),
        other => bail!("handoff {:?}", other),
    }
}

pub async fn handoff(
    cmd: HandoffCmd,
    client: &ControlClient,
    session: impl std::future::Future<Output = Result<Uuid>>,
    json: bool,
) -> Result<()> {
    match cmd {
        HandoffCmd::Request {
            kind,
            prompt,
            input,
            choices,
            constraints,
            confirm_label,
            deny_label,
            risk,
            timeout_s,
            wait,
        } => {
            let session = session.await?;
            let created = client
                .create_handoff(
                    session,
                    &CreateHandoffRequest {
                        kind: kind.into(),
                        prompt,
                        input: input.into(),
                        choices: choices.iter().map(|c| parse_choice(c)).collect(),
                        constraints: constraints.into(),
                        confirm_label,
                        deny_label,
                        risk: risk.map(Into::into),
                        timeout_ms: Some(timeout_s * 1000),
                        page: None,
                    },
                )
                .await?;
            if !wait {
                if json {
                    return print_json(&created);
                }
                println!("{}", created.handoff.id);
                eprintln!(
                    "respond with: {}?token={}",
                    created.respond_path, created.response_token
                );
                return Ok(());
            }
            eprintln!("waiting for a person (handoff {})...", created.handoff.id);
            let h = wait_resolved(
                client,
                created.handoff.id,
                Duration::from_secs(timeout_s + 5),
            )
            .await?;
            report(&h, json)
        }
        HandoffCmd::List { all } => {
            let list = client.handoffs(!all).await?;
            if json {
                return print_json(&list);
            }
            for h in list {
                println!("{}", summary(&h));
            }
            Ok(())
        }
        HandoffCmd::Show { id, wait_s } => {
            let h = if wait_s > 0 {
                wait_resolved(client, id, Duration::from_secs(wait_s)).await?
            } else {
                client.handoff(id, None).await?
            };
            if json {
                return print_json(&h);
            }
            println!("{}", summary(&h));
            if let Some(r) = &h.response {
                if let Some(v) = &r.value {
                    println!("value: {v}");
                }
                if let Some(v) = &r.values {
                    println!("values: {}", v.join(", "));
                }
                if let Some(by) = &r.by {
                    println!("by: {by}");
                }
                if r.value_withheld {
                    println!("{}", secret_hint(h.id));
                }
            }
            Ok(())
        }
        HandoffCmd::Respond {
            id,
            value,
            values,
            answered_by,
        } => {
            let h = client
                .respond_handoff(
                    id,
                    &RespondHandoffRequest {
                        outcome: HandoffOutcome::Completed,
                        value,
                        values: (!values.is_empty()).then_some(values),
                        answered_by,
                        channel: Some("cli".into()),
                        ..Default::default()
                    },
                )
                .await?;
            if json {
                return print_json(&h);
            }
            println!("{}", summary(&h));
            Ok(())
        }
        HandoffCmd::Cancel { id } => {
            let h = client.cancel_handoff(id).await?;
            if json {
                return print_json(&h);
            }
            println!("{}", summary(&h));
            Ok(())
        }
        HandoffCmd::TypeSecret {
            id,
            selector,
            clear,
            submit,
            tab,
        } => {
            // The handoff names its session; the secret is typed there.
            let session = client.handoff(id, None).await?.session_id;
            let op = client
                .act(
                    session,
                    RemoteAction::TypeSecret {
                        handoff_id: id,
                        selector,
                        clear,
                        submit,
                        tab_id: tab,
                    },
                    Some(Duration::from_secs(45)),
                )
                .await?;
            if json {
                return print_json(&op);
            }
            if op.state != OperationState::Succeeded {
                bail!(
                    "type_secret {:?}: {}",
                    op.state,
                    op.error.unwrap_or_default()
                );
            }
            println!("typed the secret ({})", op.id);
            Ok(())
        }
    }
}

pub async fn webhook(cmd: WebhookCmd, client: &ControlClient, json: bool) -> Result<()> {
    match cmd {
        WebhookCmd::Add {
            url,
            events,
            description,
        } => {
            let created = client
                .add_webhook(&CreateWebhookRequest {
                    url,
                    events,
                    description,
                })
                .await?;
            if json {
                return print_json(&created);
            }
            println!("id:     {}", created.webhook.id);
            println!("events: {}", created.webhook.events.join(", "));
            println!("secret: {}", created.secret);
            eprintln!(
                "Save the secret now; it is not shown again. Use it to verify webhook-signature."
            );
            Ok(())
        }
        WebhookCmd::List => {
            let list = client.webhooks().await?;
            if json {
                return print_json(&list);
            }
            for w in list {
                println!(
                    "{}\t{}\t{}\t{}",
                    w.id,
                    w.url,
                    w.events.join(","),
                    w.description.unwrap_or_default()
                );
            }
            Ok(())
        }
        WebhookCmd::Remove { id } => {
            client.remove_webhook(id).await?;
            if !json {
                println!("removed {id}");
            }
            Ok(())
        }
        WebhookCmd::Test { id } => {
            let ev = client.test_webhook(id).await?;
            if json {
                return print_json(&serde_json::json!({ "event_id": ev }));
            }
            println!("sent {ev}; check `hexactra-fabric webhook deliveries {id}`");
            Ok(())
        }
        WebhookCmd::Deliveries { id } => {
            let list = client.webhook_deliveries(id).await?;
            if json {
                return print_json(&list);
            }
            for d in list {
                println!(
                    "{}\t{}\t#{}\t{}\t{}\t{}",
                    d.at.format("%H:%M:%S"),
                    d.event_type,
                    d.attempt,
                    d.outcome,
                    d.http_status.map(|s| s.to_string()).unwrap_or_default(),
                    d.error.unwrap_or_default()
                );
            }
            Ok(())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn choice_arg_forms() {
        assert_eq!(
            parse_choice("Yes, continue"),
            HandoffChoiceSpec::Label("Yes, continue".into())
        );
        assert_eq!(
            parse_choice("stop=Stop the task"),
            HandoffChoiceSpec::Option(HandoffChoice {
                id: "stop".into(),
                label: "Stop the task".into(),
                description: None,
            })
        );
        // Not a valid id before `=`: the whole string is the option.
        assert_eq!(
            parse_choice("a b=c"),
            HandoffChoiceSpec::Label("a b=c".into())
        );
        assert_eq!(parse_choice("x="), HandoffChoiceSpec::Label("x=".into()));
    }
}
