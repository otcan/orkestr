//! Provider-reported model evidence for an exact run, never a model selector.
use serde::{Deserialize, Serialize};

pub fn valid_observed_model(model: &str) -> bool {
    !model.is_empty()
        && model.len() <= 120
        && model
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"-_.:/".contains(&b))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ExecutionModelSource {
    /// The model the native reported when initializing this invocation.
    Resolved,
    /// The model reported on actual assistant output in this invocation.
    Answer,
    /// The model identified on an explicit provider policy refusal.
    Refused,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ExecutionModelObservation {
    pub source: ExecutionModelSource,
    pub model: String,
}

impl ExecutionModelObservation {
    pub fn is_valid(&self) -> bool {
        valid_observed_model(&self.model)
    }
    pub fn source_name(&self) -> &'static str {
        match self.source {
            ExecutionModelSource::Resolved => "resolved",
            ExecutionModelSource::Answer => "answer",
            ExecutionModelSource::Refused => "refused",
        }
    }
}

/// Absence is unreported evidence, never the owner's configured model inferred
/// as an actual answer. Different values expose a native model change.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ExecutionModels {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider: Option<crate::ConversationProvider>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resolved_model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub actual_model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub refused_model: Option<String>,
}

impl ExecutionModels {
    pub fn is_valid(&self) -> bool {
        (self.provider.is_some()
            || self.resolved_model.is_some()
            || self.actual_model.is_some()
            || self.refused_model.is_some())
            && [
                &self.resolved_model,
                &self.actual_model,
                &self.refused_model,
            ]
            .into_iter()
            .all(|v| v.as_deref().is_none_or(valid_observed_model))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn observed_models_are_bounded_identifiers_and_unknown_is_not_inferred() {
        assert!(valid_observed_model("provider/selected-model-v2"));
        for value in ["", "model\nprivate", "account@example.com", "<synthetic>"] {
            assert!(!valid_observed_model(value));
        }
        assert!(!valid_observed_model(&"x".repeat(121)));
        assert!(!ExecutionModels::default().is_valid());
        assert!(ExecutionModels {
            provider: None,
            resolved_model: None,
            actual_model: Some("answer-model".into()),
            refused_model: None,
        }
        .is_valid());
    }
}
