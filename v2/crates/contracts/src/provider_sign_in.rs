//! Owner sign-in projection for Claude and Codex.
//!
//! Carries only fixed state words, the provider's own sign-in link and its
//! one-time device code. Never a token or raw provider output.
use serde::{Deserialize, Serialize};

const CODEX_LINK: (&str, &[u8], usize) = ("https://auth.openai.com/", b"/._-", 200);
const CLAUDE_LINK: (&str, &[u8], usize) =
    ("https://claude.com/cai/oauth/authorize?", b"%&=_.+~-", 2000);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SignInProvider {
    Codex,
    Claude,
}
impl SignInProvider {
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "codex" => Some(Self::Codex),
            "claude" => Some(Self::Claude),
            _ => None,
        }
    }
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Codex => "codex",
            Self::Claude => "claude",
        }
    }
    pub fn label(self) -> &'static str {
        match self {
            Self::Codex => "Codex",
            Self::Claude => "Claude",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SignInState {
    Starting,
    Waiting,
    Verifying,
    Succeeded,
    Failed,
    Cancelled,
    Expired,
}
impl SignInState {
    pub fn active(self) -> bool {
        matches!(self, Self::Starting | Self::Waiting | Self::Verifying)
    }
}

/// Why a sign-in stopped. Closed: provider output never becomes a reason.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SignInFailure {
    UpstreamRateLimited,
    LoginFailed,
    CredentialInvalid,
    CommitFailed,
    Superseded,
    Timeout,
    Internal,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SignInUnavailable {
    /// This provider is not part of the install's runtime configuration.
    NotConfigured,
    /// The install has no separated provider identity to sign in as.
    Unsupported,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SignInAttempt {
    pub state: SignInState,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub link: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expires_in_s: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<SignInFailure>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProviderSignIn {
    pub provider: SignInProvider,
    pub available: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<SignInUnavailable>,
    /// `None` until the server has checked this provider.
    #[serde(default)]
    pub signed_in: Option<bool>,
    #[serde(default)]
    pub method: Option<String>,
    #[serde(default)]
    pub account: Option<String>,
    #[serde(default)]
    pub subscription: Option<String>,
    #[serde(default)]
    pub checked_at_ms: Option<i64>,
    #[serde(default)]
    pub login: Option<SignInAttempt>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SignInResult {
    Status,
    Started,
    Accepted,
    InProgress,
    RateLimited,
    Unavailable,
    Refused,
    Noop,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SignInOverview {
    pub result: SignInResult,
    pub providers: Vec<ProviderSignIn>,
}
impl SignInOverview {
    /// The closed response for an install with no provider sign-in support.
    pub fn unavailable() -> Self {
        let provider = |provider| ProviderSignIn {
            provider,
            available: false,
            reason: Some(SignInUnavailable::Unsupported),
            signed_in: None,
            method: None,
            account: None,
            subscription: None,
            checked_at_ms: None,
            login: None,
        };
        Self {
            result: SignInResult::Unavailable,
            providers: vec![
                provider(SignInProvider::Codex),
                provider(SignInProvider::Claude),
            ],
        }
    }
    /// Every free-form field is re-checked before leaving the server.
    pub fn valid(&self) -> bool {
        self.providers.iter().all(ProviderSignIn::valid)
    }
}
impl ProviderSignIn {
    pub fn valid(&self) -> bool {
        [&self.method, &self.account, &self.subscription]
            .iter()
            .all(|value| value.as_deref().is_none_or(label_allowed))
            && self.login.as_ref().is_none_or(|attempt| {
                attempt
                    .link
                    .as_deref()
                    .is_none_or(|link| sign_in_link_allowed(self.provider, link))
                    && attempt.code.as_deref().is_none_or(device_code_allowed)
                    && (attempt.link.is_none() || attempt.state.active())
            })
    }
}

/// True only for the provider's own https sign-in page.
pub fn sign_in_link_allowed(provider: SignInProvider, link: &str) -> bool {
    let (prefix, extra, limit) = match provider {
        SignInProvider::Codex => CODEX_LINK,
        SignInProvider::Claude => CLAUDE_LINK,
    };
    link.strip_prefix(prefix).is_some_and(|rest| {
        !rest.is_empty()
            && rest.len() <= limit
            && rest
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || extra.contains(&b))
    })
}

fn device_code_allowed(code: &str) -> bool {
    let groups: Vec<&str> = code.split('-').collect();
    groups.len() == 2
        && groups.iter().all(|group| {
            (4..=8).contains(&group.len())
                && group
                    .bytes()
                    .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit())
        })
}

fn label_allowed(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 254
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._+@ -".contains(&b))
}

/// A pasted browser code, before it is forwarded to the waiting CLI.
pub fn pasted_code_allowed(code: &str) -> bool {
    (8..=1024).contains(&code.len())
        && code
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"#_.~-".contains(&b))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_providers_own_https_sign_in_pages_are_links() {
        use SignInProvider::{Claude, Codex};
        assert!(sign_in_link_allowed(
            Codex,
            "https://auth.openai.com/codex/device"
        ));
        assert!(sign_in_link_allowed(
            Claude,
            "https://claude.com/cai/oauth/authorize?code=true&state=abc%2B"
        ));
        for (provider, link) in [
            (Codex, "http://auth.openai.com/codex/device"),
            (Codex, "https://auth.openai.com.evil.example/codex/device"),
            (Codex, "https://auth.openai.com@evil.example/"),
            (Codex, "https://auth.openai.com/codex/device?next=evil"),
            (Codex, "https://auth.openai.com/\"><script>"),
            (Codex, "https://auth.openai.com/"),
            (Claude, "https://claude.com/other?x=1"),
            (Claude, "https://claude.com/cai/oauth/authorize?"),
            (Claude, "javascript:alert(1)"),
        ] {
            assert!(!sign_in_link_allowed(provider, link), "{link}");
        }
    }

    #[test]
    fn overview_validation_rejects_unexpected_free_form_values() {
        let good: SignInOverview = serde_json::from_value(serde_json::json!({
            "result":"status",
            "providers":[{"provider":"codex","available":true,"signed_in":true,"method":"chatgpt",
                "login":{"state":"waiting","link":"https://auth.openai.com/codex/device","code":"ABCD-EFGH1"}}]
        }))
        .unwrap();
        assert!(good.valid());
        let mut bad = good.clone();
        bad.providers[0].login.as_mut().unwrap().link = Some("https://evil.example/".into());
        assert!(!bad.valid());
        let mut bad = good.clone();
        bad.providers[0].account = Some("x".repeat(255));
        assert!(!bad.valid());
        let mut bad = good.clone();
        bad.providers[0].login.as_mut().unwrap().code = Some("<b>".into());
        assert!(!bad.valid());
        let mut bad = good;
        let attempt = bad.providers[0].login.as_mut().unwrap();
        attempt.state = SignInState::Succeeded;
        assert!(!bad.valid(), "a terminal sign-in keeps no link");
    }

    #[test]
    fn unknown_fields_and_states_are_refused() {
        assert!(serde_json::from_value::<ProviderSignIn>(
            serde_json::json!({"provider":"codex","available":true,"token":"x"})
        )
        .is_err());
        assert!(
            serde_json::from_value::<SignInAttempt>(serde_json::json!({"state":"exfiltrate"}))
                .is_err()
        );
    }

    #[test]
    fn pasted_codes_have_a_closed_shape() {
        assert!(pasted_code_allowed("synthetic-browser-code"));
        for code in ["short", "has space code", "new\nline", ""] {
            assert!(!pasted_code_allowed(code), "{code}");
        }
    }
}
