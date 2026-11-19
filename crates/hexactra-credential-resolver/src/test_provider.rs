//! A fixed-fixture provider for the Rust tests, the console's `FakeFabric`
//! and the replay suite (#587). Compiled only for this crate's tests and the
//! `test-provider` feature; the control plane enables that feature only in its
//! dev builds and tests.
//!
//! Its values are published test constants, not secrets. It keeps a log of
//! what it was asked (never a value) so tests can assert which origin a
//! release was bound to.

use std::sync::Mutex;
use std::time::Duration;

use async_trait::async_trait;
use chrono::{DateTime, Utc};
use hexactra_core::remote::{ItemKind, ItemSummary, MatchKind, SecretField};

use crate::{
    CodeRequest, Origin, OwnerId, ProviderError, ReleaseRequest, SecretValue, SecretsProvider,
};

/// The origin the default fixture's first login is for.
pub const FIXTURE_ORIGIN: &str = "https://login.example.test";
/// The origin of the default fixture's second login (same site, not exact).
pub const FIXTURE_SITE_ORIGIN: &str = "https://app.example.test";
pub const FIXTURE_ITEM_ID: &str = "test-login-1";
pub const FIXTURE_SITE_ITEM_ID: &str = "test-login-2";
pub const FIXTURE_USERNAME: &str = "person-a@example.test";
pub const FIXTURE_PASSWORD: &str = "canary-pw-7f3a9c1e-test";
pub const FIXTURE_CODE: &str = "246810";

/// One login in the fixture.
#[derive(Debug, Clone)]
pub struct TestItem {
    pub id: String,
    pub name: String,
    pub username: String,
    pub password: String,
    pub code: Option<String>,
    pub origins: Vec<String>,
}

/// What the provider was asked; never a value.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TestCall {
    /// `lookup`, `release` or `one_time_code`.
    pub op: &'static str,
    pub owner: String,
    pub origin: String,
    pub item_id: Option<String>,
    pub field: Option<&'static str>,
    pub purpose: Option<&'static str>,
    pub client_label: Option<String>,
    pub run_id: Option<String>,
}

pub struct TestProvider {
    /// Only this owner's sessions see the items; `None`: every owner.
    owner: Option<String>,
    items: Vec<TestItem>,
    failure: Mutex<Option<ProviderError>>,
    calls: Mutex<Vec<TestCall>>,
}

impl Default for TestProvider {
    fn default() -> Self {
        Self::with_fixture()
    }
}

impl TestProvider {
    /// No items.
    pub fn empty() -> Self {
        Self {
            owner: None,
            items: Vec::new(),
            failure: Mutex::new(None),
            calls: Mutex::new(Vec::new()),
        }
    }

    /// Two logins: `test-login-1` for [`FIXTURE_ORIGIN`] (with a one-time
    /// code) and `test-login-2` for [`FIXTURE_SITE_ORIGIN`] (no code).
    pub fn with_fixture() -> Self {
        Self::empty()
            .with_item(TestItem {
                id: FIXTURE_ITEM_ID.into(),
                name: "Example login".into(),
                username: FIXTURE_USERNAME.into(),
                password: FIXTURE_PASSWORD.into(),
                code: Some(FIXTURE_CODE.into()),
                origins: vec![FIXTURE_ORIGIN.into()],
            })
            .with_item(TestItem {
                id: FIXTURE_SITE_ITEM_ID.into(),
                name: "Example app login".into(),
                username: "person-b@example.test".into(),
                password: "canary-pw-2-b81d44aa-test".into(),
                code: None,
                origins: vec![FIXTURE_SITE_ORIGIN.into()],
            })
    }

    pub fn with_item(mut self, item: TestItem) -> Self {
        self.items.push(item);
        self
    }

    /// Only this owner's sessions see the items.
    pub fn for_owner(mut self, owner: impl Into<String>) -> Self {
        self.owner = Some(owner.into());
        self
    }

    /// Fail every call with `err` until cleared.
    pub fn failing(self, err: ProviderError) -> Self {
        *self.failure.lock().unwrap() = Some(err);
        self
    }

    /// Fail (or stop failing) from now on.
    pub fn set_failure(&self, err: Option<ProviderError>) {
        *self.failure.lock().unwrap() = err;
    }

    /// Built from a registration's `settings`: `{ "mode": "ok" |
    /// "unavailable" | "rate_limited" | "disabled" | "unauthorized" }`, and
    /// `{ "empty": true }` for no items.
    pub fn from_settings(settings: Option<&serde_json::Value>) -> Result<Self, String> {
        let mut p = if settings
            .and_then(|s| s.get("empty"))
            .and_then(|v| v.as_bool())
            .unwrap_or(false)
        {
            Self::empty()
        } else {
            Self::with_fixture()
        };
        match settings
            .and_then(|s| s.get("mode"))
            .and_then(|m| m.as_str())
        {
            None | Some("ok") => {}
            Some("unavailable") => p = p.failing(ProviderError::Unavailable),
            Some("rate_limited") => {
                p = p.failing(ProviderError::RateLimited {
                    retry_after: Duration::from_secs(7),
                })
            }
            Some("disabled") => p = p.failing(ProviderError::Disabled),
            Some("unauthorized") => p = p.failing(ProviderError::Unauthorized),
            Some(other) => return Err(format!("unknown test provider mode {other:?}")),
        }
        Ok(p)
    }

    /// Everything the provider was asked, oldest first.
    pub fn calls(&self) -> Vec<TestCall> {
        self.calls.lock().unwrap().clone()
    }

    fn check(&self, owner: &OwnerId) -> Result<(), ProviderError> {
        if let Some(e) = self.failure.lock().unwrap().clone() {
            return Err(e);
        }
        match &self.owner {
            Some(o) if o != owner.as_str() => Err(ProviderError::NotFound),
            _ => Ok(()),
        }
    }

    fn item(&self, id: &str) -> Result<&TestItem, ProviderError> {
        self.items
            .iter()
            .find(|i| i.id == id)
            .ok_or(ProviderError::NotFound)
    }

    fn exact(&self, item: &TestItem, origin: &Origin) -> bool {
        item.origins
            .iter()
            .filter_map(|o| Origin::from_stored(o).ok())
            .any(|o| o.matches_exact(origin))
    }

    fn log(&self, call: TestCall) {
        self.calls.lock().unwrap().push(call);
    }
}

#[async_trait]
impl SecretsProvider for TestProvider {
    fn id(&self) -> &str {
        "test"
    }

    async fn lookup(
        &self,
        owner: &OwnerId,
        origin: &Origin,
        kind: ItemKind,
    ) -> Result<Vec<ItemSummary>, ProviderError> {
        self.log(TestCall {
            op: "lookup",
            owner: owner.to_string(),
            origin: origin.to_string(),
            item_id: None,
            field: None,
            purpose: None,
            client_label: None,
            run_id: None,
        });
        self.check(owner)?;
        if kind != ItemKind::Login {
            return Ok(Vec::new());
        }
        let mut out: Vec<ItemSummary> = self
            .items
            .iter()
            .filter_map(|i| {
                let kind = i
                    .origins
                    .iter()
                    .filter_map(|o| Origin::from_stored(o).ok())
                    .filter_map(|o| origin.match_kind(&o))
                    .min_by_key(|k| *k != MatchKind::Exact)?;
                Some(ItemSummary {
                    id: i.id.clone(),
                    name: i.name.clone(),
                    username: Some(i.username.clone()),
                    origins: i.origins.clone(),
                    match_kind: kind,
                    has_code: i.code.is_some(),
                    updated_at: Some(DateTime::<Utc>::UNIX_EPOCH),
                })
            })
            .collect();
        out.sort_by_key(|s| s.match_kind != MatchKind::Exact);
        Ok(out)
    }

    async fn release(&self, req: ReleaseRequest) -> Result<SecretValue, ProviderError> {
        self.log(TestCall {
            op: "release",
            owner: req.owner.to_string(),
            origin: req.origin.to_string(),
            item_id: Some(req.item_id.clone()),
            field: Some(req.field.as_str()),
            purpose: Some(req.purpose.as_str()),
            client_label: req.client_label.clone(),
            run_id: req.run_id.clone(),
        });
        self.check(&req.owner)?;
        let item = self.item(&req.item_id)?;
        if !self.exact(item, &req.origin) {
            return Err(ProviderError::OriginMismatch);
        }
        match req.field {
            SecretField::Username => Ok(SecretValue::from_string(item.username.clone())),
            SecretField::Password => Ok(SecretValue::from_string(item.password.clone())),
            _ => Err(ProviderError::Refused("unsupported_field".into())),
        }
    }

    async fn one_time_code(
        &self,
        req: CodeRequest,
    ) -> Result<(SecretValue, DateTime<Utc>), ProviderError> {
        self.log(TestCall {
            op: "one_time_code",
            owner: req.owner.to_string(),
            origin: req.origin.to_string(),
            item_id: Some(req.item_id.clone()),
            field: None,
            purpose: Some(req.purpose.as_str()),
            client_label: req.client_label.clone(),
            run_id: req.run_id.clone(),
        });
        self.check(&req.owner)?;
        let item = self.item(&req.item_id)?;
        if !self.exact(item, &req.origin) {
            return Err(ProviderError::OriginMismatch);
        }
        let code = item.code.clone().ok_or(ProviderError::NotFound)?;
        Ok((
            SecretValue::from_string(code),
            Utc::now() + chrono::Duration::seconds(30),
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use hexactra_core::remote::SecretPurpose;

    fn owner() -> OwnerId {
        OwnerId::new("user-a").unwrap()
    }

    fn rel(item: &str, field: SecretField, origin: &str) -> ReleaseRequest {
        ReleaseRequest {
            owner: owner(),
            item_id: item.into(),
            field,
            origin: Origin::from_browser_url(origin).unwrap(),
            purpose: SecretPurpose::Login,
            run_id: Some("run-1".into()),
            client_label: Some("Console".into()),
        }
    }

    #[tokio::test]
    async fn lookup_returns_summaries_exact_first_and_never_a_value() {
        let p = TestProvider::with_fixture();
        let page = Origin::from_browser_url("https://login.example.test/signin").unwrap();
        let items = p.lookup(&owner(), &page, ItemKind::Login).await.unwrap();
        assert_eq!(items.len(), 2);
        assert_eq!(items[0].id, FIXTURE_ITEM_ID);
        assert_eq!(items[0].match_kind, MatchKind::Exact);
        assert!(items[0].has_code);
        assert_eq!(items[1].match_kind, MatchKind::Site);
        let json = serde_json::to_string(&items).unwrap();
        assert!(!json.contains(FIXTURE_PASSWORD) && !json.contains(FIXTURE_CODE));
        // A page on another site finds nothing.
        let other = Origin::from_browser_url("https://evil.test").unwrap();
        assert!(p
            .lookup(&owner(), &other, ItemKind::Login)
            .await
            .unwrap()
            .is_empty());
        // Other kinds are not implemented by the fixture.
        assert!(p
            .lookup(&owner(), &page, ItemKind::Card)
            .await
            .unwrap()
            .is_empty());
    }

    #[tokio::test]
    async fn release_needs_the_exact_origin() {
        let p = TestProvider::with_fixture();
        let v = p
            .release(rel(FIXTURE_ITEM_ID, SecretField::Password, FIXTURE_ORIGIN))
            .await
            .unwrap();
        assert!(v.expose(|b| b == FIXTURE_PASSWORD.as_bytes()));
        // A site match is never fillable; neither is a look-alike.
        for origin in [
            "https://app.example.test",
            "https://login.example.test.evil.test",
        ] {
            assert_eq!(
                p.release(rel(FIXTURE_ITEM_ID, SecretField::Password, origin))
                    .await
                    .err(),
                Some(ProviderError::OriginMismatch)
            );
        }
        assert_eq!(
            p.release(rel("nope", SecretField::Password, FIXTURE_ORIGIN))
                .await
                .err(),
            Some(ProviderError::NotFound)
        );
        assert!(matches!(
            p.release(rel(
                FIXTURE_ITEM_ID,
                SecretField::CardNumber,
                FIXTURE_ORIGIN
            ))
            .await
            .err(),
            Some(ProviderError::Refused(_))
        ));
        let calls = p.calls();
        assert_eq!(calls[0].op, "release");
        assert_eq!(calls[0].origin, FIXTURE_ORIGIN);
        assert_eq!(calls[0].field, Some("password"));
    }

    #[tokio::test]
    async fn codes_and_failures() {
        let p = TestProvider::with_fixture();
        let req = |item: &str| CodeRequest {
            owner: owner(),
            item_id: item.into(),
            origin: Origin::from_browser_url(FIXTURE_ORIGIN).unwrap(),
            purpose: SecretPurpose::Mfa,
            run_id: None,
            client_label: None,
        };
        let (code, exp) = p.one_time_code(req(FIXTURE_ITEM_ID)).await.unwrap();
        assert!(code.expose(|b| b == FIXTURE_CODE.as_bytes()));
        assert!(exp > Utc::now());
        // An item without a code is "not found", as in Vault.
        let mut other = req(FIXTURE_SITE_ITEM_ID);
        other.origin = Origin::from_browser_url(FIXTURE_SITE_ORIGIN).unwrap();
        assert_eq!(
            p.one_time_code(other).await.err(),
            Some(ProviderError::NotFound)
        );

        p.set_failure(Some(ProviderError::Disabled));
        assert_eq!(
            p.release(rel(FIXTURE_ITEM_ID, SecretField::Password, FIXTURE_ORIGIN))
                .await
                .err(),
            Some(ProviderError::Disabled)
        );
        // Another owner's items are not found.
        p.set_failure(None);
        let scoped = TestProvider::with_fixture().for_owner("user-b");
        assert_eq!(
            scoped
                .release(rel(FIXTURE_ITEM_ID, SecretField::Password, FIXTURE_ORIGIN))
                .await
                .err(),
            Some(ProviderError::NotFound)
        );
    }

    #[test]
    fn settings_pick_a_failure_mode() {
        let s = serde_json::json!({"mode": "rate_limited"});
        let p = TestProvider::from_settings(Some(&s)).unwrap();
        assert!(matches!(
            p.failure.lock().unwrap().clone(),
            Some(ProviderError::RateLimited { .. })
        ));
        assert!(TestProvider::from_settings(Some(&serde_json::json!({"mode": "x"}))).is_err());
        assert!(TestProvider::from_settings(None)
            .unwrap()
            .failure
            .lock()
            .unwrap()
            .is_none());
    }
}
