//! Owner credential vault (ORK-784, `docs/v2/vault.md`).
//!
//! A login's secret part (URL, domain, username, password, notes, extra
//! fields) is sealed with age, inside its write transaction, for the
//! stored-login reader recipient and the owner's active browser recipients.
//! This server keeps no identity that opens it. Plain metadata is the name,
//! URL, domain and tags. Owner calls need a password-signed-in browser
//! session (`kind='browser'`); errors and audit rows never carry values.
mod import;
mod items;
mod stored_login;
#[cfg(test)]
mod tests;

pub use import::{ImportEntry, ImportGrant, ImportReport, ImportRequest, ImportedItem};
pub use items::{
    AuditEvent, GrantsReplace, ItemCreate, ItemUpdate, LoginReplace, SealedLogin, VaultItemView,
    VaultStatus,
};
pub use stored_login::{StoredLogin, StoredLoginMode, StoredLoginRequest};

use crate::attachment_store::seal;
use orkestr_v2_contracts::OwnerId;
use sqlx::{Row, Sqlite, Transaction};

/// First line of every sealed login; JSON follows.
pub const LOGIN_MAGIC: &str = "ORKESTR-VAULT-LOGIN/1";
pub const IMPORT_FORMAT: &str = "orkestr-vault-import-v1";
pub const IMPORT_REPORT_FORMAT: &str = "orkestr-vault-import-report-v1";
const MAX_ITEMS: i64 = 10_000;
const MAX_NAME: usize = 200;
const MAX_URL: usize = 2048;
const MAX_USERNAME: usize = 512;
const MAX_PASSWORD: usize = 4096;
const MAX_NOTES: usize = 16 * 1024;
const MAX_TAGS: usize = 20;
const MAX_TAG: usize = 40;
const MAX_FIELDS: usize = 50;
const MAX_GRANTS: usize = 50;
const MAX_TOTP_JSON: usize = 4096;
const AUDIT_KEEP: i64 = 20_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VaultError {
    /// Stable machine code of the rejected input.
    Invalid(&'static str),
    Unauthorized,
    NotFound(&'static str),
    /// Stable machine code of the refused precondition.
    Conflict(&'static str),
    Unavailable,
}
pub type Result<T> = std::result::Result<T, VaultError>;
fn db<T>(_: T) -> VaultError {
    VaultError::Unavailable
}

pub(crate) fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// `vi_` and 6 to 64 characters of `[A-Za-z0-9_-]`, the V1 item id shape the
/// stored-login helper accepts.
pub fn item_id_valid(id: &str) -> bool {
    id.strip_prefix("vi_").is_some_and(|rest| {
        (6..=64).contains(&rest.len())
            && rest
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
    })
}
fn new_item_id() -> String {
    format!("vi_{}", uuid::Uuid::new_v4().simple())
}

/// Lower-case host of `url` without `www.` and a trailing dot (V1's
/// `normalizeDomain`). `Some("")` for an empty URL, `None` when no plain DNS
/// host can be read (IP literals with brackets, non-ASCII names, bad ports).
pub fn normalize_domain(url: &str) -> Option<String> {
    let text = url.trim();
    if text.is_empty() {
        return Some(String::new());
    }
    let rest = match text.split_once("://") {
        Some((scheme, rest))
            if !scheme.is_empty()
                && scheme.as_bytes()[0].is_ascii_alphabetic()
                && scheme
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"+.-".contains(&b)) =>
        {
            rest
        }
        _ => text,
    };
    let authority = rest.split(['/', '?', '#']).next().unwrap_or("");
    let host_port = authority.rsplit('@').next().unwrap_or("");
    if host_port.starts_with('[') {
        return None;
    }
    let host = match host_port.rsplit_once(':') {
        Some((host, port)) if port.bytes().all(|b| b.is_ascii_digit()) => host,
        Some(_) => return None,
        None => host_port,
    };
    let mut host = host.to_ascii_lowercase();
    while host.ends_with('.') {
        host.pop();
    }
    let host = host.strip_prefix("www.").unwrap_or(&host).to_owned();
    let valid = !host.is_empty()
        && host.len() <= 253
        && host.split('.').all(|label| {
            (1..=63).contains(&label.len())
                && !label.starts_with('-')
                && !label.ends_with('-')
                && label
                    .bytes()
                    .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        });
    valid.then_some(host)
}

/// Owner-entered logins (create, replace) must carry an `https://` address
/// with a plain DNS host: the stored-login helper only uses a login whose
/// domain matches the site, so an empty or non-https address is unusable.
/// Imports are exempt (they keep unreadable V1 URLs).
pub(crate) fn require_https_address(url: &str) -> Result<()> {
    let text = url.trim();
    if text.is_empty() {
        return Err(VaultError::Invalid("vault_address_required"));
    }
    let https = text
        .get(..8)
        .is_some_and(|scheme| scheme.eq_ignore_ascii_case("https://"));
    if !https {
        return Err(VaultError::Invalid("vault_address_not_https"));
    }
    match normalize_domain(text) {
        Some(domain) if domain.contains('.') => Ok(()),
        _ => Err(VaultError::Invalid("vault_address_invalid")),
    }
}

/// A host the helper may ask for: `[a-z0-9.-]`, 3 to 253 bytes.
pub(crate) fn site_valid(site: &str) -> bool {
    (3..=253).contains(&site.len())
        && site
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'.' || b == b'-')
        && !site.starts_with('.')
        && !site.contains("..")
}
/// Equal to the stored domain or one of its subdomains, never a parent.
pub(crate) fn site_within(site: &str, domain: &str) -> bool {
    domain.contains('.') && (site == domain || site.ends_with(&format!(".{domain}")))
}

fn text(value: &str, max: usize, code: &'static str) -> Result<String> {
    if value.len() > max || value.contains('\0') {
        return Err(VaultError::Invalid(code));
    }
    Ok(value.to_owned())
}
fn name(value: &str) -> Result<String> {
    let value = value.trim();
    if value.is_empty() || value.chars().any(char::is_control) {
        return Err(VaultError::Invalid("vault_name_required"));
    }
    text(value, MAX_NAME, "vault_name_too_large")
}
fn tags(values: &[String]) -> Result<Vec<String>> {
    if values.len() > 100 {
        return Err(VaultError::Invalid("vault_tags_invalid"));
    }
    let mut out: Vec<String> = Vec::new();
    for value in values {
        let tag: String = value
            .trim()
            .to_lowercase()
            .chars()
            .filter(|c| !c.is_control())
            .take(MAX_TAG)
            .collect();
        if !tag.is_empty() && !out.contains(&tag) {
            out.push(tag);
        }
    }
    out.truncate(MAX_TAGS);
    Ok(out)
}
fn thread_ids(values: &[String]) -> Result<Vec<String>> {
    if values.len() > MAX_GRANTS {
        return Err(VaultError::Invalid("vault_grants_invalid"));
    }
    let mut out: Vec<String> = Vec::new();
    for value in values {
        if !orkestr_v2_contracts::v1_thread_id_valid(value) {
            return Err(VaultError::Invalid("vault_grants_invalid"));
        }
        if !out.contains(value) {
            out.push(value.clone());
        }
    }
    Ok(out)
}

/// An extra field carried over from V1 (sealed, never shown as metadata).
#[derive(Clone, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Field {
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub value: String,
}

/// The secret part of one item, before sealing. Not `Debug`: it holds values.
pub(crate) struct Login {
    pub url: String,
    pub domain: String,
    pub username: String,
    pub password: String,
    pub notes: String,
    pub fields: Vec<Field>,
    pub totp: Option<serde_json::Value>,
}
impl Login {
    pub(crate) fn new(url: &str, username: &str, password: &str, notes: &str) -> Result<Self> {
        let url = text(url.trim(), MAX_URL, "vault_url_too_large")?;
        let domain = normalize_domain(&url).ok_or(VaultError::Invalid("vault_url_invalid"))?;
        Ok(Self {
            url,
            domain,
            username: text(username, MAX_USERNAME, "vault_username_too_large")?,
            password: text(password, MAX_PASSWORD, "vault_password_too_large")?,
            notes: text(notes, MAX_NOTES, "vault_notes_too_large")?,
            fields: Vec::new(),
            totp: None,
        })
    }
    pub(crate) fn with_extras(
        mut self,
        fields: &[Field],
        totp: Option<&serde_json::Value>,
    ) -> Result<Self> {
        if fields.len() > MAX_FIELDS {
            return Err(VaultError::Invalid("vault_fields_invalid"));
        }
        for field in fields {
            if field.name.len() > MAX_NAME || field.value.len() > MAX_NOTES {
                return Err(VaultError::Invalid("vault_fields_invalid"));
            }
        }
        self.fields = fields
            .iter()
            .filter(|f| !f.name.is_empty() || !f.value.is_empty())
            .cloned()
            .collect();
        if let Some(totp) = totp.filter(|t| !t.is_null()) {
            if !totp.is_object() || totp.to_string().len() > MAX_TOTP_JSON {
                return Err(VaultError::Invalid("vault_totp_invalid"));
            }
            self.totp = Some(totp.clone());
        }
        Ok(self)
    }
    fn plaintext(&self, owner: &OwnerId, item: &str) -> Vec<u8> {
        let body = serde_json::json!({
            "version": 1,
            "owner_id": owner.to_string(),
            "item_id": item,
            "url": self.url,
            "domain": self.domain,
            "username": self.username,
            "password": self.password,
            "notes": self.notes,
            "fields": self.fields,
            "totp": self.totp,
        });
        format!("{LOGIN_MAGIC}\n{body}").into_bytes()
    }
}

pub(crate) struct Sealed {
    pub ciphertext: Vec<u8>,
    pub sha256: String,
    pub fingerprints: Vec<String>,
}

/// `(fingerprint, recipient)` to seal for: the owner's active browsers and
/// the configured reader. Refuses an empty set.
pub(crate) async fn recipients(
    tx: &mut Transaction<'_, Sqlite>,
    owner: &OwnerId,
    reader: Option<&str>,
) -> Result<Vec<(String, String)>> {
    let mut list = crate::attachment_store::keys::active_recipients(tx, owner)
        .await
        .map_err(db)?;
    if let Some(reader) = reader {
        if seal::parse_recipient(reader).is_none() {
            return Err(VaultError::Unavailable);
        }
        let print = seal::fingerprint(reader);
        if !list.iter().any(|(f, _)| *f == print) {
            list.push((print, reader.to_owned()));
        }
    }
    if list.is_empty() {
        return Err(VaultError::Conflict("vault_recipient_required"));
    }
    Ok(list)
}

pub(crate) fn seal_login(
    recipients: &[(String, String)],
    owner: &OwnerId,
    item: &str,
    login: &Login,
) -> Result<Sealed> {
    let keys: Vec<String> = recipients.iter().map(|(_, r)| r.clone()).collect();
    let ciphertext = seal::encrypt(&keys, &login.plaintext(owner, item)).map_err(db)?;
    if !(64..=131_072).contains(&ciphertext.len()) {
        return Err(VaultError::Invalid("vault_item_too_large"));
    }
    Ok(Sealed {
        sha256: seal::sha256_hex(&ciphertext),
        fingerprints: recipients.iter().map(|(f, _)| f.clone()).collect(),
        ciphertext,
    })
}

/// The owner of an unexpired, password-signed-in browser session. Machine
/// Bearer and service-credential sessions are refused.
pub(crate) async fn browser_owner(
    tx: &mut Transaction<'_, Sqlite>,
    credential: &str,
) -> Result<OwnerId> {
    if !credential.starts_with("browser:") || credential.len() > 1024 {
        return Err(VaultError::Unauthorized);
    }
    let owner: Option<String> = sqlx::query_scalar(
        "SELECT owner_id FROM auth_sessions WHERE token_hash=? AND kind='browser' AND expires_at>unixepoch()",
    )
    .bind(crate::digest(credential))
    .fetch_optional(&mut **tx)
    .await
    .map_err(db)?;
    owner
        .and_then(|o| uuid::Uuid::parse_str(&o).ok())
        .map(OwnerId)
        .ok_or(VaultError::Unauthorized)
}

/// One value-free audit row. Every text is an id, a host, a slug, an
/// operation id or a fixed code; values never reach this table.
#[derive(Default)]
pub(crate) struct Audit<'a> {
    pub item: Option<&'a str>,
    pub conversation: Option<&'a str>,
    pub desk: Option<&'a str>,
    pub site: Option<&'a str>,
    pub operation: Option<&'a str>,
    pub detail: Option<&'a str>,
}
pub(crate) async fn audit(
    tx: &mut Transaction<'_, Sqlite>,
    owner: &OwnerId,
    event: &'static str,
    entry: Audit<'_>,
) -> Result<()> {
    sqlx::query("INSERT INTO vault_audit(owner_id,at_ms,event,item_id,conversation_id,desk,site,operation,detail) VALUES(?,?,?,?,?,?,?,?,?)")
        .bind(owner.to_string()).bind(now_ms()).bind(event)
        .bind(entry.item).bind(entry.conversation).bind(entry.desk).bind(entry.site)
        .bind(entry.operation.filter(|o| !o.is_empty())).bind(entry.detail)
        .execute(&mut **tx).await.map_err(db)?;
    sqlx::query(
        "DELETE FROM vault_audit WHERE owner_id=? AND sequence<(SELECT sequence FROM vault_audit WHERE owner_id=? ORDER BY sequence DESC LIMIT 1 OFFSET ?)",
    )
    .bind(owner.to_string())
    .bind(owner.to_string())
    .bind(AUDIT_KEEP - 1)
    .execute(&mut **tx)
    .await
    .map_err(db)?;
    Ok(())
}

/// Plain metadata of one stored row.
pub(crate) struct StoredRow {
    pub id: String,
    pub name: String,
    pub url: String,
    pub domain: String,
    pub tags: Vec<String>,
    pub has_password: bool,
    pub has_totp: bool,
    pub single_use: bool,
    pub recipients: Vec<String>,
    pub revision: i64,
    pub created_at_ms: i64,
    pub updated_at_ms: i64,
    pub login_updated_at_ms: i64,
    pub last_used_at_ms: Option<i64>,
}
pub(crate) const ROW_COLUMNS: &str = "id,name,url,domain,tags_json,has_password,has_totp,single_use,recipients_json,revision,created_at_ms,updated_at_ms,login_updated_at_ms,last_used_at_ms";
pub(crate) fn row_of(row: &sqlx::sqlite::SqliteRow) -> Result<StoredRow> {
    let list = |column: &str| -> Result<Vec<String>> {
        serde_json::from_str(row.try_get::<String, _>(column).map_err(db)?.as_str()).map_err(db)
    };
    Ok(StoredRow {
        id: row.try_get("id").map_err(db)?,
        name: row.try_get("name").map_err(db)?,
        url: row.try_get("url").map_err(db)?,
        domain: row.try_get("domain").map_err(db)?,
        tags: list("tags_json")?,
        has_password: row.try_get("has_password").map_err(db)?,
        has_totp: row.try_get("has_totp").map_err(db)?,
        single_use: row.try_get("single_use").map_err(db)?,
        recipients: list("recipients_json")?,
        revision: row.try_get("revision").map_err(db)?,
        created_at_ms: row.try_get("created_at_ms").map_err(db)?,
        updated_at_ms: row.try_get("updated_at_ms").map_err(db)?,
        login_updated_at_ms: row.try_get("login_updated_at_ms").map_err(db)?,
        last_used_at_ms: row.try_get("last_used_at_ms").map_err(db)?,
    })
}
pub(crate) async fn owned_row(
    tx: &mut Transaction<'_, Sqlite>,
    owner: &OwnerId,
    id: &str,
) -> Result<StoredRow> {
    if !item_id_valid(id) {
        return Err(VaultError::NotFound("vault_item_not_found"));
    }
    let row = sqlx::query(&format!(
        "SELECT {ROW_COLUMNS} FROM vault_items WHERE id=? AND owner_id=?"
    ))
    .bind(id)
    .bind(owner.to_string())
    .fetch_optional(&mut **tx)
    .await
    .map_err(db)?
    .ok_or(VaultError::NotFound("vault_item_not_found"))?;
    row_of(&row)
}
