//! The newest page equals the tail of a full forward scan, and older pages
//! continue it without gaps, so a chat can open without reading its history.
use super::*;
use orkestr_v2_application::IntakeStore;
use std::path::PathBuf;
use uuid::Uuid;

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
async fn fixture(messages: usize) -> Fixture {
    let root = std::env::temp_dir().join(format!("snapshot-page-{}", Uuid::new_v4()));
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
    for index in 0..messages {
        store
            .admit(
                &owner,
                &conversation,
                &MessageInput {
                    client_message_id: Uuid::new_v4().to_string(),
                    text: format!("Synthetic message {index}"),
                },
            )
            .await
            .unwrap();
    }
    Fixture {
        root,
        store,
        owner,
        conversation,
    }
}
impl Fixture {
    /// Every visible message, read the way a client reconciles from 0.
    async fn forward(&self) -> (Vec<Message>, i64) {
        let (mut all, mut after, mut watermark) = (Vec::new(), 0, 0);
        loop {
            let page = self
                .store
                .snapshot(&self.owner, &self.conversation, after, 100)
                .await
                .unwrap();
            watermark = watermark.max(page.last_sequence);
            all.extend(page.messages);
            match page.next_cursor {
                Some(next) => after = next,
                None => return (all, watermark),
            }
        }
    }
    async fn before(&self, before: i64, limit: u32) -> ConversationSnapshot {
        self.store
            .snapshot_before(&self.owner, &self.conversation, before, limit)
            .await
            .unwrap()
    }
}
fn ids(messages: &[Message]) -> Vec<(i64, String)> {
    messages
        .iter()
        .map(|m| (m.sequence, m.text.clone()))
        .collect()
}

#[tokio::test]
async fn the_newest_page_is_the_tail_of_a_full_scan_and_older_pages_follow() {
    let f = fixture(230).await;
    let (all, watermark) = f.forward().await;
    assert_eq!(all.len(), 230);
    let newest = f.before(i64::MAX, 100).await;
    assert_eq!(newest.last_sequence, watermark);
    assert_eq!(newest.next_cursor, None);
    assert_eq!(newest.conversation_id, f.conversation);
    assert_eq!(ids(&newest.messages), ids(&all[130..]));
    // A cursor just above the watermark reads the same page.
    assert_eq!(
        ids(&f.before(watermark + 1, 100).await.messages),
        ids(&all[130..])
    );
    let older = f.before(newest.messages[0].sequence, 100).await;
    assert_eq!(ids(&older.messages), ids(&all[30..130]));
    assert_eq!(older.last_sequence, watermark, "the watermark is unchanged");
    let oldest = f.before(older.messages[0].sequence, 100).await;
    assert_eq!(
        ids(&oldest.messages),
        ids(&all[..30]),
        "a short page ends it"
    );
    assert!(f
        .before(oldest.messages[0].sequence, 100)
        .await
        .messages
        .is_empty());
    // The limit is bounded like the forward read.
    assert_eq!(f.before(i64::MAX, 0).await.messages.len(), 1);
    assert_eq!(f.before(i64::MAX, 500).await.messages.len(), 100);
}

#[tokio::test]
async fn a_short_conversation_reads_whole_and_bad_cursors_or_scopes_fail() {
    let f = fixture(3).await;
    let (all, _) = f.forward().await;
    assert_eq!(ids(&f.before(i64::MAX, 100).await.messages), ids(&all));
    assert!(f.before(1, 100).await.messages.is_empty());
    for before in [0, -1, i64::MIN] {
        assert!(matches!(
            f.store
                .snapshot_before(&f.owner, &f.conversation, before, 100)
                .await,
            Err(StoreError::Invalid)
        ));
    }
    assert!(matches!(
        f.store
            .snapshot_before(&f.owner, &ConversationId(Uuid::new_v4()), i64::MAX, 100)
            .await,
        Err(StoreError::NotFound)
    ));
    assert!(matches!(
        f.store
            .snapshot_before(&OwnerId(Uuid::new_v4()), &f.conversation, i64::MAX, 100)
            .await,
        Err(StoreError::NotFound)
    ));
}
