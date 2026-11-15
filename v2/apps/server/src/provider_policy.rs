//! One trusted policy evaluation for windows, turns, steering and descendants.
//! Vocabulary is supplied by the sealed operator overlay, never compiled here.
use crate::beta_config::provider_routing::ProviderRouting;
use orkestr_v2_contracts::{ConversationId, ConversationProvider, OwnerId};
use orkestr_v2_store_sqlite::Store;

pub(crate) async fn select(
    store: &Store,
    policy: &ProviderRouting,
    owner: &OwnerId,
    conversation: &ConversationId,
    text: &str,
    selected: ConversationProvider,
) -> Result<(ConversationProvider, Vec<String>), &'static str> {
    let inherited = store
        .conversation_provider_policy_rules(owner, conversation)
        .await
        .map_err(|_| "provider policy scope unavailable")?;
    let rules = policy.matching_rules(conversation, text, &inherited)?;
    Ok((
        if inherited.is_empty() {
            policy.route(conversation, text, selected)?
        } else {
            policy.route_inherited(conversation, text, selected, &inherited)?
        },
        rules,
    ))
}

pub(crate) fn proof(
    policy: &ProviderRouting,
    message: orkestr_v2_contracts::MessageId,
    rules: Vec<String>,
) -> Result<orkestr_v2_store_sqlite::OperatorProviderPolicy, &'static str> {
    use sha2::{Digest, Sha256};
    let bytes = serde_json::to_vec(policy).map_err(|_| "provider policy identity unavailable")?;
    Ok(orkestr_v2_store_sqlite::OperatorProviderPolicy {
        source_message_id: message,
        policy_sha256: format!("{:x}", Sha256::digest(bytes)),
        source_commit: source_commit(),
        rule_ids: rules,
    })
}

/// The embedded build source; an unpinned build reports `unknown`.
fn source_commit() -> String {
    // Unit tests are unpinned builds. One test task may model a qualified
    // build; nothing outside `cfg(test)` can set it.
    #[cfg(test)]
    if let Ok(source) = TEST_SOURCE_COMMIT.try_with(|source| (*source).to_owned()) {
        return source;
    }
    crate::build_identity::identity()["source_commit"]
        .as_str()
        .unwrap_or("unknown")
        .to_owned()
}

#[cfg(test)]
tokio::task_local! {
    /// Test only: the qualified source commit of a synthetic build, scoped to
    /// one test task.
    pub(crate) static TEST_SOURCE_COMMIT: &'static str;
}
