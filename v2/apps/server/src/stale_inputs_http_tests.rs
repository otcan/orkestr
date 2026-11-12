//! ORK-798: the stale-input settlement route keeps the owner browser guards,
//! refuses a service session, and refuses (409, no write) an ordinary queued
//! input. The settled shapes themselves are covered in the store tests.
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
        Temporary(std::env::temp_dir().join(format!("settle-stale-http-{}", Uuid::new_v4())));
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
                client_message_id: "ordinary-queued".into(),
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
    settle_stale(
        State(state.clone()),
        h,
        Path((conversation.to_string(), message.to_string())),
        Ok(Json(StaleInputSettlementRequest {
            request_key: "ork798-settle-one".into(),
        })),
    )
    .await
    .unwrap_or_else(IntoResponse::into_response)
}
fn sql(root: &Temporary, statement: &str) {
    let out = std::process::Command::new("python3")
        .args([
            "-I",
            "-S",
            "-B",
            "-c",
            "import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); c.execute(sys.argv[2]); c.commit()",
        ])
        .arg(root.0.join("core.sqlite3"))
        .arg(statement)
        .env("PYTHONDONTWRITEBYTECODE", "1")
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
}
#[tokio::test]
async fn settle_stale_http_keeps_owner_guards_and_refuses_ordinary_input_without_writes() {
    let (root, state, conversation, message) = fixture().await;
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
    for (c, m) in [
        (ConversationId(Uuid::new_v4()), message.clone()),
        (conversation.clone(), MessageId(Uuid::new_v4())),
    ] {
        assert_eq!(
            call(&state, &c, &m, authorized()).await.status(),
            StatusCode::NOT_FOUND
        );
    }
    // An ordinary queued owner message is not a stale automatic result.
    for _ in 0..2 {
        assert_eq!(
            call(&state, &conversation, &message, authorized())
                .await
                .status(),
            StatusCode::CONFLICT
        );
    }
    // Nothing was written: the ordinary retire route still takes the input.
    let retired = retire(
        State(state.clone()),
        authorized(),
        Path((conversation.to_string(), message.to_string())),
        Ok(Json(OwnerInputRetirementRequest {
            request_key: "owner-retire-after-refusal".into(),
            reason: "Synthetic obsolete input".into(),
        })),
    )
    .await
    .unwrap_or_else(IntoResponse::into_response);
    assert_eq!(retired.status(), StatusCode::CREATED);
    // An adapter service session never settles, even for the same owner.
    sql(&root, "UPDATE auth_sessions SET kind='service_browser'");
    assert_eq!(
        call(&state, &conversation, &message, authorized())
            .await
            .status(),
        StatusCode::UNAUTHORIZED
    );
    state.store.close().await;
}
