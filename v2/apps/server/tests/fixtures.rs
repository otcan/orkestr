use orkestr_v2_contracts::*;
use serde::{de::DeserializeOwned, Serialize};
fn fixture<T: DeserializeOwned + Serialize>(body: &str) {
    let typed: T = serde_json::from_str(body).expect("published fixture must deserialize");
    let original: serde_json::Value = serde_json::from_str(body).unwrap();
    assert_eq!(
        serde_json::to_value(typed).unwrap(),
        original,
        "fixture must not silently drop fields"
    );
}
#[test]
fn published_contracts_roundtrip() {
    fixture::<MessageInput>(include_str!("../../../fixtures/message-input.json"));
    fixture::<Receipt>(include_str!("../../../fixtures/message-receipt.json"));
    fixture::<ProjectInput>(include_str!("../../../fixtures/project-input.json"));
    fixture::<Project>(include_str!("../../../fixtures/project.json"));
    fixture::<ConversationSnapshot>(include_str!("../../../fixtures/conversation-snapshot.json"));
    fixture::<EventEnvelope>(include_str!("../../../fixtures/event.json"));
    fixture::<ApiError>(include_str!("../../../fixtures/error-conflict.json"));
    fixture::<runtime::ProviderObservation>(include_str!(
        "../../../fixtures/provider-observation-started.json"
    ));
    fixture::<runtime::ProviderObservation>(include_str!(
        "../../../fixtures/provider-observation-completed-proposal.json"
    ));
}
#[test]
fn reject_actor_injection_and_invalid_identifiers() {
    assert!(serde_json::from_str::<MessageInput>(
        r#"{"client_message_id":"one","text":"hello","actor_kind":"owner"}"#
    )
    .is_err());
    assert!(serde_json::from_str::<ConversationId>(r#""provider-native-session-id""#).is_err());
}
