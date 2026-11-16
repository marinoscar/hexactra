//! `hexactra-fabric`: drive a remote browser through the Hexactra control plane.
//!
//! ```text
//! hexactra-fabric status
//! hexactra-fabric navigate https://example.test
//! hexactra-fabric elements
//! hexactra-fabric click 'a[href="/next"]'
//! hexactra-fabric type '#q' 'hello' --submit
//! hexactra-fabric screenshot -o page.jpg
//! ```
//!
//! Session selection: `--session`, then `HEXACTRA_SESSION`, then the session
//! saved by the last `hexactra-fabric session create`; if none exists or it has
//! ended, a new session is created and saved.

mod human;

use std::path::PathBuf;
use std::time::Duration;

use anyhow::{bail, Context, Result};
use clap::{Parser, Subcommand};
use hexactra_client::ControlClient;
use hexactra_core::remote::{
    CreateSessionRequest, HostCommand, HostCommandRequest, OperationState, OperationView,
    RemoteAction, RemoteSessionStatus,
};
use uuid::Uuid;

#[derive(Parser, Debug)]
#[command(
    name = "hexactra-fabric",
    version,
    about = "Drive a remote browser through Hexactra"
)]
struct Cli {
    /// Control plane URL.
    #[arg(
        long = "url",
        global = true,
        env = "HEXACTRA_URL",
        default_value = "http://127.0.0.1:8787"
    )]
    control_url: String,
    /// File holding the API token (default: $XDG_CONFIG_HOME/hexactra/api-token).
    /// `HEXACTRA_API_TOKEN` overrides it.
    #[arg(long, global = true, env = "HEXACTRA_TOKEN_FILE")]
    token_file: Option<PathBuf>,
    /// Session to act in.
    #[arg(long, short = 's', global = true, env = "HEXACTRA_SESSION")]
    session: Option<Uuid>,
    /// Browser profile to act in (default: `default`). Each profile keeps its
    /// own current session.
    #[arg(long, short = 'p', global = true, env = "HEXACTRA_PROFILE")]
    profile: Option<String>,
    /// Print raw JSON.
    #[arg(long, global = true)]
    json: bool,
    /// Action timeout in milliseconds.
    #[arg(long, global = true, default_value_t = 30_000)]
    timeout_ms: u64,

    #[command(subcommand)]
    command: Commands,
}

#[derive(Subcommand, Debug)]
enum Commands {
    /// Control plane health and connected hosts.
    Status,
    /// List hosts.
    Hosts,
    /// Browser profiles on the hosts.
    #[command(subcommand)]
    Profile(ProfileCmd),
    /// Manage a host: drain it, list its commands.
    #[command(subcommand)]
    Host(HostCmd),
    /// Fabric administration: service tokens and host enrollment.
    #[command(subcommand)]
    Admin(AdminCmd),
    /// Manage sessions.
    #[command(subcommand)]
    Session(SessionCmd),
    /// Ask a person for help (CAPTCHA, code, passkey, approval) and get the answer.
    #[command(subcommand)]
    Handoff(human::HandoffCmd),
    /// Manage webhook channels that reach a person when a handoff opens.
    #[command(subcommand)]
    Webhook(human::WebhookCmd),
    /// Open a URL in the current tab.
    Navigate {
        url: String,
        #[arg(long)]
        tab: Option<i64>,
    },
    /// Click the element matching a CSS selector.
    Click {
        selector: String,
        #[arg(long)]
        tab: Option<i64>,
    },
    /// Type text into an element.
    Type {
        selector: String,
        text: String,
        /// Replace the current value.
        #[arg(long)]
        clear: bool,
        /// Submit (Enter) after typing.
        #[arg(long)]
        submit: bool,
        /// The text is a password or code: the control plane reports it as
        /// `[secret]` instead of storing it in the operation.
        #[arg(long)]
        sensitive: bool,
        #[arg(long)]
        tab: Option<i64>,
    },
    /// Press a key (Enter, Escape, Tab, ArrowDown, ...).
    Press {
        key: String,
        #[arg(long)]
        selector: Option<String>,
        #[arg(long)]
        tab: Option<i64>,
    },
    /// Scroll by a delta or bring an element into view.
    Scroll {
        #[arg(long, default_value_t = 0, allow_hyphen_values = true)]
        dx: i64,
        #[arg(long, default_value_t = 600, allow_hyphen_values = true)]
        dy: i64,
        #[arg(long)]
        selector: Option<String>,
        #[arg(long)]
        tab: Option<i64>,
    },
    /// Save a screenshot of the visible tab (JPEG).
    Screenshot {
        /// Output file (default: screenshot-<time>.jpg).
        #[arg(short, long)]
        output: Option<PathBuf>,
        #[arg(long)]
        tab: Option<i64>,
    },
    /// Print the visible text of the page or an element.
    Text {
        #[arg(long)]
        selector: Option<String>,
        #[arg(long)]
        max_chars: Option<usize>,
        #[arg(long)]
        tab: Option<i64>,
    },
    /// List interactive elements with selectors to use in other commands.
    Elements {
        #[arg(long)]
        max: Option<usize>,
        #[arg(long)]
        tab: Option<i64>,
    },
    /// Wait until an element exists.
    WaitFor {
        selector: String,
        #[arg(long, default_value_t = 10_000)]
        wait_ms: u64,
        #[arg(long)]
        tab: Option<i64>,
    },
    /// List open tabs.
    Tabs,
    /// Open a new tab.
    NewTab { url: Option<String> },
    /// Activate a tab.
    ActivateTab { tab_id: i64 },
    /// Close a tab.
    CloseTab { tab_id: i64 },
    /// History back.
    Back {
        #[arg(long)]
        tab: Option<i64>,
    },
    /// History forward.
    Forward {
        #[arg(long)]
        tab: Option<i64>,
    },
    /// Reload.
    Reload {
        #[arg(long)]
        tab: Option<i64>,
    },
    /// Print version.
    Version,
}

#[derive(Subcommand, Debug)]
enum ProfileCmd {
    /// List profiles per host (* = browser running). Create one with
    /// `hexactra-fabric --profile NAME session create --create`.
    List,
    /// Create an empty (signed-out) profile on a launch-mode host.
    Create {
        name: String,
        #[arg(long)]
        host: Option<Uuid>,
    },
    /// Close the profile's browser and delete the profile (its cookies and
    /// sign-ins). Needs --yes.
    Delete {
        name: String,
        #[arg(long)]
        host: Option<Uuid>,
        #[arg(long)]
        yes: bool,
    },
    /// Close the profile's browser (it starts again on the next action).
    Close {
        name: String,
        #[arg(long)]
        host: Option<Uuid>,
    },
    /// Close the profile's browser and start it again.
    Restart {
        name: String,
        #[arg(long)]
        host: Option<Uuid>,
    },
}

#[derive(Subcommand, Debug)]
enum AdminCmd {
    /// Create a service token (hxs_…) for a client such as the console.
    /// Needs the operator token. The token is printed once.
    ServiceTokenCreate { name: String },
    /// List service tokens (never the tokens themselves).
    ServiceTokenList,
    /// Revoke a service token.
    ServiceTokenRevoke { id: Uuid },
    /// Create a single-use host enrollment token (hxe_…) and print the agent command.
    Enroll {
        /// Name for the new host.
        #[arg(long)]
        name: Option<String>,
        /// Minutes the token stays valid (default 60).
        #[arg(long)]
        ttl_minutes: Option<u64>,
    },
    /// Revoke a host's credential and remove it (its sessions end).
    RevokeHost { id: Uuid },
}

#[derive(Subcommand, Debug)]
enum HostCmd {
    /// Stop placing new sessions on a host (existing sessions keep working).
    Drain { host: Uuid },
    /// Place new sessions on a drained host again.
    Undrain { host: Uuid },
    /// Recent commands sent to a host.
    Commands { host: Uuid },
}

/// Pick the host for a profile command: the one given, else the only
/// online host that has the profile (or, to create one, the only online
/// launch-mode host).
async fn pick_host(
    client: &ControlClient,
    host: Option<Uuid>,
    profile: &str,
    creating: bool,
) -> anyhow::Result<Uuid> {
    if let Some(h) = host {
        return Ok(h);
    }
    let hosts = client.hosts().await?;
    let candidates: Vec<_> = hosts
        .iter()
        .filter(|h| h.online)
        .filter(|h| {
            if creating {
                h.on_demand
            } else {
                h.profiles.iter().any(|p| p == profile)
            }
        })
        .collect();
    match candidates.as_slice() {
        [one] => Ok(one.id),
        [] => anyhow::bail!(
            "no online host {}; pass --host",
            if creating {
                "launches browsers (launch mode)".to_string()
            } else {
                format!("has profile {profile:?}")
            }
        ),
        _ => anyhow::bail!(
            "several hosts match: {}; pass --host",
            candidates
                .iter()
                .map(|h| format!("{} ({})", h.name, h.id))
                .collect::<Vec<_>>()
                .join(", ")
        ),
    }
}

async fn host_command(
    client: &ControlClient,
    host: Uuid,
    command: HostCommand,
    timeout_ms: u64,
    json: bool,
) -> anyhow::Result<()> {
    let v = client
        .host_command(
            host,
            &HostCommandRequest {
                command,
                timeout_ms: Some(timeout_ms.max(60_000)),
            },
        )
        .await?;
    if json {
        print_json(&v)?;
    } else if v.state == OperationState::Succeeded {
        println!("{} done", v.command.kind());
    }
    if v.state != OperationState::Succeeded {
        anyhow::bail!(
            "{} {:?}: {}",
            v.command.kind(),
            v.state,
            v.error.unwrap_or_default()
        );
    }
    Ok(())
}

#[derive(Subcommand, Debug)]
enum SessionCmd {
    /// Create a session on --profile (default `default`) and make it current.
    Create {
        #[arg(long)]
        host: Option<Uuid>,
        #[arg(long)]
        label: Option<String>,
        /// Create the profile if no host has it yet (a new, signed-out browser).
        #[arg(long)]
        create: bool,
    },
    /// List sessions.
    List,
    /// Make an existing session current.
    Use { id: Uuid },
    /// End a session (default: the current one).
    End { id: Option<Uuid> },
}

fn config_dir() -> PathBuf {
    std::env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".config")))
        .unwrap_or_else(|| PathBuf::from("."))
        .join("hexactra")
}

const DEFAULT_PROFILE: &str = hexactra_core::remote::DEFAULT_PROFILE;

impl Cli {
    fn profile(&self) -> &str {
        self.profile.as_deref().unwrap_or(DEFAULT_PROFILE)
    }
}

/// Current session per profile (`current-session` for the default profile).
fn current_session_file(profile: &str) -> PathBuf {
    if profile == DEFAULT_PROFILE {
        config_dir().join("current-session")
    } else {
        config_dir().join(format!("current-session-{profile}"))
    }
}

fn read_token(file: &Option<PathBuf>) -> Result<String> {
    if let Ok(t) = std::env::var("HEXACTRA_API_TOKEN") {
        if !t.trim().is_empty() {
            return Ok(t.trim().to_string());
        }
    }
    let f = file
        .clone()
        .unwrap_or_else(|| config_dir().join("api-token"));
    Ok(std::fs::read_to_string(&f)
        .with_context(|| {
            format!(
                "reading API token from {} (set HEXACTRA_API_TOKEN or --token-file)",
                f.display()
            )
        })?
        .trim()
        .to_string())
}

fn save_current(profile: &str, id: Uuid) {
    let f = current_session_file(profile);
    if let Some(d) = f.parent() {
        let _ = std::fs::create_dir_all(d);
    }
    let _ = std::fs::write(f, format!("{id}\n"));
}

fn profile_summary(h: &hexactra_core::remote::HostView) -> String {
    h.profiles
        .iter()
        .map(|p| {
            if h.running_profiles.contains(p) {
                format!("{p}*")
            } else {
                p.clone()
            }
        })
        .collect::<Vec<_>>()
        .join(", ")
}

async fn resolve_session(cli: &Cli, client: &ControlClient) -> Result<Uuid> {
    if let Some(id) = cli.session {
        return Ok(id);
    }
    let profile = cli.profile();
    if !hexactra_core::remote::valid_profile_name(profile) {
        bail!("invalid profile name {profile:?}: use lowercase letters, digits, '-' and '_'");
    }
    if let Some(id) = std::fs::read_to_string(current_session_file(profile))
        .ok()
        .and_then(|s| s.trim().parse::<Uuid>().ok())
    {
        if let Ok(s) = client.session(id).await {
            if s.status == RemoteSessionStatus::Active && s.profile == profile {
                return Ok(id);
            }
        }
    }
    let s = match client
        .create_session(&CreateSessionRequest {
            label: Some("cli".into()),
            profile: Some(profile.to_string()),
            ..Default::default()
        })
        .await
    {
        Ok(s) => s,
        Err(e) if e.to_string().contains("profile_not_found") => bail!(
            "no host has a profile named {profile:?}. List profiles with `hexactra-fabric profile list`, \
             or create it with `hexactra-fabric --profile {profile} session create --create`"
        ),
        Err(e) => return Err(e).context("creating a session"),
    };
    save_current(profile, s.id);
    eprintln!("started session {} (profile {})", s.id, s.profile);
    Ok(s.id)
}

fn print_json<T: serde::Serialize>(v: &T) -> Result<()> {
    println!("{}", serde_json::to_string_pretty(v)?);
    Ok(())
}

/// Print a finished operation; error if it did not succeed.
fn finish(
    cli: &Cli,
    op: &OperationView,
    text: impl FnOnce(&serde_json::Value) -> String,
) -> Result<()> {
    if cli.json {
        print_json(op)?;
    }
    match op.state {
        OperationState::Succeeded => {
            if !cli.json {
                let out = text(op.result.as_ref().unwrap_or(&serde_json::Value::Null));
                if !out.is_empty() {
                    println!("{out}");
                }
            }
            Ok(())
        }
        state => bail!(
            "{} {:?}: {}",
            op.action.kind(),
            state,
            op.error.as_deref().unwrap_or("no details")
        ),
    }
}

fn ok_text(_: &serde_json::Value) -> String {
    "ok".into()
}

#[tokio::main]
async fn main() {
    if let Err(e) = run().await {
        eprintln!("error: {e:#}");
        std::process::exit(1);
    }
}

async fn run() -> Result<()> {
    let cli = Cli::parse();
    if let Commands::Version = cli.command {
        println!("hexactra-fabric {}", env!("CARGO_PKG_VERSION"));
        return Ok(());
    }
    let client = ControlClient::new(&cli.control_url, &read_token(&cli.token_file)?)?;
    let timeout = Some(Duration::from_millis(cli.timeout_ms));

    let action = match &cli.command {
        Commands::Version => unreachable!(),
        Commands::Status => {
            let health = client.health().await?;
            let hosts = client.hosts().await?;
            if cli.json {
                return print_json(&serde_json::json!({"health": health, "hosts": hosts}));
            }
            println!(
                "control plane {} ({})",
                cli.control_url,
                health["version"].as_str().unwrap_or("?")
            );
            if hosts.is_empty() {
                println!("no hosts registered");
            }
            for h in hosts {
                println!(
                    "host {} {:<20} online={} browser={} on_demand={}{}{}",
                    h.id,
                    h.name,
                    h.online,
                    h.browser_connected,
                    h.on_demand,
                    if h.draining { " draining" } else { "" },
                    h.viewer_url
                        .as_deref()
                        .map(|u| format!(" viewer={u}"))
                        .unwrap_or_default()
                );
                println!("     profiles: {}", profile_summary(&h));
            }
            return Ok(());
        }
        Commands::Profile(ProfileCmd::List) => {
            let hosts = client.hosts().await?;
            if cli.json {
                let v: Vec<_> = hosts
                    .iter()
                    .map(|h| {
                        serde_json::json!({
                            "host_id": h.id, "host": h.name, "online": h.online,
                            "profiles": h.profiles, "running": h.running_profiles,
                        })
                    })
                    .collect();
                return print_json(&v);
            }
            for h in hosts {
                println!(
                    "{} ({}): {}",
                    h.name,
                    if h.online { "online" } else { "offline" },
                    profile_summary(&h)
                );
            }
            return Ok(());
        }
        Commands::Profile(ProfileCmd::Create { name, host }) => {
            let h = pick_host(&client, *host, name, true).await?;
            let c = HostCommand::CreateProfile {
                profile: name.clone(),
            };
            return host_command(&client, h, c, cli.timeout_ms, cli.json).await;
        }
        Commands::Profile(ProfileCmd::Delete { name, host, yes }) => {
            if !yes {
                anyhow::bail!(
                    "deleting profile {name:?} removes its cookies and sign-ins; pass --yes"
                );
            }
            let h = pick_host(&client, *host, name, false).await?;
            let c = HostCommand::DeleteProfile {
                profile: name.clone(),
            };
            return host_command(&client, h, c, cli.timeout_ms, cli.json).await;
        }
        Commands::Profile(ProfileCmd::Close { name, host }) => {
            let h = pick_host(&client, *host, name, false).await?;
            let c = HostCommand::CloseBrowser {
                profile: name.clone(),
            };
            return host_command(&client, h, c, cli.timeout_ms, cli.json).await;
        }
        Commands::Profile(ProfileCmd::Restart { name, host }) => {
            let h = pick_host(&client, *host, name, false).await?;
            let c = HostCommand::RestartBrowser {
                profile: name.clone(),
            };
            return host_command(&client, h, c, cli.timeout_ms, cli.json).await;
        }
        Commands::Host(HostCmd::Drain { host }) => {
            let c = HostCommand::Drain { enabled: true };
            return host_command(&client, *host, c, cli.timeout_ms, cli.json).await;
        }
        Commands::Host(HostCmd::Undrain { host }) => {
            let c = HostCommand::Drain { enabled: false };
            return host_command(&client, *host, c, cli.timeout_ms, cli.json).await;
        }
        Commands::Host(HostCmd::Commands { host }) => {
            let list = client.host_commands(*host).await?;
            if cli.json {
                return print_json(&list);
            }
            for c in list {
                println!(
                    "{}\t{}\t{}\t{:?}\t{}",
                    c.created_at.format("%Y-%m-%d %H:%M:%S"),
                    c.command.kind(),
                    c.command.profile().unwrap_or("-"),
                    c.state,
                    c.error.unwrap_or_default()
                );
            }
            return Ok(());
        }
        Commands::Admin(cmd) => {
            match cmd {
                AdminCmd::ServiceTokenCreate { name } => {
                    let v = client.create_service_token(name).await?;
                    if cli.json {
                        return print_json(&v);
                    }
                    println!("{}", v["token"].as_str().unwrap_or_default());
                    eprintln!("(shown once; store it as the client's service token)");
                }
                AdminCmd::ServiceTokenList => {
                    let v = client.list_service_tokens().await?;
                    if cli.json {
                        return print_json(&v);
                    }
                    for t in v["service_tokens"].as_array().into_iter().flatten() {
                        println!(
                            "{}\t{}\t{}",
                            t["id"].as_str().unwrap_or_default(),
                            t["name"].as_str().unwrap_or_default(),
                            t["created_at"].as_str().unwrap_or_default()
                        );
                    }
                }
                AdminCmd::ServiceTokenRevoke { id } => {
                    client.revoke_service_token(*id).await?;
                    println!("revoked");
                }
                AdminCmd::Enroll { name, ttl_minutes } => {
                    let v = client
                        .create_enrollment(
                            name.as_deref(),
                            ttl_minutes.map(|m| std::time::Duration::from_secs(m * 60)),
                        )
                        .await?;
                    if cli.json {
                        return print_json(&v);
                    }
                    let token = v["enrollment_token"].as_str().unwrap_or_default();
                    let mut cmdline = format!(
                        "hexactra-agent daemon --url {} --enrollment-token {token}",
                        cli.control_url
                    );
                    if let Some(n) = name {
                        cmdline.push_str(&format!(" --name '{}'", n.replace('\'', "")));
                    }
                    println!("{cmdline}");
                }
                AdminCmd::RevokeHost { id } => {
                    client.revoke_host(*id).await?;
                    println!("revoked");
                }
            }
            return Ok(());
        }
        Commands::Hosts => {
            let hosts = client.hosts().await?;
            if cli.json {
                return print_json(&hosts);
            }
            for h in hosts {
                println!(
                    "{}\t{}\tonline={}\tbrowser={}",
                    h.id, h.name, h.online, h.browser_connected
                );
            }
            return Ok(());
        }
        Commands::Handoff(cmd) => {
            return human::handoff(
                cmd.clone(),
                &client,
                resolve_session(&cli, &client),
                cli.json,
            )
            .await;
        }
        Commands::Webhook(cmd) => {
            return human::webhook(cmd.clone(), &client, cli.json).await;
        }
        Commands::Session(cmd) => {
            match cmd {
                SessionCmd::Create {
                    host,
                    label,
                    create,
                } => {
                    let s = client
                        .create_session(&CreateSessionRequest {
                            host_id: *host,
                            label: label.clone(),
                            profile: Some(cli.profile().to_string()),
                            create_profile: *create,
                        })
                        .await?;
                    save_current(&s.profile, s.id);
                    if cli.json {
                        print_json(&s)?;
                    } else {
                        println!("{}", s.id);
                    }
                }
                SessionCmd::List => {
                    let list = client.sessions().await?;
                    if cli.json {
                        print_json(&list)?;
                    } else {
                        for s in list {
                            println!(
                                "{}\t{:?}\tprofile={}\thost={}\t{}",
                                s.id,
                                s.status,
                                s.profile,
                                s.host_id,
                                s.label.unwrap_or_default()
                            );
                        }
                    }
                }
                SessionCmd::Use { id } => {
                    let s = client.session(*id).await?;
                    save_current(&s.profile, *id);
                }
                SessionCmd::End { id } => {
                    let id = match id.or(cli.session) {
                        Some(id) => id,
                        None => std::fs::read_to_string(current_session_file(cli.profile()))
                            .ok()
                            .and_then(|s| s.trim().parse().ok())
                            .context("no current session")?,
                    };
                    client.end_session(id).await?;
                    if !cli.json {
                        println!("ended {id}");
                    }
                }
            }
            return Ok(());
        }
        Commands::Navigate { url, tab } => RemoteAction::Navigate {
            url: url.clone(),
            tab_id: *tab,
        },
        Commands::Click { selector, tab } => RemoteAction::Click {
            selector: selector.clone(),
            tab_id: *tab,
        },
        Commands::Type {
            selector,
            text,
            clear,
            submit,
            sensitive,
            tab,
        } => RemoteAction::Type {
            selector: selector.clone(),
            text: text.clone(),
            clear: *clear,
            submit: *submit,
            sensitive: *sensitive,
            tab_id: *tab,
        },
        Commands::Press { key, selector, tab } => RemoteAction::Press {
            key: key.clone(),
            selector: selector.clone(),
            tab_id: *tab,
        },
        Commands::Scroll {
            dx,
            dy,
            selector,
            tab,
        } => RemoteAction::Scroll {
            dx: *dx,
            dy: *dy,
            selector: selector.clone(),
            tab_id: *tab,
        },
        Commands::Screenshot { tab, .. } => RemoteAction::Screenshot {
            marks: false,
            tab_id: *tab,
        },
        Commands::Text {
            selector,
            max_chars,
            tab,
        } => RemoteAction::Text {
            selector: selector.clone(),
            max_chars: *max_chars,
            tab_id: *tab,
        },
        Commands::Elements { max, tab } => RemoteAction::Elements {
            max_elements: *max,
            tab_id: *tab,
        },
        Commands::WaitFor {
            selector,
            wait_ms,
            tab,
        } => RemoteAction::WaitFor {
            selector: selector.clone(),
            timeout_ms: Some(*wait_ms),
            tab_id: *tab,
        },
        Commands::Tabs => RemoteAction::Tabs,
        Commands::NewTab { url } => RemoteAction::NewTab { url: url.clone() },
        Commands::ActivateTab { tab_id } => RemoteAction::ActivateTab { tab_id: *tab_id },
        Commands::CloseTab { tab_id } => RemoteAction::CloseTab { tab_id: *tab_id },
        Commands::Back { tab } => RemoteAction::Back { tab_id: *tab },
        Commands::Forward { tab } => RemoteAction::Forward { tab_id: *tab },
        Commands::Reload { tab } => RemoteAction::Reload { tab_id: *tab },
    };

    action
        .validate()
        .map_err(|e| anyhow::anyhow!("invalid {}: {e}", action.kind()))?;
    let session = resolve_session(&cli, &client).await?;
    let op = client.act(session, action, timeout).await?;

    match &cli.command {
        Commands::Navigate { .. } => finish(&cli, &op, |r| {
            format!(
                "{}  {}",
                r["url"].as_str().unwrap_or(""),
                r["title"].as_str().unwrap_or("")
            )
        }),
        Commands::Screenshot { output, .. } => {
            if op.state == OperationState::Succeeded && !cli.json {
                let result = op.result.as_ref().context("screenshot has no result")?;
                let (_, bytes) = client
                    .screenshot_bytes(result)
                    .await
                    .context("fetching the screenshot")?;
                let path = output.clone().unwrap_or_else(|| {
                    PathBuf::from(format!(
                        "screenshot-{}.jpg",
                        chrono::Utc::now().format("%Y%m%d-%H%M%S")
                    ))
                });
                std::fs::write(&path, &bytes)
                    .with_context(|| format!("writing {}", path.display()))?;
                println!("{} ({} bytes)", path.display(), bytes.len());
                return Ok(());
            }
            finish(&cli, &op, ok_text)
        }
        Commands::Text { .. } => {
            finish(&cli, &op, |r| r["text"].as_str().unwrap_or("").to_string())
        }
        Commands::Elements { .. } => finish(&cli, &op, |r| {
            r["elements"]
                .as_array()
                .map(|els| {
                    els.iter()
                        .map(|e| {
                            format!(
                                "{:<8} {:<50} {}",
                                e["tag"].as_str().unwrap_or(""),
                                e["selector"].as_str().unwrap_or(""),
                                e["text"].as_str().unwrap_or("")
                            )
                        })
                        .collect::<Vec<_>>()
                        .join("\n")
                })
                .unwrap_or_default()
        }),
        Commands::Tabs => finish(&cli, &op, |r| {
            r["tabs"]
                .as_array()
                .map(|tabs| {
                    tabs.iter()
                        .map(|t| {
                            format!(
                                "{}{}\t{}\t{}",
                                if t["active"].as_bool() == Some(true) {
                                    "*"
                                } else {
                                    " "
                                },
                                t["id"],
                                t["title"].as_str().unwrap_or(""),
                                t["url"].as_str().unwrap_or("")
                            )
                        })
                        .collect::<Vec<_>>()
                        .join("\n")
                })
                .unwrap_or_default()
        }),
        Commands::NewTab { .. } => finish(&cli, &op, |r| format!("tab {}", r["tab_id"])),
        Commands::Scroll { .. } => finish(&cli, &op, |r| format!("x={} y={}", r["x"], r["y"])),
        _ => finish(&cli, &op, ok_text),
    }
}
