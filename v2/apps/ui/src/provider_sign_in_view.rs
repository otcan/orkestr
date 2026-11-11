//! Install-wide Claude and Codex sign-in, shown in Settings for the owner.
//!
//! Only a state word, the provider's own sign-in link and a one-time code ever
//! arrive here. A link is rendered only after this check of its exact host.
use dioxus::prelude::*;
use orkestr_v2_contracts::{
    sign_in_link_allowed, ProviderSignIn, SignInAttempt, SignInFailure, SignInOverview,
    SignInProvider, SignInState, SignInUnavailable,
};
use orkestr_v2_ui::session_scope::SessionScope;
use serde_json::{json, Value};

const STEP_MS: u32 = 250;
const ACTIVE_MS: u32 = 2_000;
const IDLE_MS: u32 = 30_000;

fn interval(overview: Option<&SignInOverview>) -> u32 {
    let pending = overview.is_none_or(|value| {
        value.providers.iter().any(|provider| {
            provider.available
                && (provider.signed_in.is_none()
                    || provider
                        .login
                        .as_ref()
                        .is_some_and(|attempt| attempt.state.active()))
        })
    });
    if pending {
        ACTIVE_MS
    } else {
        IDLE_MS
    }
}

fn path(provider: SignInProvider, action: &str) -> String {
    format!("/api/v2/provider-sign-in/{}/{action}", provider.as_str())
}

fn status_line(provider: &ProviderSignIn) -> String {
    if !provider.available {
        return match provider.reason {
            Some(SignInUnavailable::NotConfigured) => "Not enabled on this server.".into(),
            _ => "Sign-in here is not available on this server.".into(),
        };
    }
    match provider.signed_in {
        None => "Checking…".into(),
        Some(false) => "Not signed in.".into(),
        Some(true) => {
            let account = provider.account.as_deref().unwrap_or_default();
            let method = provider.method.as_deref().unwrap_or_default();
            let plan = provider
                .subscription
                .as_deref()
                .map(|plan| format!(" ({plan})"))
                .unwrap_or_default();
            if !account.is_empty() {
                format!("Signed in as {account}{plan}.")
            } else if method == "chatgpt" {
                format!("Signed in with ChatGPT{plan}.")
            } else if !method.is_empty() {
                format!("Signed in with {method}{plan}.")
            } else {
                format!("Signed in{plan}.")
            }
        }
    }
}

fn sign_out_warning(provider: SignInProvider) -> String {
    let label = provider.label();
    match provider {
        // V1's Codex reads the same credential file, and the release
        // preflight refuses a signed-out credential.
        SignInProvider::Codex => "Sign out of Codex for this whole server? This also signs out V1's Codex (same credential file). Chats that use Codex stop working, and the next release cannot deploy (provider_credentials_not_ready), until someone signs in again.".into(),
        SignInProvider::Claude => format!("Sign out of {label} for this whole server? Chats that use {label} stop working until someone signs in again."),
    }
}

fn outcome_line(attempt: &SignInAttempt) -> Option<String> {
    match attempt.state {
        SignInState::Succeeded => Some("Sign-in finished.".into()),
        SignInState::Cancelled => Some("Sign-in cancelled. Nothing changed.".into()),
        SignInState::Expired => {
            Some("Sign-in timed out. Nothing changed. Start again when ready.".into())
        }
        SignInState::Failed => Some(
            match attempt.reason {
                Some(SignInFailure::UpstreamRateLimited) => {
                    "The provider is rate limiting sign-ins. Try again later. Nothing changed."
                }
                Some(SignInFailure::CredentialInvalid | SignInFailure::CommitFailed) => {
                    "Sign-in could not be saved. Nothing changed. Try again."
                }
                _ => "Sign-in failed. Nothing changed. Try again.",
            }
            .into(),
        ),
        _ => None,
    }
}

#[derive(Props, Clone, PartialEq)]
struct RowProps {
    provider: ProviderSignIn,
    csrf: String,
    busy: Signal<bool>,
    note: Signal<String>,
    overview: Signal<Option<SignInOverview>>,
    poll_now: Signal<bool>,
    session_scope: Signal<SessionScope>,
    onexpired: EventHandler<()>,
}

#[component]
pub fn ProviderSignInSection(
    csrf: String,
    session_scope: Signal<SessionScope>,
    onexpired: EventHandler<()>,
) -> Element {
    let mut overview = use_signal(|| None::<SignInOverview>);
    let mut note = use_signal(String::new);
    let busy = use_signal(|| false);
    let mut poll_now = use_signal(|| false);
    let mut mounted = use_signal(|| true);
    use_drop(move || mounted.set(false));
    use_future(move || async move {
        let generation = session_scope.read().generation();
        loop {
            let result = crate::transport::request::<SignInOverview>(
                "GET",
                "/api/v2/provider-sign-in",
                Value::Null,
                "",
                "",
            )
            .await;
            if !mounted() || !session_scope.read().is_current(generation) {
                return;
            }
            match result {
                Ok(value) => {
                    overview.set(Some(value));
                }
                Err(error) if matches!(error.status, 401 | 403) => {
                    onexpired.call(());
                    return;
                }
                Err(error) => note.set(error.message),
            }
            let wait = interval(overview.peek().as_ref());
            let mut waited = 0;
            while waited < wait {
                crate::transport::sleep(STEP_MS).await;
                if !mounted() || !session_scope.read().is_current(generation) {
                    return;
                }
                waited += STEP_MS;
                if poll_now() {
                    poll_now.set(false);
                    break;
                }
            }
        }
    });
    let rows = overview
        .read()
        .as_ref()
        .map(|value| value.providers.clone())
        .unwrap_or_default();
    rsx! {
        section { class: "provider-sign-in", "aria-label": "Provider sign-in",
            h2 { "Provider sign-in" }
            p { "One sign-in per provider for this whole server. Every chat that uses the provider uses this account. V1's Codex uses the same Codex sign-in." }
            if rows.is_empty() { p { role: "status", "Checking provider sign-in…" } }
            for provider in rows {
                ProviderRow {
                    key: "{provider.provider.as_str()}",
                    provider: provider.clone(), csrf: csrf.clone(), busy, note, overview, poll_now, session_scope, onexpired,
                }
            }
            if !note.read().is_empty() { p { class: "provider-sign-in-note", role: "alert", "{note}" } }
        }
    }
}

#[component]
fn ProviderRow(props: RowProps) -> Element {
    let RowProps {
        provider,
        csrf,
        mut busy,
        mut note,
        mut overview,
        mut poll_now,
        session_scope,
        onexpired,
    } = props;
    let mut confirming_sign_out = use_signal(|| false);
    let mut pasted = use_signal(String::new);
    let name = provider.provider;
    let label = name.label();
    let attempt = provider.login.clone();
    let active = attempt.as_ref().is_some_and(|value| value.state.active());
    let status = status_line(&provider);
    let outcome = attempt.as_ref().and_then(outcome_line);
    let submit = {
        let csrf = csrf.clone();
        move |action: &'static str, body: Value| {
            if busy() {
                return;
            }
            busy.set(true);
            note.set(String::new());
            let generation = session_scope.read().generation();
            let csrf = csrf.clone();
            spawn(async move {
                let result = crate::transport::request::<SignInOverview>(
                    "POST",
                    &path(name, action),
                    body,
                    &csrf,
                    "",
                )
                .await;
                if !session_scope.read().is_current(generation) {
                    return;
                }
                busy.set(false);
                match result {
                    Ok(value) => {
                        overview.set(Some(value));
                        poll_now.set(true);
                    }
                    Err(error) if error.status == 401 => onexpired.call(()),
                    Err(error) => note.set(error.message),
                }
            });
        }
    };
    let link = attempt
        .as_ref()
        .and_then(|value| value.link.as_deref())
        .filter(|link| sign_in_link_allowed(name, link))
        .map(str::to_owned);
    let code = attempt.as_ref().and_then(|value| value.code.clone());
    let waiting_for_paste = name == SignInProvider::Claude
        && attempt
            .as_ref()
            .is_some_and(|value| value.state == SignInState::Waiting && value.link.is_some());
    let verifying = attempt
        .as_ref()
        .is_some_and(|value| value.state == SignInState::Verifying);
    rsx! {
        div { class: "provider-sign-in-row", "aria-label": "{label} sign-in",
            h3 { "{label}" }
            p { class: "provider-sign-in-status", role: "status", "{status}" }
            if let Some(line) = outcome.as_ref() { p { role: "status", "{line}" } }
            if active {
                if let Some(link) = link.as_ref() {
                    p { a { href: "{link}", target: "_blank", rel: "noopener noreferrer", "Open the {label} sign-in page" } }
                } else if attempt.as_ref().is_some_and(|value| value.link.is_some()) {
                    p { role: "alert", "The sign-in link could not be verified, so it is not shown. Cancel and try again." }
                } else {
                    p { role: "status", "Starting sign-in…" }
                }
                if let Some(code) = code.as_ref() {
                    p { "Enter this one-time code on that page: " code { class: "provider-sign-in-code", "{code}" } }
                }
                if waiting_for_paste {
                    p { "After signing in, paste the code from that page here." }
                    form { onsubmit: {
                        let mut submit = submit.clone();
                        move |event: FormEvent| {
                            event.prevent_default();
                            let code = pasted().trim().to_owned();
                            if !code.is_empty() {
                                pasted.set(String::new());
                                submit("code", json!({"code": code}));
                            }
                        }
                    },
                        input { "aria-label": "Code from the sign-in page", autocomplete: "off", value: "{pasted}",
                            oninput: move |event| pasted.set(event.value()) }
                        button { r#type: "submit", disabled: busy(), "Submit code" }
                    }
                }
                if verifying { p { role: "status", "Finishing sign-in…" } }
                div { class: "provider-sign-in-actions",
                    button { r#type: "button", disabled: busy(), onclick: {
                        let mut submit = submit.clone();
                        move |_| submit("cancel", json!({}))
                    }, "Cancel" }
                }
            } else if provider.available {
                if confirming_sign_out() {
                    p { role: "alert", "{sign_out_warning(name)}" }
                    div { class: "provider-sign-in-actions",
                        button { r#type: "button", disabled: busy(), onclick: {
                            let mut submit = submit.clone();
                            move |_| {
                                confirming_sign_out.set(false);
                                submit("sign-out", json!({"confirm": true}));
                            }
                        }, "Confirm sign out" }
                        button { r#type: "button", onclick: move |_| confirming_sign_out.set(false), "Keep signed in" }
                    }
                } else {
                    div { class: "provider-sign-in-actions",
                        button { r#type: "button", disabled: busy(), onclick: {
                            let mut submit = submit.clone();
                            move |_| submit("start", json!({}))
                        }, if provider.signed_in == Some(true) { "Re-authenticate" } else { "Sign in" } }
                        if provider.signed_in == Some(true) {
                            button { r#type: "button", disabled: busy(), onclick: move |_| confirming_sign_out.set(true), "Sign out" }
                        }
                    }
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use orkestr_v2_contracts::SignInResult;

    fn provider(
        signed_in: Option<bool>,
        method: Option<&str>,
        account: Option<&str>,
    ) -> ProviderSignIn {
        ProviderSignIn {
            provider: SignInProvider::Codex,
            available: true,
            reason: None,
            signed_in,
            method: method.map(str::to_owned),
            account: account.map(str::to_owned),
            subscription: None,
            checked_at_ms: None,
            login: None,
        }
    }

    #[test]
    fn status_names_the_account_only_when_it_is_known() {
        assert_eq!(status_line(&provider(None, None, None)), "Checking…");
        assert_eq!(
            status_line(&provider(Some(false), None, None)),
            "Not signed in."
        );
        assert_eq!(
            status_line(&provider(Some(true), Some("chatgpt"), None)),
            "Signed in with ChatGPT."
        );
        assert_eq!(
            status_line(&provider(
                Some(true),
                Some("claude.ai"),
                Some("owner@example.test")
            )),
            "Signed in as owner@example.test."
        );
    }

    #[test]
    fn polling_is_fast_only_while_something_is_pending() {
        let mut value = SignInOverview {
            result: SignInResult::Status,
            providers: vec![provider(Some(true), None, None)],
        };
        assert_eq!(interval(Some(&value)), IDLE_MS);
        value.providers[0].login = Some(SignInAttempt {
            state: SignInState::Waiting,
            link: None,
            code: None,
            expires_in_s: None,
            reason: None,
        });
        assert_eq!(interval(Some(&value)), ACTIVE_MS);
        assert_eq!(interval(None), ACTIVE_MS);
    }

    #[test]
    fn codex_sign_out_names_v1_and_the_release_block() {
        let codex = sign_out_warning(SignInProvider::Codex);
        assert!(codex.contains("V1's Codex") && codex.contains("provider_credentials_not_ready"));
        let claude = sign_out_warning(SignInProvider::Claude);
        assert!(!claude.contains("V1") && claude.starts_with("Sign out of Claude"));
    }

    #[test]
    fn outcomes_never_echo_provider_text() {
        let attempt = |reason| SignInAttempt {
            state: SignInState::Failed,
            link: None,
            code: None,
            expires_in_s: None,
            reason,
        };
        assert!(
            outcome_line(&attempt(Some(SignInFailure::UpstreamRateLimited)))
                .unwrap()
                .contains("rate limiting")
        );
        assert!(outcome_line(&attempt(None))
            .unwrap()
            .contains("Nothing changed"));
    }
}
