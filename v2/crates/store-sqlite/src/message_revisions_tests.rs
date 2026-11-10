use super::*;
use orkestr_v2_application::IntakeStore;
use std::path::PathBuf;

const CREDENTIAL: &str = "browser:synthetic-cookie";

struct Fixture {
    root: PathBuf,
    store: Store,
    owner: OwnerId,
    conversation: ConversationId,
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}
async fn fixture() -> Fixture {
    let root = std::env::temp_dir().join(format!("message-revisions-{}", Uuid::new_v4()));
    std::fs::create_dir(&root).unwrap();
    let store = crate::test_template::open(&root.join("core.sqlite3")).await;
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
    store.save_session(CREDENTIAL, &owner).await.unwrap();
    Fixture {
        root,
        store,
        owner,
        conversation,
    }
}
impl Fixture {
    async fn admit(&self, key: &str, author: Option<InputAuthor>) -> MessageId {
        self.store
            .admit_attributed(
                &self.owner,
                &self.conversation,
                &MessageInput {
                    client_message_id: key.into(),
                    text: format!("synthetic original of {key}"),
                },
                None,
                None,
                None,
                author,
            )
            .await
            .unwrap()
            .receipt
            .message_id
    }
    /// Typed by the owner in the browser, so an unstarted one can be withdrawn.
    async fn owner_message(&self, key: &str) -> MessageId {
        self.store
            .admit_authenticated_attributed(
                CREDENTIAL,
                &self.owner,
                &self.conversation,
                &MessageInput {
                    client_message_id: key.into(),
                    text: format!("synthetic original of {key}"),
                },
                None,
                None,
                None,
                Some(InputAuthor::Owner),
            )
            .await
            .unwrap()
            .receipt
            .message_id
    }
    async fn revise(
        &self,
        message: &MessageId,
        key: &str,
        text: Option<&str>,
    ) -> std::result::Result<MessageRevisionReceipt, MessageRevisionError> {
        self.store
            .revise_owner_message(
                CREDENTIAL,
                &self.owner,
                &self.conversation,
                message,
                &MessageRevisionRequest {
                    request_key: key.into(),
                    kind: if text.is_some() {
                        MessageRevisionKind::Edit
                    } else {
                        MessageRevisionKind::Delete
                    },
                    text: text.map(str::to_owned),
                    source: MessageRevisionSource::Web,
                    expected_revision: None,
                },
            )
            .await
    }
    async fn inbox_state(&self, message: &MessageId) -> String {
        sqlx::query_scalar("SELECT state FROM reasoning_inbox WHERE message_id=?")
            .bind(message.to_string())
            .fetch_one(&self.store.pool)
            .await
            .unwrap()
    }
    async fn set_inbox_state(&self, message: &MessageId, state: &str) {
        sqlx::query("UPDATE reasoning_inbox SET state=? WHERE message_id=?")
            .bind(state)
            .bind(message.to_string())
            .execute(&self.store.pool)
            .await
            .unwrap();
    }
    async fn text(&self, message: &MessageId) -> String {
        sqlx::query_scalar("SELECT text FROM messages WHERE id=?")
            .bind(message.to_string())
            .fetch_one(&self.store.pool)
            .await
            .unwrap()
    }
    async fn snapshot_row(&self, message: &MessageId) -> Message {
        self.store
            .snapshot(&self.owner, &self.conversation, 0, 100)
            .await
            .unwrap()
            .messages
            .into_iter()
            .find(|row| &row.message_id == message)
            .unwrap()
    }
}

#[tokio::test]
async fn an_edit_before_the_agent_started_replaces_the_input_and_keeps_the_original() {
    let f = fixture().await;
    let message = f.owner_message("first").await;
    let receipt = f
        .revise(&message, "edit-1", Some("corrected"))
        .await
        .unwrap();
    assert_eq!(receipt.revision, 1);
    assert!(receipt.agent_notified);
    assert!(!receipt.agent_saw_earlier_text);
    // The agent only ever receives the corrected text.
    assert_eq!(f.inbox_state(&message).await, "retired");
    assert_eq!(f.inbox_state(&receipt.notice_message_id).await, "queued");
    assert_eq!(f.text(&receipt.notice_message_id).await, "corrected");
    // History is never rewritten: the original text is still there.
    assert_eq!(f.text(&message).await, "synthetic original of first");
    let row = f.snapshot_row(&message).await;
    assert_eq!(row.text, "synthetic original of first");
    let state = row.revisions.unwrap();
    assert!(state.can_revise);
    let latest = state.latest.unwrap();
    assert_eq!(latest.kind, MessageRevisionKind::Edit);
    assert_eq!(latest.text.as_deref(), Some("corrected"));
    let notice = f.snapshot_row(&receipt.notice_message_id).await;
    assert_eq!(notice.origin.as_deref(), Some("revision"));
    let marker = notice.revisions.unwrap();
    assert!(!marker.can_revise);
    let announced = marker.notice_for.unwrap();
    assert_eq!(announced.target_message_id, message);
    assert_eq!(announced.change.text.as_deref(), Some("corrected"));
    assert_eq!(announced.change.revision, 1);
}

#[tokio::test]
async fn every_live_notice_has_a_queued_window_and_a_withdrawn_removal_has_none() {
    let f = fixture().await;
    let windows = |event: String| {
        let pool = f.store.pool.clone();
        async move {
            sqlx::query_scalar::<_, i64>(
                "SELECT count(*) FROM execution_window_queue WHERE event_id=? AND state='queued'",
            )
            .bind(event)
            .fetch_one(&pool)
            .await
            .unwrap()
        }
    };
    let edited = f.owner_message("edited").await;
    let edit = f
        .revise(&edited, "edit-1", Some("corrected"))
        .await
        .unwrap();
    assert_eq!(windows(edit.notice_event_id.to_string()).await, 1);
    let removed = f.owner_message("removed").await;
    let delete = f.revise(&removed, "delete-1", None).await.unwrap();
    assert!(!delete.agent_notified);
    assert_eq!(windows(delete.notice_event_id.to_string()).await, 0);
}

#[tokio::test]
async fn a_restricted_thread_refuses_revisions() {
    let f = fixture().await;
    let message = f.owner_message("first").await;
    sqlx::query("INSERT INTO restricted_threads(conversation_id,owner_id,enabled,revision,policy_json,session_id,updated_at_ms) VALUES(?,?,1,1,'{}','synthetic-session',1)")
        .bind(f.conversation.to_string())
        .bind(f.owner.to_string())
        .execute(&f.store.pool)
        .await
        .unwrap();
    assert_eq!(
        f.revise(&message, "edit-1", Some("corrected")).await,
        Err(MessageRevisionError::Restricted)
    );
}

#[tokio::test]
async fn a_connectors_unstarted_input_is_never_withdrawn() {
    let f = fixture().await;
    // The adapter admitted this one and still drives its window and reply.
    let message = f.admit("whatsapp", Some(InputAuthor::Owner)).await;
    let receipt = f
        .revise(&message, "edit-1", Some("corrected"))
        .await
        .unwrap();
    assert_eq!(f.inbox_state(&message).await, "queued");
    assert!(receipt.agent_saw_earlier_text);
    assert_eq!(f.inbox_state(&receipt.notice_message_id).await, "queued");
    let notice = f.text(&receipt.notice_message_id).await;
    assert!(notice.starts_with("[Message corrected]"), "{notice}");
}

#[tokio::test]
async fn an_edit_during_a_running_turn_leaves_it_alone_and_queues_a_notice() {
    let f = fixture().await;
    let message = f.owner_message("running").await;
    f.set_inbox_state(&message, "claimed").await;
    let receipt = f
        .revise(&message, "edit-1", Some("corrected"))
        .await
        .unwrap();
    assert!(receipt.agent_notified);
    assert!(receipt.agent_saw_earlier_text);
    assert_eq!(f.inbox_state(&message).await, "claimed");
    assert_eq!(f.inbox_state(&receipt.notice_message_id).await, "queued");
    let notice = f.text(&receipt.notice_message_id).await;
    assert!(notice.starts_with("[Message corrected]"), "{notice}");
    assert!(notice.ends_with("Corrected text:\ncorrected"), "{notice}");
    assert!(notice.contains("synthetic original of running"), "{notice}");
}

#[tokio::test]
async fn an_edit_after_the_agent_acted_tells_it_to_recheck() {
    let f = fixture().await;
    let message = f.owner_message("consumed").await;
    f.set_inbox_state(&message, "consumed").await;
    let receipt = f
        .revise(&message, "edit-1", Some("corrected"))
        .await
        .unwrap();
    assert_eq!(f.inbox_state(&message).await, "consumed");
    let notice = f.text(&receipt.notice_message_id).await;
    assert!(notice.contains("already acted"), "{notice}");
}

#[tokio::test]
async fn removing_an_unstarted_message_costs_no_turn() {
    let f = fixture().await;
    let message = f.owner_message("gone").await;
    let receipt = f.revise(&message, "delete-1", None).await.unwrap();
    assert!(!receipt.agent_notified);
    assert_eq!(f.inbox_state(&message).await, "retired");
    assert_eq!(f.inbox_state(&receipt.notice_message_id).await, "retired");
    assert_eq!(f.text(&message).await, "synthetic original of gone");
    let state = f.snapshot_row(&message).await.revisions.unwrap();
    assert!(!state.can_revise);
    assert_eq!(state.latest.unwrap().kind, MessageRevisionKind::Delete);
}

#[tokio::test]
async fn removing_a_message_the_agent_saw_sends_a_notice_without_repeating_it() {
    let f = fixture().await;
    let message = f.owner_message("seen").await;
    f.set_inbox_state(&message, "consumed").await;
    let receipt = f.revise(&message, "delete-1", None).await.unwrap();
    assert!(receipt.agent_notified);
    assert_eq!(f.inbox_state(&receipt.notice_message_id).await, "queued");
    let notice = f.text(&receipt.notice_message_id).await;
    assert!(notice.starts_with("[Message removed]"), "{notice}");
    assert!(!notice.contains("synthetic original"), "{notice}");
}

#[tokio::test]
async fn a_second_correction_follows_the_first_in_order() {
    let f = fixture().await;
    let message = f.owner_message("twice").await;
    let first = f.revise(&message, "edit-1", Some("second")).await.unwrap();
    let second = f.revise(&message, "edit-2", Some("third")).await.unwrap();
    assert_eq!(second.revision, 2);
    // The first correction already holds its place in the queue, so it stays
    // and the next one says plainly that it replaces it.
    assert!(second.agent_saw_earlier_text);
    assert_eq!(f.inbox_state(&first.notice_message_id).await, "queued");
    assert_eq!(f.inbox_state(&second.notice_message_id).await, "queued");
    let notice = f.text(&second.notice_message_id).await;
    assert!(
        notice.contains("Earlier version began: \"second\""),
        "{notice}"
    );
    assert!(notice.ends_with("Corrected text:\nthird"), "{notice}");
    let history = f
        .store
        .message_revision_history(&f.owner, &f.conversation, &message)
        .await
        .unwrap();
    assert_eq!(history.original_text, "synthetic original of twice");
    assert_eq!(
        history
            .revisions
            .iter()
            .map(|entry| entry.text.as_deref().unwrap())
            .collect::<Vec<_>>(),
        ["second", "third"]
    );
}

#[tokio::test]
async fn a_chain_the_agent_has_read_keeps_warning_it() {
    let f = fixture().await;
    let message = f.owner_message("chain").await;
    f.set_inbox_state(&message, "consumed").await;
    let first = f.revise(&message, "edit-1", Some("second")).await.unwrap();
    let second = f.revise(&message, "edit-2", Some("third")).await.unwrap();
    assert!(second.agent_saw_earlier_text);
    assert_eq!(f.inbox_state(&first.notice_message_id).await, "queued");
    let notice = f.text(&second.notice_message_id).await;
    assert!(notice.starts_with("[Message corrected]"), "{notice}");
    assert!(
        notice.contains("Earlier version began: \"second\""),
        "{notice}"
    );
}

#[tokio::test]
async fn a_correction_of_a_quoted_input_keeps_its_quote() {
    let f = fixture().await;
    let quote = ReplyTo {
        message_id: Some("true_chat_ABC".into()),
        author: Some("orkestr".into()),
        sent_at: None,
        text: "synthetic question".into(),
        is_own_reply: true,
        unavailable: false,
    };
    let message = f
        .store
        .admit_authenticated_attributed(
            CREDENTIAL,
            &f.owner,
            &f.conversation,
            &MessageInput {
                client_message_id: "quoted".into(),
                text: "[Replying to Orkestr message: \"synthetic question\"]\n\ntypo".into(),
            },
            Some(&quote),
            None,
            None,
            Some(InputAuthor::Owner),
        )
        .await
        .unwrap()
        .receipt
        .message_id;
    let receipt = f.revise(&message, "edit-1", Some("fixed")).await.unwrap();
    assert_eq!(
        f.text(&receipt.notice_message_id).await,
        "[Replying to Orkestr message: \"synthetic question\"]\n\nfixed"
    );
    let notice = f.snapshot_row(&receipt.notice_message_id).await;
    assert_eq!(notice.reply_to, Some(quote));
}

#[tokio::test]
async fn only_the_owners_own_messages_can_be_revised() {
    let f = fixture().await;
    for (key, author) in [
        ("member", Some(InputAuthor::Member)),
        ("agent", Some(InputAuthor::V1Agent)),
        ("external", Some(InputAuthor::V1External)),
        ("timer:claim", Some(InputAuthor::Owner)),
        ("timer-window:event", None),
        ("steering:one", None),
        ("thread-ask:one", None),
        ("thread-ask-reply:one", None),
        // Unattributed and not from the owner's own browser: unprovable.
        ("unattributed", None),
    ] {
        let message = f.admit(key, author).await;
        assert_eq!(
            f.revise(&message, &format!("edit-{key}"), Some("no")).await,
            Err(MessageRevisionError::NotOwnMessage),
            "{key}"
        );
        assert_eq!(
            f.revise(&message, &format!("delete-{key}"), None).await,
            Err(MessageRevisionError::NotOwnMessage),
            "{key}"
        );
        let row = f.snapshot_row(&message).await;
        assert!(
            !row.revisions.is_some_and(|state| state.can_revise),
            "{key}"
        );
        assert_eq!(f.inbox_state(&message).await, "queued", "{key}");
    }
}

#[tokio::test]
async fn a_notice_is_not_itself_editable() {
    let f = fixture().await;
    let message = f.owner_message("first").await;
    let receipt = f
        .revise(&message, "edit-1", Some("corrected"))
        .await
        .unwrap();
    assert_eq!(
        f.revise(&receipt.notice_message_id, "edit-2", Some("x"))
            .await,
        Err(MessageRevisionError::NotOwnMessage)
    );
}

#[tokio::test]
async fn a_message_in_another_conversation_is_not_found() {
    let f = fixture().await;
    let message = f.owner_message("first").await;
    let result = f
        .store
        .revise_owner_message(
            CREDENTIAL,
            &f.owner,
            &ConversationId(Uuid::new_v4()),
            &message,
            &MessageRevisionRequest {
                request_key: "edit-1".into(),
                kind: MessageRevisionKind::Delete,
                text: None,
                source: MessageRevisionSource::Web,
                expected_revision: None,
            },
        )
        .await;
    assert_eq!(result, Err(MessageRevisionError::NotFound));
}

#[tokio::test]
async fn a_retry_is_idempotent_and_a_reused_key_is_refused() {
    let f = fixture().await;
    let message = f.owner_message("first").await;
    let receipt = f
        .revise(&message, "edit-1", Some("corrected"))
        .await
        .unwrap();
    let retry = f
        .revise(&message, "edit-1", Some("corrected"))
        .await
        .unwrap();
    assert!(retry.duplicate);
    assert_eq!(retry.revision_id, receipt.revision_id);
    assert_eq!(retry.notice_message_id, receipt.notice_message_id);
    assert_eq!(
        f.revise(&message, "edit-1", Some("different")).await,
        Err(MessageRevisionError::Conflict)
    );
    let other = f.owner_message("second").await;
    assert_eq!(
        f.revise(&other, "edit-1", Some("corrected")).await,
        Err(MessageRevisionError::Conflict)
    );
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM message_revisions")
        .fetch_one(&f.store.pool)
        .await
        .unwrap();
    assert_eq!(count, 1);
}

#[tokio::test]
async fn deleted_stale_and_unchanged_revisions_are_refused() {
    let f = fixture().await;
    let message = f.owner_message("first").await;
    assert_eq!(
        f.revise(&message, "same", Some(" synthetic original of first "))
            .await,
        Err(MessageRevisionError::Unchanged)
    );
    f.revise(&message, "edit-1", Some("corrected"))
        .await
        .unwrap();
    let stale = f
        .store
        .revise_owner_message(
            CREDENTIAL,
            &f.owner,
            &f.conversation,
            &message,
            &MessageRevisionRequest {
                request_key: "edit-2".into(),
                kind: MessageRevisionKind::Edit,
                text: Some("late".into()),
                source: MessageRevisionSource::Web,
                expected_revision: Some(0),
            },
        )
        .await;
    assert_eq!(stale, Err(MessageRevisionError::Stale));
    f.revise(&message, "delete-1", None).await.unwrap();
    assert_eq!(
        f.revise(&message, "edit-3", Some("after")).await,
        Err(MessageRevisionError::AlreadyDeleted)
    );
    assert_eq!(
        f.revise(&message, "delete-2", None).await,
        Err(MessageRevisionError::AlreadyDeleted)
    );
}

#[tokio::test]
async fn a_message_from_the_owners_browser_session_counts_without_an_author() {
    let f = fixture().await;
    let message = f
        .store
        .admit_authenticated_attributed(
            CREDENTIAL,
            &f.owner,
            &f.conversation,
            &MessageInput {
                client_message_id: Uuid::new_v4().to_string(),
                text: "typed in the web composer".into(),
            },
            None,
            None,
            None,
            None,
        )
        .await
        .unwrap()
        .receipt
        .message_id;
    assert!(f.revise(&message, "edit-1", Some("fixed")).await.is_ok());
}

#[tokio::test]
async fn the_audit_record_cannot_be_changed_or_removed() {
    let f = fixture().await;
    let message = f.owner_message("first").await;
    f.revise(&message, "edit-1", Some("corrected"))
        .await
        .unwrap();
    for sql in [
        "UPDATE message_revisions SET text='rewritten'",
        "DELETE FROM message_revisions",
    ] {
        assert!(
            sqlx::query(sql).execute(&f.store.pool).await.is_err(),
            "{sql}"
        );
    }
}

#[tokio::test]
async fn a_revision_is_all_or_nothing() {
    let f = fixture().await;
    let message = f.owner_message("first").await;
    f.revise(&message, "edit-1", Some("corrected"))
        .await
        .unwrap();
    let before: (i64, i64) = sqlx::query_as(
        "SELECT (SELECT count(*) FROM messages),(SELECT count(*) FROM owner_input_retirements)",
    )
    .fetch_one(&f.store.pool)
    .await
    .unwrap();
    assert_eq!(
        f.revise(&message, "edit-1", Some("different")).await,
        Err(MessageRevisionError::Conflict)
    );
    let after: (i64, i64) = sqlx::query_as(
        "SELECT (SELECT count(*) FROM messages),(SELECT count(*) FROM owner_input_retirements)",
    )
    .fetch_one(&f.store.pool)
    .await
    .unwrap();
    assert_eq!(before, after);
}

#[test]
fn excerpts_skip_the_relay_marker_lines() {
    assert_eq!(
        excerpt("[Chat rules v2]\n\n[WhatsApp: group]\n\nreal   text", 50),
        "real text"
    );
    assert_eq!(excerpt("abcdef", 3), "abc\u{2026}");
}
