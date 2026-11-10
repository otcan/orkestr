use super::*;
use crate::held_inputs::tests::fixture::{headers, state, Temporary, AUTHORITY, COOKIE};
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

struct Fixture {
    _root: Temporary,
    state: AppState,
    owner: OwnerId,
    conversation: ConversationId,
}

async fn fixture() -> Fixture {
    let root = Temporary(std::env::temp_dir().join(format!("revision-http-{}", Uuid::new_v4())));
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
    Fixture {
        _root: root,
        state: state(store),
        owner,
        conversation,
    }
}
impl Fixture {
    async fn admit(&self, key: &str, author: InputAuthor) -> MessageId {
        self.state
            .store
            .admit_attributed(
                &self.owner,
                &self.conversation,
                &MessageInput {
                    client_message_id: key.into(),
                    text: "synthetic original".into(),
                },
                None,
                None,
                None,
                Some(author),
            )
            .await
            .unwrap()
            .receipt
            .message_id
    }
    async fn call(&self, message: &MessageId, body: serde_json::Value) -> Response {
        let request = serde_json::from_value(body).map(Json);
        revise(
            State(self.state.clone()),
            authorized(),
            Path((self.conversation.to_string(), message.to_string())),
            request.map_err(|_| JsonRejection::MissingJsonContentType(Default::default())),
        )
        .await
        .unwrap_or_else(IntoResponse::into_response)
    }
}
async fn code(response: Response) -> (StatusCode, serde_json::Value) {
    let status = response.status();
    let bytes = axum::body::to_bytes(response.into_body(), 1 << 16)
        .await
        .unwrap();
    (status, serde_json::from_slice(&bytes).unwrap())
}

#[tokio::test]
async fn the_owner_edits_then_a_retry_gets_the_same_receipt() {
    let f = fixture().await;
    let message = f.admit("first", InputAuthor::Owner).await;
    let body = serde_json::json!({"request_key":"edit-1","kind":"edit","text":"corrected"});
    let (status, first) = code(f.call(&message, body.clone()).await).await;
    assert_eq!(status, StatusCode::CREATED);
    assert_eq!(first["revision"], 1);
    let (status, retry) = code(f.call(&message, body).await).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(retry["duplicate"], true);
    assert_eq!(retry["revision_id"], first["revision_id"]);
}

#[tokio::test]
async fn the_server_refuses_a_message_the_owner_did_not_write() {
    let f = fixture().await;
    let message = f.admit("member", InputAuthor::Member).await;
    let (status, body) = code(
        f.call(
            &message,
            serde_json::json!({"request_key":"edit-1","kind":"delete"}),
        )
        .await,
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(body["code"], "not_owner_message");
}

#[tokio::test]
async fn refusals_have_distinct_codes() {
    let f = fixture().await;
    let message = f.admit("first", InputAuthor::Owner).await;
    let (status, body) = code(
        f.call(
            &message,
            serde_json::json!({"request_key":"same","kind":"edit","text":"synthetic original"}),
        )
        .await,
    )
    .await;
    assert_eq!(
        (status, body["code"].as_str()),
        (StatusCode::CONFLICT, Some("message_revision_unchanged"))
    );
    let (status, _) = code(
        f.call(
            &message,
            serde_json::json!({"request_key":"bad","kind":"edit"}),
        )
        .await,
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    code(
        f.call(
            &message,
            serde_json::json!({"request_key":"gone","kind":"delete"}),
        )
        .await,
    )
    .await;
    let (status, body) = code(
        f.call(
            &message,
            serde_json::json!({"request_key":"late","kind":"edit","text":"x"}),
        )
        .await,
    )
    .await;
    assert_eq!(
        (status, body["code"].as_str()),
        (StatusCode::CONFLICT, Some("message_deleted"))
    );
    let (status, _) = code(
        f.call(
            &MessageId(Uuid::new_v4()),
            serde_json::json!({"request_key":"none","kind":"delete"}),
        )
        .await,
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn a_request_without_a_session_is_refused_and_the_history_needs_one_too() {
    let f = fixture().await;
    let message = f.admit("first", InputAuthor::Owner).await;
    let response = revise(
        State(f.state.clone()),
        headers(None, AUTHORITY),
        Path((f.conversation.to_string(), message.to_string())),
        Ok(Json(MessageRevisionRequest {
            request_key: "edit-1".into(),
            kind: MessageRevisionKind::Delete,
            text: None,
            source: MessageRevisionSource::Web,
            expected_revision: None,
            part: false,
        })),
    )
    .await
    .unwrap_or_else(IntoResponse::into_response);
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    let response = history(
        State(f.state.clone()),
        headers(None, AUTHORITY),
        Path((f.conversation.to_string(), message.to_string())),
    )
    .await
    .unwrap_or_else(IntoResponse::into_response);
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn the_audit_record_lists_the_original_and_every_change() {
    let f = fixture().await;
    let message = f.admit("first", InputAuthor::Owner).await;
    f.call(
        &message,
        serde_json::json!({"request_key":"edit-1","kind":"edit","text":"corrected"}),
    )
    .await;
    f.call(
        &message,
        serde_json::json!({"request_key":"gone","kind":"delete"}),
    )
    .await;
    let response = history(
        State(f.state.clone()),
        authorized(),
        Path((f.conversation.to_string(), message.to_string())),
    )
    .await
    .unwrap_or_else(IntoResponse::into_response);
    let (status, body) = code(response).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["original_text"], "synthetic original");
    assert_eq!(body["revisions"].as_array().unwrap().len(), 2);
    assert_eq!(body["revisions"][1]["kind"], "delete");
}
