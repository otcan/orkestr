//! Default server admission policy, also applied to resolved native launch models.
pub const DEFAULT_DENIED_MODELS: [&str; 1] = ["fable"];

pub fn model_denied(value: &str) -> bool {
    value
        .split(|c: char| !c.is_ascii_alphanumeric())
        .any(|part| {
            DEFAULT_DENIED_MODELS
                .iter()
                .any(|denied| part.eq_ignore_ascii_case(denied))
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn default_policy_blocks_fable_and_provider_qualified_aliases() {
        for model in [
            "fable",
            "FABLE",
            "claude-fable-v2",
            "provider:fable",
            "fable.latest",
        ] {
            assert!(model_denied(model));
        }
        for model in ["opus", "sonnet", "gpt-6.1-sol", "synthetic-model"] {
            assert!(!model_denied(model));
        }
    }
}
