//! Durable control-plane state (#211).
//!
//! The store and credentials are saved as JSON documents in a small SQLite
//! database (one transaction per save, so a crash never leaves a half
//! written state). A background task saves about once a second when
//! something changed, and [`StateDb::flush`] saves on shutdown.
//!
//! What is persisted: hosts, sessions, handoffs (views and response-token
//! digests) and credentials (digests only). What is not: operations (short
//! lived; never typed text or screenshots), secret handoff answers waiting
//! to be claimed, and connection state (hosts come back offline until they
//! poll). The webhook registry has its own file (`webhooks.json`).

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use anyhow::{Context, Result};
use sha2::{Digest, Sha256};

use super::credentials::{CredentialState, Credentials};
use super::store::{RuntimeStore, StoreSnapshot};

const SCHEMA_VERSION: i64 = 1;

/// The state database.
#[derive(Clone)]
pub struct StateDb {
    conn: Arc<Mutex<rusqlite::Connection>>,
    path: PathBuf,
    last_digest: Arc<Mutex<[u8; 32]>>,
}

#[derive(serde::Serialize, serde::Deserialize, Default)]
struct Document {
    store: StoreSnapshot,
    credentials: CredentialState,
}

impl StateDb {
    /// Open (or create) the database at `path`; the file is created 0600.
    pub fn open(path: &Path) -> Result<Self> {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir).with_context(|| format!("creating {}", dir.display()))?;
        }
        let new = !path.exists();
        let conn = rusqlite::Connection::open(path)
            .with_context(|| format!("opening {}", path.display()))?;
        #[cfg(unix)]
        if new {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))?;
        }
        conn.execute_batch(
            "PRAGMA journal_mode = WAL;
             PRAGMA synchronous = NORMAL;
             CREATE TABLE IF NOT EXISTS state (
               key TEXT PRIMARY KEY,
               json TEXT NOT NULL,
               saved_at TEXT NOT NULL
             );
             CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value INTEGER NOT NULL);",
        )?;
        let version: Option<i64> = conn
            .query_row(
                "SELECT value FROM meta WHERE key = 'schema_version'",
                [],
                |r| r.get(0),
            )
            .ok();
        match version {
            None => {
                conn.execute(
                    "INSERT INTO meta (key, value) VALUES ('schema_version', ?1)",
                    [SCHEMA_VERSION],
                )?;
            }
            Some(v) if v > SCHEMA_VERSION => anyhow::bail!(
                "{} was written by a newer hexactra-control (schema {v}); upgrade this binary",
                path.display()
            ),
            Some(_) => {}
        }
        Ok(Self {
            conn: Arc::new(Mutex::new(conn)),
            path: path.to_path_buf(),
            last_digest: Arc::new(Mutex::new([0; 32])),
        })
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    fn load_document(&self) -> Result<Option<Document>> {
        let conn = self.conn.lock().unwrap_or_else(|e| e.into_inner());
        let json: Option<String> = conn
            .query_row("SELECT json FROM state WHERE key = 'document'", [], |r| {
                r.get(0)
            })
            .ok();
        json.map(|j| serde_json::from_str(&j).context("reading saved state"))
            .transpose()
    }

    /// Load saved state into a fresh store and credential set.
    pub fn restore(&self, store: &RuntimeStore, credentials: &Credentials) -> Result<bool> {
        let Some(doc) = self.load_document()? else {
            return Ok(false);
        };
        let hosts = doc.store.hosts.len();
        let sessions = doc.store.sessions.len();
        store.import_snapshot(doc.store);
        credentials.import(doc.credentials);
        tracing::info!(hosts, sessions, path = %self.path.display(), "restored control-plane state");
        // Avoid rewriting identical state right away.
        let _ = self.save_if_changed(store, credentials);
        Ok(true)
    }

    /// Save if the state differs from the last save. Returns true if written.
    pub fn save_if_changed(&self, store: &RuntimeStore, credentials: &Credentials) -> Result<bool> {
        let doc = Document {
            store: store.export_snapshot(),
            credentials: credentials.export(),
        };
        let json = serde_json::to_string(&doc)?;
        let d: [u8; 32] = Sha256::digest(json.as_bytes()).into();
        {
            let last = self.last_digest.lock().unwrap_or_else(|e| e.into_inner());
            if *last == d {
                return Ok(false);
            }
        }
        let mut conn = self.conn.lock().unwrap_or_else(|e| e.into_inner());
        let tx = conn.transaction()?;
        tx.execute(
            "INSERT INTO state (key, json, saved_at) VALUES ('document', ?1, ?2)
             ON CONFLICT(key) DO UPDATE SET json = excluded.json, saved_at = excluded.saved_at",
            rusqlite::params![json, chrono::Utc::now().to_rfc3339()],
        )?;
        tx.commit()?;
        *self.last_digest.lock().unwrap_or_else(|e| e.into_inner()) = d;
        Ok(true)
    }

    /// Save now (on shutdown).
    pub fn flush(&self, store: &RuntimeStore, credentials: &Credentials) {
        if let Err(e) = self.save_if_changed(store, credentials) {
            tracing::error!(error = %e, "saving control-plane state failed");
        }
    }

    /// Save every `interval` while the process runs.
    pub fn spawn_saver(&self, store: RuntimeStore, credentials: Credentials, interval: Duration) {
        let db = self.clone();
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(interval).await;
                let db = db.clone();
                let (s, c) = (store.clone(), credentials.clone());
                let r = tokio::task::spawn_blocking(move || db.save_if_changed(&s, &c)).await;
                match r {
                    Ok(Ok(_)) => {}
                    Ok(Err(e)) => tracing::error!(error = %e, "saving control-plane state failed"),
                    Err(e) => tracing::error!(error = %e, "state saver task failed"),
                }
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use hexactra_core::remote::{
        CreateHandoffRequest, HandoffInput, HandoffKind, HandoffOutcome, HandoffStatus,
        RemoteSessionStatus, RespondHandoffRequest,
    };

    #[tokio::test]
    async fn state_survives_a_restart_without_secrets() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("sub/control.db");
        let (
            session_id,
            host_id,
            pending_id,
            answered_id,
            response_token,
            service_token,
            host_token,
        );
        {
            let store = RuntimeStore::new();
            let creds = Credentials::new("operator-token-0123456789abcdef");
            let db = StateDb::open(&path).unwrap();
            assert!(!db.restore(&store, &creds).unwrap());

            let (_, st) = creds.create_service_token("console").unwrap();
            service_token = st;
            let (_, et) = creds
                .create_enrollment(None, Duration::from_secs(60))
                .unwrap();
            let (hid, ht, _) = creds.enroll_host(&et).unwrap();
            host_id = hid;
            host_token = ht;
            store.register_host(Some(host_id), "vps".into(), "1".into());
            store.set_host_on_demand(host_id, true).unwrap();
            store
                .set_host_profiles(host_id, vec!["default".into(), "travel".into()], vec![])
                .unwrap();
            let s = store
                .create_session_for(None, Some("cli".into()), Some("travel".into()), false)
                .unwrap();
            session_id = s.id;

            let req = |input| CreateHandoffRequest {
                kind: HandoffKind::Code,
                prompt: "Enter the code".into(),
                input,
                choices: vec![],
                constraints: Default::default(),
                confirm_label: None,
                deny_label: None,
                risk: None,
                timeout_ms: None,
                page: None,
                remember: None,
            };
            // An answered secret handoff: its value must not be persisted.
            let (a, at) = store
                .create_handoff(s.id, req(HandoffInput::Secret))
                .unwrap();
            answered_id = a.id;
            store
                .respond_handoff(
                    a.id,
                    super::super::handoff::Responder::Token(&at),
                    RespondHandoffRequest {
                        outcome: HandoffOutcome::Completed,
                        value: Some("987654".into()),
                        ..Default::default()
                    },
                )
                .unwrap();
            // An answered sign-in (#527): its password must not be persisted either.
            let (c, ct) = store
                .create_handoff(s.id, req(HandoffInput::Credentials))
                .unwrap();
            store
                .respond_handoff(
                    c.id,
                    super::super::handoff::Responder::Token(&ct),
                    RespondHandoffRequest {
                        outcome: HandoffOutcome::Completed,
                        value: Some("oscar".into()),
                        secret: Some("x9-424243".into()),
                        ..Default::default()
                    },
                )
                .unwrap();
            let (p, pt) = store.create_handoff(s.id, req(HandoffInput::None)).unwrap();
            pending_id = p.id;
            response_token = pt;

            assert!(db.save_if_changed(&store, &creds).unwrap());
            assert!(
                !db.save_if_changed(&store, &creds).unwrap(),
                "unchanged state is not rewritten"
            );
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
                assert_eq!(mode, 0o600);
            }
            // Nothing secret on disk.
            let raw = std::fs::read(&path).unwrap();
            let text = String::from_utf8_lossy(&raw);
            for secret in [
                "987654",
                "x9-424243",
                service_token.as_str(),
                host_token.as_str(),
                response_token.as_str(),
            ] {
                assert!(!text.contains(secret), "secret on disk");
            }
        }

        // "Restart": fresh store and credentials from the same file.
        let store = RuntimeStore::new();
        let creds = Credentials::new("operator-token-0123456789abcdef");
        let db = StateDb::open(&path).unwrap();
        assert!(db.restore(&store, &creds).unwrap());

        assert!(matches!(
            creds.authenticate(&service_token),
            Some(super::super::credentials::Principal::Service(_))
        ));
        assert_eq!(
            creds.authenticate(&host_token),
            Some(super::super::credentials::Principal::Host(host_id))
        );
        let h = store
            .list_hosts()
            .into_iter()
            .find(|h| h.id == host_id)
            .unwrap();
        assert_eq!(h.profiles, vec!["default", "travel"]);
        assert!(!h.browser_connected);
        let s = store.get_session(session_id).unwrap();
        assert_eq!(
            (s.profile.as_str(), s.status),
            ("travel", RemoteSessionStatus::Active)
        );
        // Pending handoff still answerable with its token; answered one kept
        // its status but not its secret.
        assert_eq!(
            store.get_handoff(pending_id).unwrap().status,
            HandoffStatus::Pending
        );
        assert!(store
            .check_handoff_token(pending_id, &response_token)
            .is_ok());
        assert_eq!(
            store.get_handoff(answered_id).unwrap().status,
            HandoffStatus::Completed
        );
        assert!(store.claim_handoff_secret(answered_id).is_err());
    }

    #[test]
    fn refuses_a_newer_schema() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("c.db");
        drop(StateDb::open(&path).unwrap());
        let conn = rusqlite::Connection::open(&path).unwrap();
        conn.execute(
            "UPDATE meta SET value = 99 WHERE key = 'schema_version'",
            [],
        )
        .unwrap();
        drop(conn);
        assert!(StateDb::open(&path).is_err());
    }
}
