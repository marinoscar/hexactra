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
use hexactra_core::remote::{
    CardGrantSummary, CardSummary, FieldSummary, ItemKind, ItemSummary, MatchKind, SecretField,
    SecretPurpose,
};

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
/// The fixture's identity item (E37.6): its sensitive fields may be typed
/// only on [`FIXTURE_ORIGIN`]; the others anywhere on `https`.
pub const FIXTURE_IDENTITY_ID: &str = "test-identity-1";
pub const FIXTURE_FULL_NAME: &str = "Person A Canary-Name";
pub const FIXTURE_DOB: &str = "1990-03-27";
pub const FIXTURE_ID_NUMBER: &str = "CANARY-ID-5521-7788";
pub const FIXTURE_COUNTRY: &str = "Canada";
pub const FIXTURE_CITY: &str = "Exampleton";

/// The fixture's cards (E37.7): the published test numbers, granted for
/// [`FIXTURE_MERCHANT`]. `test-card-1` may be typed into the processor frame
/// [`FIXTURE_PAY_FRAME`], up to 500.00 USD, security code included;
/// `test-card-2` has no frame, up to 20.00 USD and no security code.
pub const FIXTURE_CARD_ID: &str = "test-card-1";
pub const FIXTURE_CARD_2_ID: &str = "test-card-2";
pub const FIXTURE_MERCHANT: &str = "https://shop.example.test";
pub const FIXTURE_PAY_FRAME: &str = "https://pay.processor.example.test";
pub const FIXTURE_CARD_NUMBER: &str = "4242424242424242";
pub const FIXTURE_CARD_EXP_MONTH: &str = "09";
pub const FIXTURE_CARD_EXP_YEAR: &str = "2031";
pub const FIXTURE_CARD_HOLDER: &str = "Person A";
pub const FIXTURE_CARD_POSTAL: &str = "K1A 0B1";
pub const FIXTURE_CARD_CVV: &str = "CANARY-CVV-737";

/// One card in the fixture.
#[derive(Debug, Clone)]
pub struct TestCard {
    pub id: String,
    pub name: String,
    pub brand: String,
    pub number: String,
    pub exp_month: String,
    pub exp_year: String,
    pub holder: String,
    pub postal: String,
    pub cvv: String,
    /// The merchant the owner granted (matched by registrable domain).
    pub merchant: String,
    /// Exact payment frame origins the grant accepts.
    pub frames: Vec<String>,
    pub max_amount: f64,
    pub currency: String,
    pub include_security_code: bool,
}

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

/// One field of an identity item.
#[derive(Debug, Clone)]
pub struct TestIdentityField {
    pub key: SecretField,
    pub label: String,
    pub value: String,
    pub sensitive: bool,
}

/// One identity item in the fixture.
#[derive(Debug, Clone)]
pub struct TestIdentity {
    pub id: String,
    pub name: String,
    /// Where its sensitive fields may be typed (exact origins).
    pub allowed_origins: Vec<String>,
    pub fields: Vec<TestIdentityField>,
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
    /// For a card release: the purchase's amount and currency and the frame
    /// the fabric found (E37.7).
    pub amount: Option<String>,
    pub currency: Option<String>,
    pub frame_origin: Option<String>,
}

pub struct TestProvider {
    /// Only this owner's sessions see the items; `None`: every owner.
    owner: Option<String>,
    items: Vec<TestItem>,
    identities: Vec<TestIdentity>,
    cards: Vec<TestCard>,
    failure: Mutex<Option<ProviderError>>,
    calls: Mutex<Vec<TestCall>>,
    /// Hexactra passkeys (E47.2): kept in memory, the private key included.
    passkeys: Mutex<Vec<TestPasskey>>,
}

/// A passkey the test provider keeps (E47.2). Tests read the private key to
/// check a signature; a real provider never lets it out but to the fabric.
#[derive(Debug, Clone)]
pub struct TestPasskey {
    pub id: String,
    pub owner: String,
    pub rp_id: String,
    pub origin: String,
    pub credential_id: String,
    pub user_handle: String,
    pub user_name: String,
    pub public_key: String,
    pub private_key: Vec<u8>,
    pub sign_count: u32,
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
            identities: Vec::new(),
            cards: Vec::new(),
            failure: Mutex::new(None),
            calls: Mutex::new(Vec::new()),
            passkeys: Mutex::new(Vec::new()),
        }
    }

    /// The passkeys kept (E47.2), private keys included: for tests only.
    pub fn passkeys(&self) -> Vec<TestPasskey> {
        self.passkeys.lock().unwrap().clone()
    }

    /// Keep a passkey made elsewhere (a second account on the same site).
    pub fn with_passkey(self, p: TestPasskey) -> Self {
        self.passkeys.lock().unwrap().push(p);
        self
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
            .with_identity(Self::fixture_identity())
            .with_card(Self::fixture_card(FIXTURE_CARD_ID))
            .with_card(Self::fixture_card(FIXTURE_CARD_2_ID))
    }

    /// Add a card.
    pub fn with_card(mut self, card: TestCard) -> Self {
        self.cards.push(card);
        self
    }

    /// One of the fixture's two cards (see [`FIXTURE_CARD_ID`]).
    pub fn fixture_card(id: &str) -> TestCard {
        let first = id == FIXTURE_CARD_ID;
        TestCard {
            id: id.into(),
            name: if first {
                "Everyday card"
            } else {
                "Virtual card"
            }
            .into(),
            brand: if first { "visa" } else { "mastercard" }.into(),
            number: if first {
                FIXTURE_CARD_NUMBER
            } else {
                "5555555555554444"
            }
            .into(),
            exp_month: FIXTURE_CARD_EXP_MONTH.into(),
            exp_year: FIXTURE_CARD_EXP_YEAR.into(),
            holder: FIXTURE_CARD_HOLDER.into(),
            postal: FIXTURE_CARD_POSTAL.into(),
            cvv: if first {
                FIXTURE_CARD_CVV
            } else {
                "CANARY-CVV-4821"
            }
            .into(),
            merchant: FIXTURE_MERCHANT.into(),
            frames: if first {
                vec![FIXTURE_PAY_FRAME.into()]
            } else {
                Vec::new()
            },
            max_amount: if first { 500.0 } else { 20.0 },
            currency: "USD".into(),
            include_security_code: first,
        }
    }

    /// Add an identity item.
    pub fn with_identity(mut self, item: TestIdentity) -> Self {
        self.identities.push(item);
        self
    }

    /// The default fixture's identity item: name, date of birth, ID number,
    /// country and city; the date of birth and ID number are sensitive and
    /// allowed only on [`FIXTURE_ORIGIN`].
    pub fn fixture_identity() -> TestIdentity {
        let f = |key, label: &str, value: &str, sensitive| TestIdentityField {
            key,
            label: label.into(),
            value: value.into(),
            sensitive,
        };
        TestIdentity {
            id: FIXTURE_IDENTITY_ID.into(),
            name: "Passport".into(),
            allowed_origins: vec![FIXTURE_ORIGIN.into()],
            fields: vec![
                f(SecretField::FullName, "Full name", FIXTURE_FULL_NAME, false),
                f(SecretField::DateOfBirth, "Date of birth", FIXTURE_DOB, true),
                f(SecretField::IdNumber, "ID number", FIXTURE_ID_NUMBER, true),
                f(SecretField::Country, "Country", FIXTURE_COUNTRY, false),
                f(SecretField::City, "City", FIXTURE_CITY, false),
            ],
        }
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

    fn identity(&self, id: &str) -> Result<&TestIdentity, ProviderError> {
        self.identities
            .iter()
            .find(|i| i.id == id)
            .ok_or(ProviderError::NotFound)
    }

    fn allowed(&self, item: &TestIdentity, origin: &Origin) -> bool {
        item.allowed_origins
            .iter()
            .filter_map(|o| Origin::from_stored(o).ok())
            .any(|o| o.matches_exact(origin))
    }

    /// A card field under the card's merchant grant, with Vault's checks in
    /// Vault's order (merchant, frame, currency, amount, security code).
    fn release_card(card: &TestCard, req: &ReleaseRequest) -> Result<SecretValue, ProviderError> {
        let Some(purchase) = req.purchase.as_ref() else {
            return Err(ProviderError::Refused("unsupported_purpose".into()));
        };
        if req.purpose != SecretPurpose::Purchase || req.origin.scheme() != "https" {
            return Err(ProviderError::Refused("unsupported_purpose".into()));
        }
        let merchant = Origin::from_stored(&card.merchant).map_err(|_| ProviderError::NotFound)?;
        if req.origin.match_kind(&merchant).is_none() {
            return Err(ProviderError::OriginMismatch);
        }
        if let Some(f) = &purchase.frame_origin {
            let ok = card
                .frames
                .iter()
                .filter_map(|o| Origin::from_stored(o).ok())
                .any(|o| o.matches_exact(f));
            if !ok {
                return Err(ProviderError::OriginMismatch);
            }
        }
        if purchase.currency != card.currency {
            return Err(ProviderError::Refused("card_currency_mismatch".into()));
        }
        let amount: f64 = purchase
            .amount
            .parse()
            .map_err(|_| ProviderError::Refused("invalid_request".into()))?;
        if amount > card.max_amount + 1e-9 {
            return Err(ProviderError::Refused("card_amount_exceeded".into()));
        }
        let value = match req.field {
            SecretField::CardNumber => &card.number,
            SecretField::ExpMonth => &card.exp_month,
            SecretField::ExpYear => &card.exp_year,
            SecretField::HolderName => &card.holder,
            SecretField::PostalCode => &card.postal,
            SecretField::SecurityCode => {
                if !card.include_security_code {
                    return Err(ProviderError::Refused("security_code_not_granted".into()));
                }
                &card.cvv
            }
            _ => return Err(ProviderError::Refused("unsupported_field".into())),
        };
        Ok(SecretValue::from_string(value.clone()))
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

    async fn passkey_lookup(
        &self,
        owner: &OwnerId,
        rp_id: &str,
        origin: &Origin,
    ) -> Result<Vec<crate::PasskeySummary>, ProviderError> {
        if let Some(e) = self.failure.lock().unwrap().clone() {
            return Err(e);
        }
        if !crate::rp_id_allowed(rp_id, origin) {
            return Err(ProviderError::OriginMismatch);
        }
        Ok(self
            .passkeys
            .lock()
            .unwrap()
            .iter()
            .filter(|p| p.owner == owner.as_str() && p.rp_id == rp_id)
            .map(|p| crate::PasskeySummary {
                id: p.id.clone(),
                credential_id: p.credential_id.clone(),
                user_handle: p.user_handle.clone(),
                user_name: p.user_name.clone(),
                rp_id: p.rp_id.clone(),
                sign_count: p.sign_count,
            })
            .collect())
    }

    async fn passkey_release(
        &self,
        req: crate::PasskeyRelease,
    ) -> Result<SecretValue, ProviderError> {
        if !crate::rp_id_allowed(&req.rp_id, &req.origin) {
            return Err(ProviderError::OriginMismatch);
        }
        let keys = self.passkeys.lock().unwrap();
        let p = keys
            .iter()
            .find(|p| p.id == req.item_id && p.owner == req.owner.as_str())
            .ok_or(ProviderError::NotFound)?;
        if p.rp_id != req.rp_id {
            return Err(ProviderError::OriginMismatch);
        }
        Ok(SecretValue::new(p.private_key.clone()))
    }

    async fn passkey_save(&self, req: crate::NewPasskey) -> Result<String, ProviderError> {
        if let Some(e) = self.failure.lock().unwrap().clone() {
            return Err(e);
        }
        let mut keys = self.passkeys.lock().unwrap();
        let id = format!("test-passkey-{}", keys.len() + 1);
        let private_key = req.private_key.expose(|b| b.to_vec());
        keys.push(TestPasskey {
            id: id.clone(),
            owner: req.owner.as_str().to_string(),
            rp_id: req.rp_id,
            origin: req.origin.to_string(),
            credential_id: req.credential_id,
            user_handle: req.user_handle,
            user_name: req.user_name,
            public_key: req.public_key,
            private_key,
            sign_count: 0,
        });
        Ok(id)
    }

    async fn passkey_used(
        &self,
        owner: &OwnerId,
        item_id: &str,
        sign_count: u32,
    ) -> Result<(), ProviderError> {
        if let Some(p) = self
            .passkeys
            .lock()
            .unwrap()
            .iter_mut()
            .find(|p| p.id == item_id && p.owner == owner.as_str())
        {
            p.sign_count = sign_count;
        }
        Ok(())
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
            amount: None,
            currency: None,
            frame_origin: None,
        });
        self.check(owner)?;
        if kind == ItemKind::Card {
            let mut out: Vec<ItemSummary> = self
                .cards
                .iter()
                .filter(|c| {
                    Origin::from_stored(&c.merchant)
                        .ok()
                        .and_then(|m| origin.match_kind(&m))
                        .is_some()
                })
                .map(|c| ItemSummary {
                    id: c.id.clone(),
                    name: c.name.clone(),
                    username: None,
                    origins: Vec::new(),
                    match_kind: MatchKind::Exact,
                    has_code: false,
                    updated_at: None,
                    fields: Vec::new(),
                    card: Some(CardSummary {
                        brand: Some(c.brand.clone()),
                        last4: Some(c.number[c.number.len() - 4..].to_string()),
                        exp_month: Some(c.exp_month.clone()),
                        exp_year: Some(c.exp_year.clone()),
                        grant: Some(CardGrantSummary {
                            max_amount: format!("{:.2}", c.max_amount),
                            currency: c.currency.clone(),
                            includes_security_code: c.include_security_code,
                            expires_at: None,
                        }),
                    }),
                })
                .collect();
            out.sort_by(|a, b| a.id.cmp(&b.id));
            return Ok(out);
        }
        if kind == ItemKind::Identity {
            let mut out: Vec<ItemSummary> = self
                .identities
                .iter()
                .map(|i| {
                    let allowed = self.allowed(i, origin);
                    ItemSummary {
                        id: i.id.clone(),
                        name: i.name.clone(),
                        username: None,
                        origins: Vec::new(),
                        match_kind: if allowed {
                            MatchKind::Exact
                        } else {
                            MatchKind::Site
                        },
                        has_code: false,
                        updated_at: None,
                        fields: i
                            .fields
                            .iter()
                            .map(|f| FieldSummary {
                                key: f.key,
                                label: f.label.clone(),
                                sensitive: f.sensitive,
                                usable_here: !f.sensitive || allowed,
                            })
                            .collect(),
                        card: None,
                    }
                })
                .collect();
            out.sort_by_key(|s| s.match_kind != MatchKind::Exact);
            return Ok(out);
        }
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
                    fields: Vec::new(),
                    card: None,
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
            amount: req.purchase.as_ref().map(|p| p.amount.clone()),
            currency: req.purchase.as_ref().map(|p| p.currency.clone()),
            frame_origin: req
                .purchase
                .as_ref()
                .and_then(|p| p.frame_origin.as_ref().map(|f| f.to_string())),
        });
        self.check(&req.owner)?;
        if let Some(card) = self.cards.iter().find(|c| c.id == req.item_id) {
            return Self::release_card(card, &req);
        }
        if req.purpose == SecretPurpose::Purchase || req.purchase.is_some() {
            return Err(ProviderError::NotFound);
        }
        if let Ok(identity) = self.identity(&req.item_id) {
            if req.purpose != SecretPurpose::Form {
                return Err(ProviderError::Refused("unsupported_purpose".into()));
            }
            let f = identity
                .fields
                .iter()
                .find(|f| f.key == req.field)
                .ok_or(ProviderError::NotFound)?;
            if f.sensitive && !self.allowed(identity, &req.origin) {
                return Err(ProviderError::OriginMismatch);
            }
            return Ok(SecretValue::from_string(f.value.clone()));
        }
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
            amount: None,
            currency: None,
            frame_origin: None,
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
            purchase: None,
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
        // A card is listed only for a merchant it is granted for (E37.7), and
        // a lookup never carries the number or the security code.
        assert!(p
            .lookup(&owner(), &other, ItemKind::Card)
            .await
            .unwrap()
            .is_empty());
        let shop = Origin::from_browser_url("https://checkout.shop.example.test/pay").unwrap();
        let cards = p.lookup(&owner(), &shop, ItemKind::Card).await.unwrap();
        assert_eq!(cards.len(), 2);
        let card = cards[0].card.as_ref().unwrap();
        assert_eq!(card.last4.as_deref(), Some("4242"));
        assert_eq!(card.grant.as_ref().unwrap().max_amount, "500.00");
        let json = serde_json::to_string(&cards).unwrap();
        assert!(!json.contains(FIXTURE_CARD_NUMBER) && !json.contains(FIXTURE_CARD_CVV));
    }

    fn pay(item: &str, field: SecretField, amount: &str, frame: Option<&str>) -> ReleaseRequest {
        ReleaseRequest {
            purpose: SecretPurpose::Purchase,
            purchase: Some(crate::PurchaseContext {
                amount: amount.into(),
                currency: "USD".into(),
                frame_origin: frame.map(|f| Origin::from_stored(f).unwrap()),
            }),
            ..rel(item, field, FIXTURE_MERCHANT)
        }
    }

    #[tokio::test]
    async fn card_release_enforces_the_grant_and_logs_the_purchase_not_a_value() {
        let p = TestProvider::with_fixture();
        let v = p
            .release(pay(
                FIXTURE_CARD_ID,
                SecretField::CardNumber,
                "42.50",
                Some(FIXTURE_PAY_FRAME),
            ))
            .await
            .unwrap();
        assert!(v.expose(|b| b == FIXTURE_CARD_NUMBER.as_bytes()));
        let call = p.calls().pop().unwrap();
        assert_eq!(call.amount.as_deref(), Some("42.50"));
        assert_eq!(call.currency.as_deref(), Some("USD"));
        assert_eq!(call.frame_origin.as_deref(), Some(FIXTURE_PAY_FRAME));
        assert_eq!(call.purpose, Some("purchase"));
        let refused = |r: Result<SecretValue, ProviderError>| r.err().unwrap();
        // Amount over the grant, a frame that is not listed, no security code granted.
        assert_eq!(
            refused(
                p.release(pay(
                    FIXTURE_CARD_2_ID,
                    SecretField::CardNumber,
                    "20.01",
                    None
                ))
                .await
            ),
            ProviderError::Refused("card_amount_exceeded".into())
        );
        assert_eq!(
            refused(
                p.release(pay(
                    FIXTURE_CARD_ID,
                    SecretField::CardNumber,
                    "5",
                    Some("https://evil.test")
                ))
                .await
            ),
            ProviderError::OriginMismatch
        );
        assert_eq!(
            refused(
                p.release(pay(FIXTURE_CARD_2_ID, SecretField::SecurityCode, "5", None))
                    .await
            ),
            ProviderError::Refused("security_code_not_granted".into())
        );
        // A card needs a purchase.
        assert_eq!(
            refused(
                p.release(rel(
                    FIXTURE_CARD_ID,
                    SecretField::CardNumber,
                    FIXTURE_MERCHANT
                ))
                .await
            ),
            ProviderError::Refused("unsupported_purpose".into())
        );
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
    async fn identity_lookup_lists_labels_and_flags_and_never_a_value() {
        let p = TestProvider::with_fixture();
        let allowed = Origin::from_browser_url(FIXTURE_ORIGIN).unwrap();
        let elsewhere = Origin::from_browser_url("https://other.example.test").unwrap();
        let on = p
            .lookup(&owner(), &allowed, ItemKind::Identity)
            .await
            .unwrap();
        assert_eq!(on.len(), 1);
        assert_eq!(on[0].match_kind, MatchKind::Exact);
        assert!(on[0].fields.iter().all(|f| f.usable_here));
        let off = p
            .lookup(&owner(), &elsewhere, ItemKind::Identity)
            .await
            .unwrap();
        let usable = |k: SecretField| {
            off[0]
                .fields
                .iter()
                .find(|f| f.key == k)
                .unwrap()
                .usable_here
        };
        assert!(usable(SecretField::FullName) && usable(SecretField::City));
        assert!(!usable(SecretField::DateOfBirth) && !usable(SecretField::IdNumber));
        for items in [&on, &off] {
            let json = serde_json::to_string(items).unwrap();
            for canary in [
                FIXTURE_FULL_NAME,
                FIXTURE_DOB,
                FIXTURE_ID_NUMBER,
                FIXTURE_COUNTRY,
            ] {
                assert!(!json.contains(canary));
            }
        }
    }

    #[tokio::test]
    async fn identity_release_enforces_the_allowed_list_for_sensitive_fields_only() {
        let p = TestProvider::with_fixture();
        let form = |field, origin: &str| ReleaseRequest {
            purpose: SecretPurpose::Form,
            ..rel(FIXTURE_IDENTITY_ID, field, origin)
        };
        // Not sensitive: any site.
        let v = p
            .release(form(SecretField::FullName, "https://other.example.test"))
            .await
            .unwrap();
        assert!(v.expose(|b| b == FIXTURE_FULL_NAME.as_bytes()));
        // Sensitive: only the allowed exact origin.
        let v = p
            .release(form(SecretField::IdNumber, FIXTURE_ORIGIN))
            .await
            .unwrap();
        assert!(v.expose(|b| b == FIXTURE_ID_NUMBER.as_bytes()));
        for origin in [
            "https://other.example.test",
            "https://sub.login.example.test",
        ] {
            assert_eq!(
                p.release(form(SecretField::IdNumber, origin)).await.err(),
                Some(ProviderError::OriginMismatch)
            );
        }
        // Only the purpose `form` releases identity.
        assert!(matches!(
            p.release(rel(FIXTURE_IDENTITY_ID, SecretField::City, FIXTURE_ORIGIN))
                .await
                .err(),
            Some(ProviderError::Refused(_))
        ));
        // A field the item does not have is the identical not found.
        assert_eq!(
            p.release(form(SecretField::Phone, FIXTURE_ORIGIN))
                .await
                .err(),
            Some(ProviderError::NotFound)
        );
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
