//! Operator-configured provider exclusions. No domain vocabulary is built in.
use orkestr_v2_contracts::{ConversationId, ConversationProvider};
use serde::Deserialize;

#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct ProviderRouting {
    pub rules: Vec<Rule>,
}

#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Rule {
    pub id: String,
    #[serde(default)]
    pub conversations: Vec<ConversationId>,
    #[serde(default)]
    pub terms: Vec<Term>,
    pub threshold: u32,
    pub excluded: ConversationProvider,
    pub preferred: ConversationProvider,
}

#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Term {
    pub text: String,
    pub weight: u32,
}

impl ProviderRouting {
    pub(crate) fn validate(&self) -> Result<(), &'static str> {
        if self.rules.is_empty() || self.rules.len() > 32 {
            return Err("invalid provider routing policy");
        }
        let mut ids = std::collections::HashSet::new();
        for rule in &self.rules {
            if rule.id.is_empty()
                || rule.id.len() > 64
                || !rule
                    .id
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"-_.".contains(&b))
                || !ids.insert(&rule.id)
                || rule.excluded == rule.preferred
                || rule.conversations.len() > 128
                || rule
                    .conversations
                    .iter()
                    .any(|conversation| conversation.0.is_nil())
                || rule.terms.len() > 256
                || (rule.conversations.is_empty() && rule.terms.is_empty())
                || rule.threshold == 0
                || rule.threshold > 1024
                || rule.terms.iter().any(|term| {
                    term.text.trim().is_empty()
                        || term.text.len() > 128
                        || term.text.chars().any(char::is_control)
                        || term.weight == 0
                        || term.weight > 1024
                })
            {
                return Err("invalid provider routing rule");
            }
        }
        Ok(())
    }

    /// Evaluate all matching exclusions together: conflicting preferences fail
    /// closed rather than making the result depend on rule order.
    pub(crate) fn route(
        &self,
        conversation: &ConversationId,
        text: &str,
        selected: ConversationProvider,
    ) -> Result<ConversationProvider, &'static str> {
        self.validate()?;
        let lower = text.to_lowercase();
        let active: Vec<_> = self
            .rules
            .iter()
            .filter(|rule| {
                rule.conversations.contains(conversation)
                    || rule
                        .terms
                        .iter()
                        .filter(|term| word_match(&lower, &term.text.to_lowercase()))
                        .fold(0u32, |score, term| score.saturating_add(term.weight))
                        >= rule.threshold
            })
            .collect();
        if !active.iter().any(|rule| rule.excluded == selected) {
            return Ok(selected);
        }
        let mut preferred = None;
        for rule in &active {
            if rule.excluded == selected {
                if preferred.is_some_and(|value| value != rule.preferred) {
                    return Err("provider routing policies conflict");
                }
                preferred = Some(rule.preferred);
            }
        }
        let target = preferred.ok_or("provider routing target unavailable")?;
        if active.iter().any(|rule| rule.excluded == target) {
            return Err("provider routing policies exclude every target");
        }
        Ok(target)
    }
}

fn word_match(text: &str, term: &str) -> bool {
    text.match_indices(term).any(|(start, _)| {
        let end = start + term.len();
        !text[..start]
            .chars()
            .next_back()
            .is_some_and(char::is_alphanumeric)
            && !text[end..]
                .chars()
                .next()
                .is_some_and(char::is_alphanumeric)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    fn policy() -> ProviderRouting {
        serde_json::from_value(serde_json::json!({"rules":[{
            "id":"synthetic-category", "terms":[{"text":"cedar", "weight":2},
            {"text":"amber", "weight":1}], "threshold":3,
            "excluded":"claude", "preferred":"codex"
        }]}))
        .unwrap()
    }
    #[test]
    fn weighted_terms_route_only_at_threshold_and_at_word_boundaries() {
        let p = policy();
        let c = ConversationId(uuid::Uuid::new_v4());
        for text in ["cedar", "amber", "cedarwood amber", "neutral"] {
            assert_eq!(
                p.route(&c, text, ConversationProvider::Claude).unwrap(),
                ConversationProvider::Claude
            );
        }
        assert_eq!(
            p.route(&c, "CEDAR + amber", ConversationProvider::Claude)
                .unwrap(),
            ConversationProvider::Codex
        );
        assert_eq!(
            p.route(&c, "cedar amber", ConversationProvider::Codex)
                .unwrap(),
            ConversationProvider::Codex
        );
    }
    #[test]
    fn explicit_conversation_scope_protects_short_continuations() {
        let mut p = policy();
        let c = ConversationId(uuid::Uuid::new_v4());
        p.rules[0].conversations.push(c.clone());
        assert_eq!(
            p.route(&c, "continue", ConversationProvider::Claude)
                .unwrap(),
            ConversationProvider::Codex
        );
    }
    #[test]
    fn conflicting_rules_cannot_route_back_to_an_excluded_provider() {
        let mut p = policy();
        let c = ConversationId(uuid::Uuid::new_v4());
        let mut other = p.rules[0].clone();
        other.id = "other".into();
        other.excluded = ConversationProvider::Codex;
        other.preferred = ConversationProvider::Claude;
        p.rules.push(other);
        assert!(p
            .route(&c, "cedar amber", ConversationProvider::Claude)
            .is_err());
    }
    #[test]
    fn malformed_or_duplicate_rules_are_rejected() {
        let mut p = policy();
        p.rules.push(p.rules[0].clone());
        assert!(p.validate().is_err());
        let mut p = policy();
        p.rules[0].terms[0].text.clear();
        assert!(p.validate().is_err());
    }
}
