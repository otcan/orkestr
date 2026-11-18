//! The Codex model a Deep or Worker turn requests when its chat has none
//! selected (Fast has its own: `fast_settings::FAST_DEFAULT_MODEL`). Without
//! it a turn sends no model and the native answers with the first model of
//! the catalog it downloaded, which the provider may reorder at any time.
use orkestr_v2_contracts::{ConversationProvider, TurnLaunch};
use std::sync::RwLock;

/// Built-in default; the operator's `codex_default_model` replaces it.
pub const CODEX_DEFAULT_MODEL: &str = "gpt-6.1-sol";

static CONFIGURED: RwLock<Option<String>> = RwLock::new(None);

/// A Codex launch model: valid on the wire, allowed by server policy and
/// never a Claude model.
pub fn codex_default_valid(model: &str) -> bool {
    orkestr_v2_contracts::launch_model_valid(model)
        && !model.to_ascii_lowercase().starts_with("claude")
}

/// Trusted startup only (operator configuration), before any dispatch. An
/// invalid model is refused and leaves the current default unchanged.
pub fn configure_codex_default_model(model: &str) -> Result<(), &'static str> {
    if !codex_default_valid(model) {
        return Err("invalid Codex default model");
    }
    if let Ok(mut configured) = CONFIGURED.write() {
        *configured = Some(model.to_owned());
    }
    Ok(())
}

/// The operator's default, else the built-in one.
pub fn codex_default_model() -> String {
    CONFIGURED
        .read()
        .ok()
        .and_then(|configured| configured.clone())
        .unwrap_or_else(|| CODEX_DEFAULT_MODEL.to_owned())
}

/// A Codex launch without an owner model names `default`. An owner's choice
/// and a Claude launch are unchanged, as are the settings revision and the
/// provider generation, so the selection itself is not altered.
pub fn with_codex_default(mut launch: TurnLaunch, default: &str) -> TurnLaunch {
    if launch.provider == ConversationProvider::Codex && launch.model.is_none() {
        launch.model = Some(default.to_owned());
    }
    launch
}

#[cfg(test)]
mod tests {
    use super::*;
    use orkestr_v2_contracts::{ConversationId, ConversationSettings};

    fn launch() -> TurnLaunch {
        ConversationSettings::defaults(ConversationId(
            "00000000-0000-4000-8000-000000000001".parse().unwrap(),
        ))
        .launch()
    }

    #[test]
    fn an_unset_codex_model_names_the_default_and_keeps_the_rest() {
        let mut unset = launch();
        unset.reasoning_effort = Some("xhigh".into());
        unset.settings_revision = 4;
        let launched = with_codex_default(unset.clone(), "gpt-6.1-sol");
        assert_eq!(
            launched.codex_overrides(),
            Some((Some("gpt-6.1-sol"), Some("xhigh")))
        );
        assert_eq!(
            (launched.settings_revision, launched.provider_generation),
            (unset.settings_revision, unset.provider_generation)
        );
    }

    #[test]
    fn an_owner_model_and_a_claude_launch_are_unchanged() {
        let mut chosen = launch();
        chosen.model = Some("gpt-6-sol".into());
        assert_eq!(with_codex_default(chosen.clone(), "gpt-6.1-sol"), chosen);
        let mut claude = launch();
        claude.provider = ConversationProvider::Claude;
        assert_eq!(with_codex_default(claude.clone(), "gpt-6.1-sol"), claude);
    }

    #[test]
    fn only_valid_codex_models_can_be_configured() {
        assert!(codex_default_valid(CODEX_DEFAULT_MODEL));
        for invalid in [
            "",
            "claude-opus-5-5",
            "Claude-sonnet",
            "fable",
            "gpt-fable-1",
            "bad model",
            "openai",
            "12345",
        ] {
            assert!(!codex_default_valid(invalid), "{invalid}");
            assert!(configure_codex_default_model(invalid).is_err(), "{invalid}");
        }
        // Configuring the built-in value keeps every other test's default.
        configure_codex_default_model(CODEX_DEFAULT_MODEL).unwrap();
        assert_eq!(codex_default_model(), CODEX_DEFAULT_MODEL);
    }
}
