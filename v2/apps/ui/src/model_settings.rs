//! Which model each role of a native chat answers with, shown in the chat
//! heading and in chat settings, and the owner's Fast model change.
//! Presentation and request building only: the server validates and
//! revision-guards every update, and a change applies from that role's next
//! turn, never to a running one.
use orkestr_v2_contracts::{
    valid_observed_model, ConversationProvider, ConversationSettings, FastRoleSettings,
    FastRoleSettingsUpdate,
};
use serde_json::Value;

/// Codex Fast model and effort when the owner chose none (Core sends these on
/// every Codex Fast turn; `FAST_ROLE_SETTINGS.md`).
pub const CODEX_FAST_DEFAULT: (&str, &str) = ("gpt-6-luna", "low");
/// Claude Fast always answers with Sonnet at low effort.
pub const CLAUDE_FAST_DEFAULT: (&str, &str) = ("sonnet", "low");
/// Suggested Codex Fast models; any other valid name may be typed.
pub const FAST_SUGGESTIONS: [&str; 3] = ["gpt-6-luna", "gpt-6-sol", "gpt-6.1-sol"];

/// Suggested Deep models for a provider; any other valid name may be typed.
pub fn deep_suggestions(provider: ConversationProvider) -> &'static [&'static str] {
    match provider {
        ConversationProvider::Codex => &[
            "gpt-6.1-sol",
            "gpt-6-sol",
            "gpt-6-astra",
            "gpt-6.1-terra",
            "gpt-6-luna",
        ],
        ConversationProvider::Claude => &["opus", "sonnet"],
    }
}

/// The model a role's latest run reported: the answering model, else the
/// one the native initialized with. A refusal is not an answer.
pub fn observed_model(status: &Value) -> Option<String> {
    let models = status.get("models")?;
    ["actual_model", "resolved_model"]
        .into_iter()
        .find_map(|field| models.get(field).and_then(Value::as_str))
        .filter(|model| valid_observed_model(model))
        .map(str::to_owned)
}

/// Whether a reported model is the selected one. A one-word alias names
/// its family (`opus` answers as `claude-opus-5-5`).
pub fn same_model(selected: &str, reported: &str) -> bool {
    selected == reported
        || (!selected.contains(['-', '.', ':', '/'])
            && reported
                .split(['-', '.', ':', '/'])
                .any(|part| part == selected))
}

/// One role's selection as the owner sees it.
#[derive(Clone, Debug, PartialEq)]
pub struct RoleModel {
    pub role: &'static str,
    pub provider: ConversationProvider,
    /// The owner's choice; `None` means the default applies.
    pub model: Option<String>,
    /// What an unset model means, when Orkestr fixes it (Fast). `None`: the
    /// installation's provider decides (Deep).
    pub default_model: Option<&'static str>,
    pub effort: Option<String>,
    pub default_effort: Option<&'static str>,
    /// The model the role's latest run reported, if any.
    pub last: Option<String>,
}

impl RoleModel {
    pub fn deep(settings: &ConversationSettings, last: Option<String>) -> Self {
        Self {
            role: "Deep",
            provider: settings.provider,
            model: settings.model.clone(),
            default_model: None,
            effort: settings.reasoning_effort.clone(),
            default_effort: None,
            last,
        }
    }

    /// Fast follows the chat's provider. Codex Fast has its own model and
    /// effort (`fast` is `None` when they could not be read); Claude Fast
    /// always uses its fixed defaults.
    pub fn fast(
        deep: &ConversationSettings,
        fast: Option<&FastRoleSettings>,
        last: Option<String>,
    ) -> Self {
        let ((model, effort), defaults) = match deep.provider {
            ConversationProvider::Codex => (
                fast.map_or((None, None), |f| {
                    (f.model.clone(), f.reasoning_effort.clone())
                }),
                CODEX_FAST_DEFAULT,
            ),
            ConversationProvider::Claude => ((None, None), CLAUDE_FAST_DEFAULT),
        };
        Self {
            role: "Fast",
            provider: deep.provider,
            model,
            default_model: Some(defaults.0),
            effort,
            default_effort: Some(defaults.1),
            last,
        }
    }

    /// The model the next turn requests: the owner's choice, else the known
    /// default. `None` when the installation decides.
    pub fn next_model(&self) -> Option<&str> {
        self.model.as_deref().or(self.default_model)
    }

    pub fn model_text(&self) -> String {
        match (&self.model, self.default_model, &self.last) {
            (Some(model), _, _) => model.clone(),
            (None, Some(default), _) => format!("{default} (default)"),
            (None, None, Some(last)) => format!("{last} (default)"),
            (None, None, None) => "installation default".into(),
        }
    }

    pub fn effort_text(&self) -> String {
        match (&self.effort, self.default_effort) {
            (Some(effort), _) => effort.clone(),
            (None, Some(default)) => format!("{default} (default)"),
            (None, None) => "default".into(),
        }
    }

    pub fn last_text(&self) -> String {
        self.last
            .clone()
            .unwrap_or_else(|| "not reported yet".into())
    }

    /// The short heading form: the model, and the effort when it was chosen.
    pub fn short(&self) -> String {
        let model = self
            .next_model()
            .or(self.last.as_deref())
            .unwrap_or("default");
        match &self.effort {
            Some(effort) => format!("{model} · {effort}"),
            None => model.to_owned(),
        }
    }

    /// Set when the latest run answered with another model than the next
    /// turn will request (a changed selection, or a native fallback).
    pub fn drift(&self) -> Option<String> {
        let (next, last) = (self.next_model()?, self.last.as_deref()?);
        (!same_model(next, last)).then(|| {
            format!(
                "{}: the last reply used {last}; the next turn asks for {next}.",
                self.role
            )
        })
    }
}

/// Heading text, for example `Deep gpt-6.1-sol · high | Fast gpt-6-luna`.
pub fn heading_label(deep: &RoleModel, fast: Option<&RoleModel>) -> String {
    match fast {
        Some(fast) => format!("Deep {} | Fast {}", deep.short(), fast.short()),
        None => format!("Deep {}", deep.short()),
    }
}

/// Heading tooltip: provider, model and effort of each role in words.
pub fn heading_title(deep: &RoleModel, fast: Option<&RoleModel>) -> String {
    let describe = |role: &RoleModel| {
        format!(
            "{}: {}, model {}, effort {}.",
            role.role,
            role.provider.as_str(),
            role.model_text(),
            role.effort_text()
        )
    };
    let mut text = describe(deep);
    if let Some(fast) = fast {
        text.push(' ');
        text.push_str(&describe(fast));
    }
    text.push_str(" Open chat settings to change.");
    text
}

/// The Codex Fast model form: a full replacement of model and effort at the
/// revision it was read at.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct FastForm {
    pub revision: i64,
    pub model: String,
    pub effort: String,
}

fn optional(value: &str) -> Option<String> {
    let trimmed = value.trim();
    (!trimmed.is_empty()).then(|| trimmed.to_owned())
}

impl FastForm {
    pub fn from_settings(value: &FastRoleSettings) -> Self {
        Self {
            revision: value.revision,
            model: value.model.clone().unwrap_or_default(),
            effort: value.reasoning_effort.clone().unwrap_or_default(),
        }
    }

    /// Empty fields fall back to the Fast defaults. The parallel-replies
    /// switch is left out, so a model change never turns it back on.
    pub fn update(&self) -> Result<FastRoleSettingsUpdate, &'static str> {
        let update = FastRoleSettingsUpdate {
            expected_revision: self.revision,
            model: optional(&self.model),
            reasoning_effort: optional(&self.effort),
            parallel_replies: None,
        };
        if update.is_valid() {
            Ok(update)
        } else {
            Err("Check the Fast model name and effort.")
        }
    }
}
