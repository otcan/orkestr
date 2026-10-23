use super::*;
use crate::held_inputs::tests::fixture::{headers, state, Temporary, AUTHORITY, COOKIE};
use orkestr_v2_application::IntakeStore;
use sha2::{Digest, Sha256};

fn authorized() -> HeaderMap {
    let mut h = headers(Some(COOKIE), AUTHORITY);
    h.insert("origin", format!("http://{AUTHORITY}").parse().unwrap());
    let csrf = format!(
        "{:x}",
        Sha256::digest(format!("orkestr-v2-browser-csrf-v1:{COOKIE}").as_bytes())
    );
    h.insert("x-orkestr-csrf", csrf.parse().unwrap());
    h
}
async fn fixture() -> (Temporary, AppState, ConversationId, MessageId) {
    let root =
        Temporary(std::env::temp_dir().join(format!("retire-input-http-{}", Uuid::new_v4())));
    std::fs::create_dir(&root.0).unwrap();
    let store = Store::open(&root.0.join("core.sqlite3")).await.unwrap();
    let conversation = store
        .setup("synthetic-owner", "synthetic-hash")
        .await
        .unwrap();
    let owner = store
        .credentials("synthetic-owner")
        .await
        .unwrap()
        .unwrap()
        .0;
    store
        .save_session(&format!("browser:{COOKIE}"), &owner)
        .await
        .unwrap();
    let message = store
        .admit(
            &owner,
            &conversation,
            &MessageInput {
                client_message_id: "exact-source".into(),
                text: "synthetic queued input".into(),
            },
        )
        .await
        .unwrap()
        .receipt
        .message_id;
    (root, state(store), conversation, message)
}
async fn call(
    state: &AppState,
    conversation: &ConversationId,
    message: &MessageId,
    h: HeaderMap,
) -> Response {
    retire(
        State(state.clone()),
        h,
        Path((conversation.to_string(), message.to_string())),
        Ok(Json(OwnerInputRetirementRequest {
            request_key: "owner-retire-one".into(),
            reason: "Obsolete duplicate; never replay".into(),
        })),
    )
    .await
    .unwrap_or_else(IntoResponse::into_response)
}

#[tokio::test]
async fn retired_input_http_retains_auth_origin_csrf_and_exact_scope_guards() {
    let (_root, state, conversation, message) = fixture().await;
    let mut variants = vec![(headers(None, AUTHORITY), StatusCode::UNAUTHORIZED)];
    for (header, value) in [
        ("host", "foreign.invalid"),
        ("origin", "http://foreign.invalid"),
        ("x-orkestr-csrf", "wrong"),
    ] {
        let mut h = authorized();
        h.insert(header, value.parse().unwrap());
        variants.push((h, StatusCode::FORBIDDEN));
    }
    let mut machine = authorized();
    machine.insert("authorization", "Bearer synthetic-machine".parse().unwrap());
    variants.push((machine, StatusCode::UNAUTHORIZED));
    for (h, expected) in variants {
        assert_eq!(
            call(&state, &conversation, &message, h).await.status(),
            expected
        );
    }
    assert_eq!(
        call(
            &state,
            &ConversationId(Uuid::new_v4()),
            &message,
            authorized()
        )
        .await
        .status(),
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        call(
            &state,
            &conversation,
            &MessageId(Uuid::new_v4()),
            authorized()
        )
        .await
        .status(),
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        call(&state, &conversation, &message, authorized())
            .await
            .status(),
        StatusCode::CREATED
    );
    assert_eq!(
        call(&state, &conversation, &message, authorized())
            .await
            .status(),
        StatusCode::OK
    );
    state.store.close().await;
}
