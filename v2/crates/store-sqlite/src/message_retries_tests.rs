//! ORK-780: every list shows one message per re-admitted owner input.
use super::*;
use orkestr_v2_application::IntakeStore;
use orkestr_v2_contracts::{InputAuthor, MessageInput, OwnerInputRetirementRequest};
use std::path::PathBuf;
use uuid::Uuid;

const CREDENTIAL: &str = "service:synthetic-adapter";

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
    let root = std::env::temp_dir().join(format!("message-retries-{}", Uuid::new_v4()));
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
    /// One owner input as the delivery adapter admits it, under a fresh key.
    async fn admit(&self, text: &str) -> MessageId {
        self.store
            .admit_authenticated_attributed(
                CREDENTIAL,
                &self.owner,
                &self.conversation,
                &MessageInput {
                    client_message_id: Uuid::new_v4().to_string(),
                    text: text.into(),
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
    async fn retire(&self, message: &MessageId, reason: &str) {
        self.store
            .retire_owner_input_for_browser(
                CREDENTIAL,
                &self.conversation,
                message,
                &OwnerInputRetirementRequest {
                    request_key: format!("adapter-readmit:{message}"),
                    reason: reason.into(),
                },
            )
            .await
            .unwrap();
    }
    /// The adapter's re-admission: retire the attempt, admit it again, link.
    async fn readmit(&self, attempt: &MessageId, text: &str) -> MessageId {
        self.retire(attempt, READMISSION_REASON).await;
        let retry = self.admit(text).await;
        assert!(self
            .store
            .link_message_retry(&self.owner, &self.conversation, &retry, attempt)
            .await
            .unwrap());
        retry
    }
    async fn shown(&self) -> Vec<(MessageId, String, Option<MessageId>)> {
        self.store
            .snapshot(&self.owner, &self.conversation, 0, 100)
            .await
            .unwrap()
            .messages
            .into_iter()
            .map(|m| (m.message_id, m.text, m.retry_of))
            .collect()
    }
}

#[tokio::test]
async fn a_readmitted_input_shows_once_and_names_its_attempt() {
    let f = fixture().await;
    let attempt = f.admit("Synthetic request").await;
    let retry = f.readmit(&attempt, "Synthetic request").await;
    assert_eq!(
        f.shown().await,
        vec![(retry, "Synthetic request".into(), Some(attempt))]
    );
}

#[tokio::test]
async fn every_retry_of_a_retry_still_shows_one_message() {
    let f = fixture().await;
    let first = f.admit("Synthetic request").await;
    let second = f.readmit(&first, "Synthetic request").await;
    let third = f.readmit(&second, "Synthetic request").await;
    let fourth = f.readmit(&third, "Synthetic request").await;
    assert_eq!(
        f.shown().await,
        vec![(fourth, "Synthetic request".into(), Some(third))]
    );
}

#[tokio::test]
async fn an_attempt_retired_before_links_existed_collapses_too() {
    let f = fixture().await;
    let attempt = f.admit("Synthetic request").await;
    f.retire(&attempt, READMISSION_REASON).await;
    let retry = f.admit("Synthetic request").await;
    assert_eq!(
        f.shown().await,
        vec![(retry, "Synthetic request".into(), None)]
    );
}

#[tokio::test]
async fn identical_messages_sent_twice_both_stay_when_one_is_retried() {
    let f = fixture().await;
    let once = f.admit("Synthetic twice").await;
    let twice = f.admit("Synthetic twice").await;
    let retry = f.readmit(&twice, "Synthetic twice").await;
    assert_eq!(
        f.shown().await,
        vec![
            (once, "Synthetic twice".into(), None),
            (retry, "Synthetic twice".into(), Some(twice)),
        ]
    );
}

#[tokio::test]
async fn an_attempt_whose_successor_never_arrived_stays_visible() {
    let f = fixture().await;
    let attempt = f.admit("Synthetic request").await;
    f.retire(&attempt, READMISSION_REASON).await;
    assert_eq!(
        f.shown().await,
        vec![(attempt, "Synthetic request".into(), None)]
    );
}

#[tokio::test]
async fn only_an_attempt_retired_for_readmission_can_be_replaced() {
    let f = fixture().await;
    let kept = f.admit("Synthetic request").await;
    let other = f.admit("Synthetic request").await;
    // Not retired at all: no link, both stay.
    assert!(!f
        .store
        .link_message_retry(&f.owner, &f.conversation, &other, &kept)
        .await
        .unwrap());
    // Retired by an operator, never re-admitted: no link, it stays.
    let closed = f.admit("Synthetic closed").await;
    f.retire(&closed, "operator_retired_never_replay").await;
    let later = f.admit("Synthetic later").await;
    assert!(!f
        .store
        .link_message_retry(&f.owner, &f.conversation, &later, &closed)
        .await
        .unwrap());
    // A later message cannot be named as the earlier attempt.
    let attempt = f.admit("Synthetic attempt").await;
    f.retire(&attempt, READMISSION_REASON).await;
    assert!(!f
        .store
        .link_message_retry(&f.owner, &f.conversation, &later, &attempt)
        .await
        .unwrap());
    let retry = f.admit("Synthetic attempt").await;
    assert!(f
        .store
        .link_message_retry(&f.owner, &f.conversation, &retry, &attempt)
        .await
        .unwrap());
    // Replayed: idempotent, and one attempt is never retried twice.
    assert!(!f
        .store
        .link_message_retry(&f.owner, &f.conversation, &retry, &attempt)
        .await
        .unwrap());
    let shown: Vec<_> = f.shown().await.into_iter().map(|(id, ..)| id).collect();
    assert_eq!(shown, vec![kept, other, closed, later, retry]);
}
