//! The credentials page's model: one shape for every store, and the checks an
//! owner's input passes before any store sees it. Value types are not `Debug`
//! and are never serialised back.
use serde::{Deserialize, Serialize};

pub(crate) const OWNER_DESKS: &str = "owner-desks";
const MAX_VALUE: usize = 8 * 1024;
const MAX_LABEL: usize = 200;
const MAX_ALLOWED: usize = 64;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum Kind {
    Password,
    Token,
    ApiKey,
}
impl Kind {
    pub(crate) fn parse(text: &str) -> Option<Kind> {
        match text {
            "password" => Some(Kind::Password),
            "token" => Some(Kind::Token),
            "api_key" => Some(Kind::ApiKey),
            _ => None,
        }
    }
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Kind::Password => "password",
            Kind::Token => "token",
            Kind::ApiKey => "api_key",
        }
    }
    /// The one value this type cannot be stored without.
    pub(crate) fn main_field(self) -> &'static str {
        match self {
            Kind::Password => "password",
            Kind::Token => "token",
            Kind::ApiKey => "api_key",
        }
    }
    /// Value fields this type may carry.
    pub(crate) fn fields(self) -> &'static [&'static str] {
        match self {
            Kind::Password => &["username", "password", "url", "notes"],
            Kind::Token => &["token", "url", "notes"],
            Kind::ApiKey => &["api_key", "url", "notes"],
        }
    }
}

/// What the page shows for each credential. Never a value.
#[derive(Debug, Clone, Serialize)]
pub(crate) struct CredentialView {
    pub(crate) id: String,
    pub(crate) label: String,
    #[serde(rename = "type")]
    pub(crate) kind: Kind,
    pub(crate) site: String,
    /// Chats that may use it: conversation ids (OpenBao) or V1 thread ids
    /// (built-in vault), as `capabilities.grant_ids` says.
    pub(crate) allowed: Vec<String>,
    /// The owner's own desks may sign in with it automatically.
    pub(crate) owner_desks: bool,
    /// Opaque; sent back as `expected_revision` so a stale edit is refused.
    pub(crate) revision: String,
    pub(crate) updated_at_ms: Option<i64>,
    /// Names of the value fields that are set (never their values).
    pub(crate) fields: Vec<String>,
    pub(crate) usage: Usage,
}

#[derive(Debug, Clone, Default, Serialize)]
pub(crate) struct Usage {
    pub(crate) last_used_at_ms: Option<i64>,
    pub(crate) last_used_by: Option<String>,
    pub(crate) chats: Vec<ChatUse>,
    pub(crate) status: Status,
    pub(crate) status_at_ms: Option<i64>,
    /// A fixed outcome code of the last sign-in, e.g. `login_failed`.
    pub(crate) status_detail: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub(crate) struct ChatUse {
    pub(crate) id: String,
    pub(crate) last_at_ms: i64,
    pub(crate) uses: u64,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum Status {
    Ok,
    Failed,
    #[serde(rename = "needs_2fa")]
    NeedsTwoFactor,
    #[default]
    NeverUsed,
}

/// The value fields of one request, named as in the store and in
/// `orkestr-cred` (`VAULT_<FIELD>`). Not `Debug`; dropped right after use.
#[derive(Deserialize, Default)]
#[serde(deny_unknown_fields)]
pub(crate) struct ValueInput {
    #[serde(default)]
    pub(crate) username: Option<String>,
    #[serde(default)]
    pub(crate) password: Option<String>,
    #[serde(default)]
    pub(crate) token: Option<String>,
    #[serde(default)]
    pub(crate) api_key: Option<String>,
    #[serde(default)]
    pub(crate) url: Option<String>,
    #[serde(default)]
    pub(crate) notes: Option<String>,
}
impl ValueInput {
    /// The non-empty fields, checked against the type. `create` requires the
    /// type's main field; a replacement may change any subset.
    pub(crate) fn fields(
        &self,
        kind: Kind,
        create: bool,
    ) -> Result<Vec<(&'static str, &str)>, &'static str> {
        let all = [
            ("username", &self.username),
            ("password", &self.password),
            ("token", &self.token),
            ("api_key", &self.api_key),
            ("url", &self.url),
            ("notes", &self.notes),
        ];
        let mut out = Vec::new();
        for (name, value) in all {
            let Some(value) = value.as_deref().filter(|v| !v.is_empty()) else {
                continue;
            };
            if !kind.fields().contains(&name) {
                return Err("credential_field_not_for_type");
            }
            if value.len() > MAX_VALUE {
                return Err("credential_value_too_long");
            }
            if name != "notes" && value.chars().any(char::is_control) {
                return Err("credential_value_invalid");
            }
            if name == "url" && !https_url(value) {
                return Err("credential_url_invalid");
            }
            out.push((name, value));
        }
        if create && !out.iter().any(|(name, _)| *name == kind.main_field()) {
            return Err("credential_value_required");
        }
        if out.is_empty() {
            return Err("credential_value_required");
        }
        Ok(out)
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct CreateRequest {
    #[serde(rename = "type")]
    pub(crate) kind: String,
    pub(crate) label: String,
    #[serde(default)]
    pub(crate) site: String,
    #[serde(default)]
    pub(crate) allowed: Vec<String>,
    #[serde(default)]
    pub(crate) owner_desks: bool,
    pub(crate) value: ValueInput,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct UpdateRequest {
    pub(crate) expected_revision: String,
    #[serde(default)]
    pub(crate) label: Option<String>,
    #[serde(default)]
    pub(crate) site: Option<String>,
    #[serde(default)]
    pub(crate) allowed: Option<Vec<String>>,
    #[serde(default)]
    pub(crate) owner_desks: Option<bool>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct ValueReplace {
    pub(crate) expected_revision: String,
    /// Only for a store that keeps the site inside the value (built-in vault).
    #[serde(default)]
    pub(crate) site: Option<String>,
    pub(crate) value: ValueInput,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct DeleteQuery {
    pub(crate) expected_revision: String,
}

pub(crate) fn label(text: &str) -> Result<String, &'static str> {
    let text = text.trim();
    if text.is_empty() {
        return Err("credential_label_required");
    }
    if text.chars().count() > MAX_LABEL || text.chars().any(char::is_control) {
        return Err("credential_label_invalid");
    }
    Ok(text.to_owned())
}

/// A site as the owner types it (`example.com`, `https://www.example.com/login`)
/// to the bare lower-case domain the sign-in helpers match on. Empty stays empty.
pub(crate) fn site(text: &str) -> Result<String, &'static str> {
    let text = text.trim();
    if text.is_empty() {
        return Ok(String::new());
    }
    let rest = text
        .split_once("://")
        .map(|(scheme, rest)| {
            if scheme.eq_ignore_ascii_case("https") || scheme.eq_ignore_ascii_case("http") {
                Ok(rest)
            } else {
                Err("credential_site_invalid")
            }
        })
        .unwrap_or(Ok(text))?;
    let host = rest.split(['/', '?', '#']).next().unwrap_or("");
    if host.contains('@') || host.contains(':') {
        return Err("credential_site_invalid");
    }
    let host = host.trim_end_matches('.').to_ascii_lowercase();
    let host = host.strip_prefix("www.").unwrap_or(&host).to_owned();
    domain(&host)
        .then_some(host)
        .ok_or("credential_site_invalid")
}

/// The sign-in helpers' domain rule: two or more labels, letters, digits and
/// inner hyphens, 3 to 253 characters.
pub(crate) fn domain(host: &str) -> bool {
    let labels: Vec<&str> = host.split('.').collect();
    (3..=253).contains(&host.len())
        && labels.len() >= 2
        && labels.iter().all(|l| {
            (1..=63).contains(&l.len())
                && l.bytes()
                    .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
                && !l.starts_with('-')
                && !l.ends_with('-')
        })
}

fn https_url(text: &str) -> bool {
    text.len() > 8
        && text[..8].eq_ignore_ascii_case("https://")
        && !text.chars().any(char::is_whitespace)
}

/// Allowed chats: ids the store understands (`uuid` for conversations, or a
/// V1 thread id), deduplicated, without the owner-desks marker.
pub(crate) fn allowed(ids: &[String], v1_threads: bool) -> Result<Vec<String>, &'static str> {
    if ids.len() > MAX_ALLOWED {
        return Err("credential_allowed_too_many");
    }
    let mut out: Vec<String> = Vec::new();
    for id in ids {
        let id = if v1_threads {
            let id = id.trim().to_owned();
            if !orkestr_v2_contracts::v1_thread_id_valid(&id) {
                return Err("credential_allowed_invalid");
            }
            id
        } else {
            let id = id.trim().to_ascii_lowercase();
            if !uuid::Uuid::parse_str(&id)
                .is_ok_and(|u| !u.is_nil() && u.hyphenated().to_string() == id)
            {
                return Err("credential_allowed_invalid");
            }
            id
        };
        if !out.contains(&id) {
            out.push(id);
        }
    }
    Ok(out)
}

/// The phase-1 slug rule (`orkestr/creds/<slug>`): lower-case ASCII letters,
/// digits and hyphens, at most 63, from the label (Turkish letters folded).
pub(crate) fn slug(label: &str) -> String {
    let folded: String = label
        .chars()
        .map(|c| match c {
            'İ' | 'I' | 'ı' | 'î' | 'Î' => 'i',
            'ğ' | 'Ğ' => 'g',
            'ü' | 'Ü' | 'û' => 'u',
            'ö' | 'Ö' | 'ô' => 'o',
            'ş' | 'Ş' => 's',
            'ç' | 'Ç' => 'c',
            'â' | 'ä' | 'Â' | 'Ä' | 'á' | 'à' => 'a',
            'é' | 'è' | 'ê' | 'ë' => 'e',
            'ß' => 's',
            other => other.to_ascii_lowercase(),
        })
        .collect();
    let mut out = String::new();
    for c in folded.chars() {
        if c.is_ascii_lowercase() || c.is_ascii_digit() {
            out.push(c);
        } else if !out.ends_with('-') && !out.is_empty() {
            out.push('-');
        }
    }
    let out = out.trim_matches('-');
    let out: String = out.chars().take(56).collect();
    let out = out.trim_end_matches('-');
    if out.is_empty() {
        "credential".into()
    } else {
        out.into()
    }
}

pub(crate) fn slug_valid(slug: &str) -> bool {
    (1..=63).contains(&slug.len())
        && slug.as_bytes()[0].is_ascii_alphanumeric()
        && slug
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

/// Owner-facing text for each code. Never derived from the request.
pub(crate) fn message(code: &str) -> &'static str {
    match code {
        "credential_type_invalid" => "Choose password, token or API key",
        "credential_label_required" => "A name is required",
        "credential_label_invalid" => "The name is too long or has control characters",
        "credential_site_invalid" => "The site needs a web address like example.com",
        "credential_site_required" => "A password needs the site it signs in to",
        "credential_value_required" => "Enter the value to store",
        "credential_value_too_long" => "A value can be at most 8 KiB",
        "credential_value_invalid" => "A value cannot contain line breaks or control characters",
        "credential_url_invalid" => "The sign-in address must start with https://",
        "credential_field_not_for_type" => "That field does not belong to this type of credential",
        "credential_allowed_invalid" => "One of the chosen chats is not valid here",
        "credential_allowed_too_many" => "Too many chats for one credential (at most 13 here)",
        "credential_owner_desks_fixed" => "This store decides desk sign-in by itself",
        "credential_site_needs_value" => "This store changes the site only together with the value",
        "credential_changed" => "This credential changed meanwhile; reload and try again",
        "credential_not_found" => "Credential not found",
        "credentials_rate_limited" => "The credential store is busy; try again in a minute",
        "credentials_backend_refused" => "The credential store refused this change",
        "credentials_backend_unavailable" => "The credential store is not reachable",
        "credentials_backend_unconfigured" => "The credential store configuration was refused",
        _ => "Invalid credential request",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sites_become_bare_domains() {
        assert_eq!(site("Example.COM").unwrap(), "example.com");
        assert_eq!(
            site("https://www.example.com/login?x=1").unwrap(),
            "example.com"
        );
        assert_eq!(
            site("http://sub.example.co.uk/").unwrap(),
            "sub.example.co.uk"
        );
        assert_eq!(site("  ").unwrap(), "");
        for bad in [
            "localhost",
            "ftp://example.com",
            "https://u@example.com",
            "example.com:8443",
            "exa mple.com",
            "-a.example.com",
        ] {
            assert!(site(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn slugs_follow_the_phase_one_rule() {
        assert_eq!(slug("Search"), "search");
        assert_eq!(slug("ÇALIŞMA Ağı İçin"), "calisma-agi-icin");
        assert_eq!(slug("  GitHub token (CI)  "), "github-token-ci");
        assert_eq!(slug("!!!"), "credential");
        assert!(slug_valid(&slug(&"x".repeat(200))));
        assert!(!slug_valid("Bad_Slug") && !slug_valid("") && !slug_valid("-a"));
    }

    #[test]
    fn values_must_fit_their_type() {
        let value = ValueInput {
            api_key: Some("synthetic-key".into()),
            ..Default::default()
        };
        assert_eq!(
            value.fields(Kind::ApiKey, true).unwrap(),
            vec![("api_key", "synthetic-key")]
        );
        assert_eq!(
            value.fields(Kind::Password, true).err(),
            Some("credential_field_not_for_type")
        );
        let login = ValueInput {
            username: Some("synthetic".into()),
            ..Default::default()
        };
        assert_eq!(
            login.fields(Kind::Password, true).err(),
            Some("credential_value_required")
        );
        assert!(login.fields(Kind::Password, false).is_ok());
        let url = ValueInput {
            password: Some("p".into()),
            url: Some("http://example.com".into()),
            ..Default::default()
        };
        assert_eq!(
            url.fields(Kind::Password, true).err(),
            Some("credential_url_invalid")
        );
        let line = ValueInput {
            token: Some("a\nb".into()),
            ..Default::default()
        };
        assert_eq!(
            line.fields(Kind::Token, true).err(),
            Some("credential_value_invalid")
        );
        assert_eq!(
            ValueInput::default().fields(Kind::Token, false).err(),
            Some("credential_value_required")
        );
    }

    #[test]
    fn allowed_chats_are_ids_of_the_right_kind() {
        let id = "00000000-0000-4000-8000-00000000000a".to_string();
        assert_eq!(
            allowed(&[id.clone(), id.to_uppercase()], false).unwrap(),
            vec![id.clone()]
        );
        assert_eq!(
            allowed(&["owner-desks".into()], false).err(),
            Some("credential_allowed_invalid")
        );
        assert_eq!(
            allowed(&["thr_synthetic".into()], true).unwrap(),
            vec!["thr_synthetic".to_string()]
        );
        assert_eq!(
            allowed(&["a b".into()], true).err(),
            Some("credential_allowed_invalid")
        );
        assert_eq!(
            allowed(&vec![id; 65], false).err(),
            Some("credential_allowed_too_many")
        );
    }
}
