//! The OpenBao store: a KV v2 mount on a loopback address (ORK-826).
//!
//! The server signs in with an AppRole that may write values and read, list
//! and edit metadata, but cannot read a value. Each credential is
//! `<mount>/data/<prefix>/<slug>` with custom metadata `type`, `site`,
//! `label` and `allowed` (chat ids and/or `owner-desks`). Writes set
//! `source=orkestr-page`, so an import that only updates what it wrote leaves
//! them alone. Deleting soft-deletes the current version, which the store's
//! own `undelete` can restore. Every request names this tool in the
//! `X-Orkestr-Tool` header for the store's audit log.
use super::loopback::{self, HttpError};
use super::model::{self, CredentialView, Kind, Usage, OWNER_DESKS};
use serde_json::{json, Map, Value};
use std::net::SocketAddr;
use std::time::{Duration, Instant};

pub(crate) const SOURCE: &str = "orkestr-page";
const TOOL: &str = "credentials-page";
const TIMEOUT: Duration = Duration::from_secs(10);
/// KV v2 limits one metadata value to 512 characters.
const MAX_META_VALUE: usize = 512;
/// Keys read from one listing.
const MAX_KEYS: usize = 20_000;
/// Without a catalog, at most this many credentials are read per page load.
const DIRECT_MAX: usize = 200;
/// A write of this server stays on the page until a catalog this much newer.
const OVERLAY_MARGIN_MS: i64 = 5_000;

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum BaoError {
    Unavailable,
    RateLimited,
    Refused,
    NotFound,
    Changed,
    Invalid(&'static str),
}

pub(crate) struct OpenBao {
    address: SocketAddr,
    mount: String,
    prefix: String,
    role_id: String,
    secret_id: String,
    reveal_url: Option<String>,
    catalog: Option<std::path::PathBuf>,
    token: tokio::sync::Mutex<Option<(String, Instant)>>,
    /// This server's own recent writes (`None`: deleted), shown until the
    /// catalog has caught up with them.
    recent: std::sync::Mutex<std::collections::HashMap<String, (Option<CredentialView>, i64)>>,
}

/// One listing: rows, whether it was cut short, and the catalog's time.
pub(crate) struct Listing {
    pub(crate) rows: Vec<CredentialView>,
    pub(crate) truncated: bool,
    pub(crate) catalog_at_ms: Option<i64>,
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as i64)
}

/// One credential's metadata as the store returns it.
struct Meta {
    custom: Map<String, Value>,
    version: i64,
    updated_time: String,
    deleted: bool,
}

impl OpenBao {
    pub(crate) fn new(
        address: SocketAddr,
        mount: String,
        prefix: String,
        role_id: String,
        secret_id: String,
        reveal_url: Option<String>,
        catalog: Option<std::path::PathBuf>,
    ) -> Self {
        Self {
            address,
            mount,
            prefix,
            role_id,
            secret_id,
            reveal_url,
            catalog,
            token: tokio::sync::Mutex::new(None),
            recent: Default::default(),
        }
    }

    fn remember(&self, slug: &str, row: Option<CredentialView>) {
        if let Ok(mut recent) = self.recent.lock() {
            if recent.len() >= 1000 {
                recent.clear(); // without a catalog nothing reads it; stay bounded
            }
            recent.insert(slug.to_owned(), (row, now_ms()));
        }
    }

    /// The owner's own view of one credential in the store's UI, if configured.
    pub(crate) fn reveal_url(&self) -> Option<&str> {
        self.reveal_url.as_deref()
    }

    async fn send(
        &self,
        method: &str,
        path: &str,
        token: Option<&str>,
        body: Option<(&str, Vec<u8>)>,
    ) -> Result<(u16, Value), BaoError> {
        let mut headers = vec![("X-Orkestr-Tool", TOOL)];
        if let Some(token) = token {
            headers.push(("X-Vault-Token", token));
        }
        let mut body = body;
        let answer = loopback::request(
            self.address,
            method,
            &format!("/v1/{path}"),
            &headers,
            body.as_ref().map(|(kind, bytes)| (*kind, bytes.as_slice())),
            TIMEOUT,
        )
        .await;
        if let Some((_, bytes)) = body.as_mut() {
            bytes.fill(0);
        }
        let answer = answer.map_err(|error| match error {
            HttpError::Timeout
            | HttpError::Unreachable
            | HttpError::Malformed
            | HttpError::TooLarge => BaoError::Unavailable,
        })?;
        let value = if answer.body.is_empty() {
            Value::Null
        } else {
            serde_json::from_slice(&answer.body).unwrap_or(Value::Null)
        };
        Ok((answer.status, value))
    }

    async fn login(&self) -> Result<(String, Instant), BaoError> {
        let body =
            serde_json::to_vec(&json!({"role_id": self.role_id, "secret_id": self.secret_id}))
                .map_err(|_| BaoError::Unavailable)?;
        let (status, value) = self
            .send(
                "POST",
                "auth/approle/login",
                None,
                Some(("application/json", body)),
            )
            .await?;
        match status {
            200 => {}
            429 => return Err(BaoError::RateLimited),
            _ => return Err(BaoError::Unavailable),
        }
        let token = value["auth"]["client_token"]
            .as_str()
            .filter(|t| !t.is_empty());
        let lease = value["auth"]["lease_duration"].as_u64().unwrap_or(60);
        let token = token.ok_or(BaoError::Unavailable)?.to_owned();
        // Renewed well before it ends; a short lease is used only briefly.
        let life = Duration::from_secs(lease.saturating_sub(30).max(5));
        Ok((token, Instant::now() + life))
    }

    /// An authenticated request; a token the store no longer accepts is
    /// replaced once.
    async fn call(
        &self,
        method: &str,
        path: &str,
        body: Option<Value>,
        patch: bool,
    ) -> Result<(u16, Value), BaoError> {
        for attempt in 0..2 {
            let token = {
                let mut held = self.token.lock().await;
                match held.as_ref() {
                    Some((token, until)) if *until > Instant::now() && attempt == 0 => {
                        token.clone()
                    }
                    _ => {
                        let fresh = self.login().await?;
                        let token = fresh.0.clone();
                        *held = Some(fresh);
                        token
                    }
                }
            };
            let kind = if patch {
                "application/merge-patch+json"
            } else {
                "application/json"
            };
            let bytes = match &body {
                Some(value) => Some((
                    kind,
                    serde_json::to_vec(value).map_err(|_| BaoError::Unavailable)?,
                )),
                None => None,
            };
            let (status, value) = self.send(method, path, Some(&token), bytes).await?;
            if status == 403 && attempt == 0 {
                continue; // an expired or revoked token: sign in again once
            }
            return match status {
                429 => Err(BaoError::RateLimited),
                403 => Err(BaoError::Refused),
                500..=599 => Err(BaoError::Unavailable),
                _ => Ok((status, value)),
            };
        }
        Err(BaoError::Refused)
    }

    fn metadata_path(&self, slug: &str) -> String {
        format!("{}/metadata/{}/{slug}", self.mount, self.prefix)
    }
    fn data_path(&self, slug: &str) -> String {
        format!("{}/data/{}/{slug}", self.mount, self.prefix)
    }

    async fn keys(&self) -> Result<Vec<String>, BaoError> {
        let (status, value) = self
            .call(
                "LIST",
                &format!("{}/metadata/{}/", self.mount, self.prefix),
                None,
                false,
            )
            .await?;
        match status {
            404 => Ok(Vec::new()),
            200 => Ok(value["data"]["keys"]
                .as_array()
                .map(|keys| {
                    keys.iter()
                        .filter_map(Value::as_str)
                        .filter(|k| model::slug_valid(k))
                        .take(MAX_KEYS)
                        .map(str::to_owned)
                        .collect()
                })
                .unwrap_or_default()),
            _ => Err(BaoError::Unavailable),
        }
    }

    async fn meta(&self, slug: &str) -> Result<Option<Meta>, BaoError> {
        let (status, value) = self
            .call("GET", &self.metadata_path(slug), None, false)
            .await?;
        match status {
            404 => Ok(None),
            200 => {
                let data = &value["data"];
                let version = data["current_version"].as_i64().unwrap_or(0);
                let current = &data["versions"][version.to_string()];
                let deleted = version < 1
                    || current["destroyed"] == true
                    || current["deletion_time"]
                        .as_str()
                        .is_some_and(|t| !t.is_empty());
                Ok(Some(Meta {
                    custom: data["custom_metadata"]
                        .as_object()
                        .cloned()
                        .unwrap_or_default(),
                    version,
                    updated_time: data["updated_time"].as_str().unwrap_or_default().to_owned(),
                    deleted,
                }))
            }
            _ => Err(BaoError::Unavailable),
        }
    }

    /// Every live credential with a known type, as page rows (no usage yet):
    /// from the root job's catalog plus this server's newer writes, or, without
    /// a fresh catalog, read from the store (at most [`DIRECT_MAX`]).
    pub(crate) async fn list(&self) -> Result<Listing, BaoError> {
        let now = now_ms();
        if let Some(catalog) = self
            .catalog
            .as_deref()
            .and_then(|p| super::catalog::Catalog::load(p, now))
        {
            let mut rows = catalog.rows;
            if let Ok(mut recent) = self.recent.lock() {
                recent.retain(|_, (_, at)| *at + OVERLAY_MARGIN_MS > catalog.generated_at_ms);
                for (slug, (row, _)) in recent.iter() {
                    rows.retain(|r| &r.id != slug);
                    if let Some(row) = row {
                        rows.push(row.clone());
                    }
                }
            }
            return Ok(Listing {
                rows,
                truncated: false,
                catalog_at_ms: Some(catalog.generated_at_ms),
            });
        }
        let keys = self.keys().await?;
        let truncated = keys.len() > DIRECT_MAX;
        let mut rows = Vec::new();
        for slug in keys.into_iter().take(DIRECT_MAX) {
            if let Some(meta) = self.meta(&slug).await? {
                if let Some(view) = view(&slug, &meta) {
                    rows.push(view);
                }
            }
        }
        Ok(Listing {
            rows,
            truncated,
            catalog_at_ms: None,
        })
    }

    /// The current row of one live credential.
    pub(crate) async fn current(&self, slug: &str) -> Result<CredentialView, BaoError> {
        if !model::slug_valid(slug) {
            return Err(BaoError::NotFound);
        }
        let meta = self.meta(slug).await?.ok_or(BaoError::NotFound)?;
        view(slug, &meta).ok_or(BaoError::NotFound)
    }

    async fn live(&self, slug: &str, expected: &str) -> Result<Meta, BaoError> {
        if !model::slug_valid(slug) {
            return Err(BaoError::NotFound);
        }
        let Some(meta) = self.meta(slug).await? else {
            self.remember(slug, None);
            return Err(BaoError::NotFound);
        };
        let Some(row) = view(slug, &meta) else {
            self.remember(slug, None);
            return Err(BaoError::NotFound);
        };
        if revision(&meta) != expected {
            // A stale row (an older catalog): the reload shows the store's state.
            self.remember(slug, Some(row));
            return Err(BaoError::Changed);
        }
        Ok(meta)
    }

    async fn write_meta(&self, slug: &str, custom: Map<String, Value>) -> Result<(), BaoError> {
        let (status, _) = self
            .call(
                "POST",
                &self.metadata_path(slug),
                Some(json!({"custom_metadata": custom})),
                false,
            )
            .await?;
        match status {
            200 | 204 => Ok(()),
            400 => Err(BaoError::Invalid("credential_allowed_too_many")),
            _ => Err(BaoError::Unavailable),
        }
    }

    async fn reread(&self, slug: &str) -> Result<CredentialView, BaoError> {
        let meta = self.meta(slug).await?.ok_or(BaoError::Unavailable)?;
        let row = view(slug, &meta).ok_or(BaoError::Unavailable)?;
        self.remember(slug, Some(row.clone()));
        Ok(row)
    }

    pub(crate) async fn create(
        &self,
        kind: Kind,
        label: &str,
        site: &str,
        allowed: &[String],
        owner_desks: bool,
        fields: &[(&'static str, &str)],
    ) -> Result<CredentialView, BaoError> {
        let taken = self.keys().await?;
        let base = model::slug(label);
        let slug = std::iter::once(base.clone())
            .chain((2..1000).map(|n| format!("{base}-{n}")))
            .find(|s| !taken.contains(s))
            .ok_or(BaoError::Invalid("credential_label_invalid"))?;
        let custom = custom_metadata(&Map::new(), kind, label, site, allowed, owner_desks)?;
        // Metadata first: a value never exists without its type and grants.
        self.write_meta(&slug, custom).await?;
        let data: Map<String, Value> = fields
            .iter()
            .map(|(k, v)| ((*k).to_owned(), json!(v)))
            .collect();
        let written = self
            .call(
                "POST",
                &self.data_path(&slug),
                Some(json!({"options": {"cas": 0}, "data": data})),
                false,
            )
            .await;
        match written {
            Ok((200 | 204, _)) => self.reread(&slug).await,
            other => {
                let _ = self
                    .call("DELETE", &self.metadata_path(&slug), None, false)
                    .await;
                match other {
                    Ok((400, _)) => Err(BaoError::Changed),
                    Ok(_) => Err(BaoError::Unavailable),
                    Err(error) => Err(error),
                }
            }
        }
    }

    pub(crate) async fn update(
        &self,
        slug: &str,
        expected: &str,
        label: Option<&str>,
        site: Option<&str>,
        allowed: Option<&[String]>,
        owner_desks: Option<bool>,
    ) -> Result<CredentialView, BaoError> {
        let meta = self.live(slug, expected).await?;
        let current = view(slug, &meta).ok_or(BaoError::NotFound)?;
        let site = site.unwrap_or(&current.site);
        if current.kind == Kind::Password && site.is_empty() {
            return Err(BaoError::Invalid("credential_site_required"));
        }
        let custom = custom_metadata(
            &meta.custom,
            current.kind,
            label.unwrap_or(&current.label),
            site,
            allowed.unwrap_or(&current.allowed),
            owner_desks.unwrap_or(current.owner_desks),
        )?;
        self.write_meta(slug, custom).await?;
        self.reread(slug).await
    }

    /// Changes only the given value fields; the others stay as they are.
    pub(crate) async fn replace_value(
        &self,
        slug: &str,
        expected: &str,
        fields: &[(&'static str, &str)],
    ) -> Result<CredentialView, BaoError> {
        let meta = self.live(slug, expected).await?;
        let data: Map<String, Value> = fields
            .iter()
            .map(|(k, v)| ((*k).to_owned(), json!(v)))
            .collect();
        let (status, _) = self
            .call(
                "PATCH",
                &self.data_path(slug),
                Some(json!({"options": {"cas": meta.version}, "data": data})),
                true,
            )
            .await?;
        match status {
            200 | 204 => {}
            400 => return Err(BaoError::Changed),
            404 => return Err(BaoError::NotFound),
            _ => return Err(BaoError::Unavailable),
        }
        let mut custom = meta.custom.clone();
        custom.insert("source".into(), json!(SOURCE));
        self.write_meta(slug, custom).await?;
        self.reread(slug).await
    }

    pub(crate) async fn delete(&self, slug: &str, expected: &str) -> Result<(), BaoError> {
        let meta = self.live(slug, expected).await?;
        let mut custom = meta.custom.clone();
        custom.insert("source".into(), json!(SOURCE));
        self.write_meta(slug, custom).await?;
        let (status, _) = self
            .call(
                "POST",
                &format!("{}/delete/{}/{slug}", self.mount, self.prefix),
                Some(json!({"versions": [meta.version]})),
                false,
            )
            .await?;
        match status {
            200 | 204 => {
                self.remember(slug, None);
                Ok(())
            }
            404 => Err(BaoError::NotFound),
            _ => Err(BaoError::Unavailable),
        }
    }
}

fn revision(meta: &Meta) -> String {
    format!("{}:{}", meta.version, meta.updated_time)
}

/// The page row for one metadata answer; `None` for a deleted credential or
/// one without a known type (not written by Orkestr).
fn view(slug: &str, meta: &Meta) -> Option<CredentialView> {
    if meta.deleted {
        return None;
    }
    let text = |key: &str| {
        meta.custom
            .get(key)
            .and_then(Value::as_str)
            .unwrap_or_default()
    };
    let kind = Kind::parse(text("type"))?;
    let site = text("site").to_ascii_lowercase();
    let site = if model::domain(&site) {
        site
    } else {
        String::new()
    };
    let mut owner_desks = false;
    let mut allowed = Vec::new();
    for part in text("allowed")
        .split(',')
        .map(str::trim)
        .filter(|p| !p.is_empty())
    {
        if part == OWNER_DESKS {
            owner_desks = true;
        } else if uuid::Uuid::parse_str(part).is_ok() && !allowed.iter().any(|a| a == part) {
            allowed.push(part.to_ascii_lowercase());
        }
    }
    let label = match text("label").trim() {
        "" => slug.to_owned(),
        label => label.chars().take(200).collect(),
    };
    Some(CredentialView {
        id: slug.to_owned(),
        label,
        kind,
        site,
        allowed,
        owner_desks,
        revision: revision(meta),
        updated_at_ms: rfc3339_ms(&meta.updated_time),
        fields: Vec::new(),
        usage: Usage::default(),
    })
}

/// The new custom metadata: the old keys kept (import bookkeeping such as
/// `legacy_id`), the page's own keys set, empty ones removed (the store
/// refuses empty values).
fn custom_metadata(
    old: &Map<String, Value>,
    kind: Kind,
    label: &str,
    site: &str,
    allowed: &[String],
    owner_desks: bool,
) -> Result<Map<String, Value>, BaoError> {
    let mut custom = old.clone();
    let mut grants: Vec<&str> = allowed.iter().map(String::as_str).collect();
    if owner_desks {
        grants.push(OWNER_DESKS);
    }
    let grants = grants.join(",");
    if grants.len() > MAX_META_VALUE {
        return Err(BaoError::Invalid("credential_allowed_too_many"));
    }
    for (key, value) in [
        ("type", kind.as_str()),
        ("label", label),
        ("site", site),
        ("allowed", grants.as_str()),
        ("source", SOURCE),
    ] {
        if value.is_empty() {
            custom.remove(key);
        } else {
            custom.insert(key.into(), json!(value));
        }
    }
    Ok(custom)
}

/// `2026-01-02T03:04:05.678901Z` (or an offset) to Unix milliseconds.
pub(crate) fn rfc3339_ms(text: &str) -> Option<i64> {
    let b = text.as_bytes();
    if b.len() < 20
        || b[4] != b'-'
        || b[7] != b'-'
        || !matches!(b[10], b'T' | b't')
        || b[13] != b':'
        || b[16] != b':'
    {
        return None;
    }
    let num = |range: std::ops::Range<usize>| -> Option<i64> { text.get(range)?.parse().ok() };
    let (year, month, day) = (num(0..4)?, num(5..7)?, num(8..10)?);
    let (hour, minute, second) = (num(11..13)?, num(14..16)?, num(17..19)?);
    if !(1..=12).contains(&month)
        || !(1..=31).contains(&day)
        || hour > 23
        || minute > 59
        || second > 60
    {
        return None;
    }
    let mut rest = &text[19..];
    let mut millis = 0;
    if let Some(fraction) = rest.strip_prefix('.') {
        let digits = fraction.bytes().take_while(u8::is_ascii_digit).count();
        if digits == 0 {
            return None;
        }
        let padded = format!("{:0<3}", &fraction[..digits.min(3)]);
        millis = padded.parse::<i64>().ok()?;
        rest = &fraction[digits..];
    }
    let offset_minutes = match rest {
        "Z" | "z" => 0,
        _ if rest.len() == 6 && matches!(&rest[..1], "+" | "-") && &rest[3..4] == ":" => {
            let sign = if rest.starts_with('-') { -1 } else { 1 };
            sign * (rest[1..3].parse::<i64>().ok()? * 60 + rest[4..6].parse::<i64>().ok()?)
        }
        _ => return None,
    };
    // Days from the civil date (proleptic Gregorian), 1970-01-01 = 0.
    let y = if month <= 2 { year - 1 } else { year };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = (month + 9) % 12;
    let doy = (153 * mp + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    let seconds = days * 86_400 + hour * 3600 + minute * 60 + second - offset_minutes * 60;
    Some(seconds * 1000 + millis)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn meta(custom: Value, version: i64, deleted: bool) -> Meta {
        Meta {
            custom: custom.as_object().cloned().unwrap(),
            version,
            updated_time: "2026-11-14T13:15:08.640969258Z".into(),
            deleted,
        }
    }

    #[test]
    fn rows_come_from_metadata_only() {
        let chat = "00000000-0000-4000-8000-00000000000a";
        let row = view(
            "search",
            &meta(json!({"type": "api_key", "site": "Search.Example.com", "label": "Search", "allowed": format!("{chat}, owner-desks ,junk"), "legacy_id": "vi_x"}), 3, false),
        )
        .unwrap();
        assert_eq!(
            (row.kind, row.site.as_str(), row.label.as_str()),
            (Kind::ApiKey, "search.example.com", "Search")
        );
        assert_eq!(
            (row.allowed, row.owner_desks),
            (vec![chat.to_string()], true)
        );
        assert_eq!(row.revision, "3:2026-11-14T13:15:08.640969258Z");
        assert!(view("x", &meta(json!({"type": "password"}), 2, true)).is_none());
        assert!(view("x", &meta(json!({"type": "ssh_key"}), 1, false)).is_none());
        assert_eq!(
            view("bare", &meta(json!({"type": "token"}), 1, false))
                .unwrap()
                .label,
            "bare"
        );
    }

    #[test]
    fn page_writes_keep_import_keys_and_drop_empty_values() {
        let old = json!({"legacy_id": "vi_x", "source": "v2-vault-import", "site": "old.example.com", "tags": "a"});
        let custom = custom_metadata(
            old.as_object().unwrap(),
            Kind::Token,
            "CI token",
            "",
            &[],
            false,
        )
        .unwrap();
        assert_eq!(
            Value::Object(custom),
            json!({"legacy_id": "vi_x", "source": SOURCE, "tags": "a", "type": "token", "label": "CI token"})
        );
        let many: Vec<String> = (0..14)
            .map(|n| format!("00000000-0000-4000-8000-{n:012}"))
            .collect();
        assert_eq!(
            custom_metadata(&Map::new(), Kind::Password, "x", "example.com", &many, true).err(),
            Some(BaoError::Invalid("credential_allowed_too_many"))
        );
        assert!(custom_metadata(
            &Map::new(),
            Kind::Password,
            "x",
            "example.com",
            &many[..13],
            false
        )
        .is_ok());
    }

    #[test]
    fn store_times_become_milliseconds() {
        assert_eq!(rfc3339_ms("1970-01-01T00:00:00Z"), Some(0));
        assert_eq!(
            rfc3339_ms("2026-11-14T13:15:08.640969258Z"),
            Some(1_794_662_108_640)
        );
        assert_eq!(
            rfc3339_ms("2026-11-14T14:15:08.6+01:00"),
            Some(1_794_662_108_600)
        );
        for bad in [
            "",
            "2026-11-14",
            "2026-13-01T00:00:00Z",
            "2026-11-14T13:15:08",
            "2026-11-14T13:15:08.Z",
        ] {
            assert_eq!(rfc3339_ms(bad), None, "{bad}");
        }
    }
}
