//! ORK-804: a Deep turn typed in the web app of a WhatsApp-bound conversation
//! reads the chat's rules like a WhatsApp-typed one.
use super::*;

const LINE: &str = "[Chat rules v0123456789ab: before answering, read /synthetic/rules/chat.md (cat it) unless you already read this version in this session, and follow it.]";

/// Deep input text after `earlier` and `current` are stored as the window's
/// older (not admitted) and admitted inputs of one conversation.
async fn deep_text_for(label: &str, earlier: &str, current: &str) -> String {
    let w = Window::open().await;
    for (id, text) in [
        (w.old.input_message_id.to_string(), earlier),
        (w.source.input_message_id.to_string(), current),
    ] {
        sqlx::query("UPDATE messages SET text=? WHERE id=?")
            .bind(text)
            .bind(id)
            .execute(&w.f.store.pool)
            .await
            .unwrap();
    }
    w.activate().await;
    let claim = w
        .bound
        .claim_next(
            &w.f.owner,
            &w.f.conversation,
            &w.roles.deep.session_id,
            Duration::from_secs(30),
        )
        .await
        .unwrap()
        .unwrap();
    let admission = w
        .bound
        .admit_run(
            &claim,
            &w.roles.deep.session_id,
            w.roles.deep.generation,
            &format!("web-rules-{label}"),
        )
        .await
        .unwrap();
    let text = w.consume(&admission).await.text().to_owned();
    assert!(
        text.ends_with(current.split("\n\n").last().unwrap()),
        "{text}"
    );
    text
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_web_typed_deep_turn_gets_the_chat_rules_line_of_the_last_whatsapp_intake() {
    let earlier = format!("{LINE}\n\n[WhatsApp: synthetic]\n\nearlier question");
    let text = deep_text_for("bound", &earlier, "update docs/plan.md in my folder").await;
    assert!(
        text.starts_with(&format!("{LINE}\n\nupdate docs/plan.md")),
        "the line first, where the adapter puts it: {text}"
    );
    assert_eq!(text.matches("[Chat rules v").count(), 1);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn only_an_adapter_line_counts_and_a_turn_with_its_own_line_is_unchanged() {
    // Owner text that merely looks like the line (no adapter source header).
    let typed = format!("{LINE}\n\nnot from the adapter");
    let text = deep_text_for("typed", &typed, "hello").await;
    assert!(!text.contains("[Chat rules v"), "{text}");
    // A web-only conversation: nothing to carry.
    let text = deep_text_for("web-only", "an earlier web message", "hello").await;
    assert!(!text.contains("[Chat rules v"), "{text}");
    // A WhatsApp-typed turn keeps exactly its own line.
    let earlier = format!("{LINE}\n\n[WhatsApp: synthetic]\n\nearlier");
    let current = format!("{LINE}\n\n[WhatsApp: synthetic]\n\nnow");
    let text = deep_text_for("own-line", &earlier, &current).await;
    assert!(text.starts_with(LINE));
    assert_eq!(text.matches("[Chat rules v").count(), 1);
}
