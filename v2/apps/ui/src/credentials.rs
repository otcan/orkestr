//! The credentials page's data and wording (ORK-826): what `/api/v2/credentials`
//! answers, chat names for the ids it uses, search, filters and the owner-facing
//! status text. No value ever reaches this module.
use orkestr_v2_contracts::SidebarEntry;
use serde::Deserialize;
use std::collections::BTreeMap;

#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
pub struct Page {
    pub backend: String,
    pub capabilities: Capabilities,
    pub credentials: Vec<Credential>,
    #[serde(default)]
    pub truncated: bool,
    #[serde(default)]
    pub usage: UsageInfo,
}

#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
pub struct UsageInfo {
    pub observed_at_ms: Option<i64>,
    #[serde(default)]
    pub stale: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
pub struct Capabilities {
    pub types: Vec<String>,
    /// `conversation` or `v1_thread`: what an allowed chat id names.
    pub grant_ids: String,
    pub owner_desks_editable: bool,
    /// The store changes the site only together with the value.
    pub site_with_value: bool,
    /// `fields` (only what is filled in changes) or `whole`.
    pub value_replace: String,
    /// `browser`, `external` or `none`.
    pub reveal: String,
    pub reveal_url: Option<String>,
    #[serde(default)]
    pub vault_import: bool,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct Credential {
    pub id: String,
    pub label: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub site: String,
    pub allowed: Vec<String>,
    pub owner_desks: bool,
    pub revision: String,
    pub updated_at_ms: Option<i64>,
    #[serde(default)]
    pub usage: Usage,
}

#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
pub struct Usage {
    pub last_used_at_ms: Option<i64>,
    pub last_used_by: Option<String>,
    #[serde(default)]
    pub chats: Vec<ChatUse>,
    #[serde(default)]
    pub status: String,
    pub status_at_ms: Option<i64>,
    pub status_detail: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct ChatUse {
    pub id: String,
    pub last_at_ms: i64,
    pub uses: u64,
}

pub const TYPES: [(&str, &str); 3] = [
    ("password", "Password"),
    ("token", "Token"),
    ("api_key", "API key"),
];

pub fn type_label(kind: &str) -> &'static str {
    TYPES
        .iter()
        .find(|(k, _)| *k == kind)
        .map_or("Credential", |(_, l)| l)
}

/// The value field each type stores, with its owner-facing name.
pub fn secret_field(kind: &str) -> (&'static str, &'static str) {
    match kind {
        "token" => ("token", "Token"),
        "api_key" => ("api_key", "API key"),
        _ => ("password", "Password"),
    }
}

/// Chat names for the ids credentials use: conversation ids and, for the
/// built-in vault, V1 thread ids. Built from the sidebar the app already lists.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct ChatNames {
    conversations: BTreeMap<String, String>,
    threads: BTreeMap<String, String>,
}

impl ChatNames {
    pub fn from_sidebar(entries: &[SidebarEntry]) -> Self {
        let mut names = ChatNames::default();
        for entry in entries {
            if let Some(id) = &entry.conversation_id {
                names
                    .conversations
                    .insert(id.to_string(), entry.name.clone());
            }
            if let Some(thread) = &entry.v1_thread_id {
                // A V2 conversation imported from a V1 chat keeps that chat's name.
                names
                    .threads
                    .entry(thread.clone())
                    .and_modify(|n| {
                        if entry.conversation_id.is_some() {
                            n.clone_from(&entry.name)
                        }
                    })
                    .or_insert_with(|| entry.name.clone());
            }
        }
        names
    }
    pub fn name(&self, id: &str) -> Option<&str> {
        self.conversations
            .get(id)
            .or_else(|| self.threads.get(id))
            .map(String::as_str)
    }
    /// A chat's name, or a plain stand-in for one this list does not show.
    pub fn label(&self, id: &str) -> String {
        self.name(id)
            .map_or_else(|| "Chat not in your list".into(), str::to_owned)
    }
    /// The chats the picker offers, by name: conversations, or V1 chats.
    pub fn choices(&self, grant_ids: &str) -> Vec<(String, String)> {
        let source = if grant_ids == "v1_thread" {
            &self.threads
        } else {
            &self.conversations
        };
        let mut out: Vec<(String, String)> = source
            .iter()
            .map(|(id, name)| (id.clone(), name.clone()))
            .collect();
        out.sort_by(|a, b| {
            a.1.to_lowercase()
                .cmp(&b.1.to_lowercase())
                .then(a.0.cmp(&b.0))
        });
        out
    }
}

/// The "Used by" column: chat names, then the owner's desks.
pub fn used_by(credential: &Credential, names: &ChatNames) -> Vec<String> {
    let mut out: Vec<String> = credential
        .allowed
        .iter()
        .map(|id| names.label(id))
        .collect();
    if credential.owner_desks {
        out.push(DESKS.into());
    }
    out
}
pub const DESKS: &str = "Your desks (automatic sign-in)";

/// Search over name, site, type and chat names; `kind` empty means every type.
pub fn matches(credential: &Credential, names: &ChatNames, query: &str, kind: &str) -> bool {
    if !kind.is_empty() && credential.kind != kind {
        return false;
    }
    let query = query.trim().to_lowercase();
    if query.is_empty() {
        return true;
    }
    let mut haystack = vec![
        credential.label.to_lowercase(),
        credential.site.to_lowercase(),
        type_label(&credential.kind).to_lowercase(),
    ];
    haystack.extend(
        used_by(credential, names)
            .into_iter()
            .map(|n| n.to_lowercase()),
    );
    query
        .split_whitespace()
        .all(|word| haystack.iter().any(|h| h.contains(word)))
}

/// `(label, tone)` of the status column; tones: good, bad, warn, muted.
pub fn status(credential: &Credential) -> (&'static str, &'static str) {
    match credential.usage.status.as_str() {
        "ok" => ("OK", "good"),
        "failed" => ("Failed last sign-in", "bad"),
        "needs_2fa" => ("Needs 2FA code", "warn"),
        _ => ("Never used", "muted"),
    }
}

/// Plain words for a sign-in outcome code.
pub fn status_detail(code: &str) -> String {
    match code {
        "logged_in" => "signed in".into(),
        "already_logged_in" => "was already signed in".into(),
        "login_failed" => "the site rejected it".into(),
        "account_locked" => "the account is locked".into(),
        "login_incomplete" => "the sign-in did not finish".into(),
        "code_required" | "sms_code_page_not_open" => "the site asked for a code".into(),
        "sms_code_rejected" => "the code was not accepted".into(),
        "approval_timeout" => "the approval on your phone timed out".into(),
        "captcha_required" | "captcha_failed" => "a security check (CAPTCHA) stopped it".into(),
        "login_form_not_found" | "submit_not_found" => "the sign-in form was not found".into(),
        other => other.replace(['_', ':'], " "),
    }
}

const MONTHS: [&str; 12] = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

fn civil(ms: i64) -> (i64, usize, i64, i64, i64) {
    let secs = ms.div_euclid(1000);
    let days = secs.div_euclid(86_400);
    let rest = secs.rem_euclid(86_400);
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    (
        year,
        (month - 1) as usize,
        day,
        rest / 3600,
        rest % 3600 / 60,
    )
}

/// `14 Nov 2026, 13:05 UTC`, for a title attribute.
pub fn absolute_time(ms: i64) -> String {
    let (year, month, day, hour, minute) = civil(ms);
    format!("{day} {} {year}, {hour:02}:{minute:02} UTC", MONTHS[month])
}

/// `just now`, `5 min ago`, `3 h ago`, `2 days ago`, then the date.
pub fn ago(now_ms: i64, at_ms: i64) -> String {
    let seconds = (now_ms - at_ms).max(0) / 1000;
    match seconds {
        0..60 => "just now".into(),
        60..3_600 => format!("{} min ago", seconds / 60),
        3_600..86_400 => format!("{} h ago", seconds / 3_600),
        86_400..172_800 => "yesterday".into(),
        172_800..604_800 => format!("{} days ago", seconds / 86_400),
        _ => {
            let (year, month, day, _, _) = civil(at_ms);
            if civil(now_ms).0 == year {
                format!("{day} {}", MONTHS[month])
            } else {
                format!("{day} {} {year}", MONTHS[month])
            }
        }
    }
}

/// "Last used": when, and by which chat.
pub fn last_used(
    credential: &Credential,
    names: &ChatNames,
    now_ms: i64,
) -> Option<(String, Option<String>)> {
    let at = credential.usage.last_used_at_ms?;
    let by = credential
        .usage
        .last_used_by
        .as_deref()
        .map(|id| names.label(id));
    Some((ago(now_ms, at), by))
}

/// The store's own view of one credential (`{id}` in the configured address).
pub fn reveal_link(capabilities: &Capabilities, id: &str) -> Option<String> {
    let template = capabilities.reveal_url.as_deref()?;
    let safe = !id.is_empty()
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_');
    (capabilities.reveal == "external" && safe).then(|| template.replace("{id}", id))
}

/// One owner edit as the routes want it: the metadata change (if any) and
/// whether the value is replaced too. Unchanged fields are left out.
pub fn metadata_change(
    before: &Credential,
    label: &str,
    site: &str,
    allowed: &[String],
    owner_desks: bool,
    capabilities: &Capabilities,
) -> Option<serde_json::Value> {
    let mut change = serde_json::Map::new();
    if label.trim() != before.label {
        change.insert("label".into(), label.trim().into());
    }
    if !capabilities.site_with_value && site.trim() != before.site {
        change.insert("site".into(), site.trim().into());
    }
    let mut sorted_before = before.allowed.clone();
    sorted_before.sort();
    let mut sorted_after = allowed.to_vec();
    sorted_after.sort();
    if sorted_before != sorted_after {
        change.insert("allowed".into(), allowed.to_vec().into());
    }
    if capabilities.owner_desks_editable && owner_desks != before.owner_desks {
        change.insert("owner_desks".into(), owner_desks.into());
    }
    if change.is_empty() {
        return None;
    }
    change.insert("expected_revision".into(), before.revision.clone().into());
    Some(serde_json::Value::Object(change))
}

/// What a confirmation lists before an edit is saved.
pub fn change_summary(
    before: &Credential,
    change: Option<&serde_json::Value>,
    value: bool,
    names: &ChatNames,
) -> Vec<String> {
    let mut out = Vec::new();
    if let Some(change) = change {
        if let Some(label) = change["label"].as_str() {
            out.push(format!("Name: “{}” → “{label}”", before.label));
        }
        if let Some(site) = change["site"].as_str() {
            out.push(format!(
                "Site: {} → {}",
                or_none(&before.site),
                or_none(site)
            ));
        }
        if let Some(allowed) = change["allowed"].as_array() {
            let after: Vec<&str> = allowed.iter().filter_map(|v| v.as_str()).collect();
            for id in &after {
                if !before.allowed.iter().any(|b| b == id) {
                    out.push(format!("Allow: {}", names.label(id)));
                }
            }
            for id in &before.allowed {
                if !after.contains(&id.as_str()) {
                    out.push(format!("Remove: {}", names.label(id)));
                }
            }
        }
        if let Some(desks) = change["owner_desks"].as_bool() {
            out.push(if desks {
                "Allow: your desks (automatic sign-in)".into()
            } else {
                "Remove: your desks (automatic sign-in)".into()
            });
        }
    }
    if value {
        out.push("Replace the stored value".into());
    }
    out
}

fn or_none(text: &str) -> &str {
    if text.is_empty() {
        "none"
    } else {
        text
    }
}
