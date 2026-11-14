//! `hexactra handoff ...` and `hexactra webhook ...` (#191).

use std::time::Duration;

use anyhow::{bail, Result};
use clap::{Subcommand, ValueEnum};
use hexactra_client::ControlClient;
use hexactra_core::remote::{
    CreateHandoffRequest, CreateWebhookRequest, HandoffInput, HandoffKind, HandoffOutcome,
    HandoffStatus, HandoffView, RespondHandoffRequest,
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
}

impl From<InputArg> for HandoffInput {
    fn from(i: InputArg) -> Self {
        match i {
            InputArg::None => HandoffInput::None,
            InputArg::Text => HandoffInput::Text,
            InputArg::Secret => HandoffInput::Secret,
            InputArg::Choice => HandoffInput::Choice,
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
        /// An option for --input choice (repeat).
        #[arg(long = "choice")]
        choices: Vec<String>,
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
        #[arg(long)]
        value: Option<String>,
    },
    /// Cancel a handoff.
    Cancel { id: Uuid },
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

/// Print the outcome; for secrets, claim and print the value.
async fn report(client: &ControlClient, h: &HandoffView, json: bool) -> Result<()> {
    let secret = if h.status == HandoffStatus::Completed && h.input == HandoffInput::Secret {
        Some(client.claim_handoff_secret(h.id).await?)
    } else {
        None
    };
    if json {
        return print_json(&serde_json::json!({ "handoff": h, "secret_value": secret }));
    }
    let value = secret.or_else(|| h.response.as_ref().and_then(|r| r.value.clone()));
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
                        choices,
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
            report(client, &h, json).await
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
                if r.value_withheld {
                    println!("value: (secret; claimed by the requesting agent)");
                }
            }
            Ok(())
        }
        HandoffCmd::Respond { id, value } => {
            let h = client
                .respond_handoff(
                    id,
                    &RespondHandoffRequest {
                        outcome: HandoffOutcome::Completed,
                        value,
                        response_token: None,
                        channel: Some("cli".into()),
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
            println!("sent {ev}; check `hexactra webhook deliveries {id}`");
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
