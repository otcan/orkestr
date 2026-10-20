//! Concurrent conversations: owner-wide live capacity, durable FIFO intent and
//! per-conversation isolation. Synthetic identities only; no provider starts.
use super::*;
use crate::production_runtime::tests as fixtures;
use orkestr_v2_application::IntakeStore;
use orkestr_v2_contracts::{ConversationInput, MessageInput, QueuedWindowState, QueuedWindowWithdrawal};

struct Owner {
    store: Store,
    owner: OwnerId,
    home: ConversationId,
    browser: String,
}

async fn owner() -> Owner {
    let path = std::path::PathBuf::from(std::env::var_os("ORKESTR_V2_HOME").unwrap())
        .join(format!("window-queue-{}", Uuid::new_v4()))
        .join("core.sqlite3");
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    let store = Store::open(&path).await.unwrap();
    let home = store.setup("synthetic-owner", "synthetic-hash").await.unwrap();
    let owner = store
        .credentials("synthetic-owner")
        .await
        .unwrap()
        .unwrap()
        .0;
    let browser = format!("synthetic-browser-{}", Uuid::new_v4());
    store.save_session(&browser, &owner).await.unwrap();
    Owner {
        store,
        owner,
        home,
        browser,
    }
}

impl Owner {
    async fn conversation(&self, name: &str) -> ConversationId {
        self.store
            .create_conversation_authenticated(
                &self.browser,
                &ConversationInput {
                    client_request_id: format!("create-{name}"),
                    name: name.into(),
                },
            )
            .await
            .unwrap()
            .0
            .conversation_id
    }
    async fn input(&self, conversation: &ConversationId, key: &str) -> ExecutionWindowRequest {
        let receipt = self
            .store
            .admit(
                &self.owner,
                conversation,
                &MessageInput {
                    client_message_id: key.into(),
                    text: "synthetic queued input".into(),
                },
            )
            .await
            .unwrap()
            .receipt;
        ExecutionWindowRequest {
            request_key: format!("window-{key}"),
            input_message_id: receipt.message_id,
            input_event_id: receipt.event_id,
            input_request_key: key.into(),
            expected_generation: 0,
            window_id: None,
            predecessor_window_id: None,
        }
    }
    /// Private first-window bootstrap with a conversation-derived context.
    async fn bootstrap(&self, conversation: &ConversationId, name: &str) {
        let mut config = fixtures::config(ProductionTakeover::First);
        config.namespace = format!("synthetic-{name}-context");
        config.supervisor_key = format!("synthetic-{name}-supervisor");
        self.store
            .bootstrap_execution_window_authenticated(&self.browser, conversation, config)
            .await
            .unwrap();
    }
    async fn admit(
        &self,
        conversation: &ConversationId,
        request: &ExecutionWindowRequest,
        capacity: u32,
    ) -> Result<ExecutionWindowAdmission> {
        self.store
            .admit_execution_window_capped_authenticated(
                &self.browser,
                conversation,
                request,
                capacity,
            )
            .await
    }
}

#[tokio::test]
async fn independent_conversations_open_windows_up_to_the_owner_capacity() {
    let o = owner().await;
    let (a, b, c) = (
        o.home.clone(),
        o.conversation("second").await,
        o.conversation("third").await,
    );
    for (conversation, name) in [(&a, "a"), (&b, "b"), (&c, "c")] {
        o.bootstrap(conversation, name).await;
    }
    let first = o.admit(&a, &o.input(&a, "a-1").await, 2).await.unwrap();
    let second = o.admit(&b, &o.input(&b, "b-1").await, 2).await.unwrap();
    assert_ne!(first.status.window_id, second.status.window_id);
    assert_eq!(first.status.conversation_id, a);
    assert_eq!(second.status.conversation_id, b);
    let third = o.input(&c, "c-1").await;
    assert!(matches!(
        o.admit(&c, &third, 2).await,
        Err(RuntimeStoreError::Busy)
    ));
    assert!(o
        .store
        .execution_window_status_authenticated(&o.browser, &c)
        .await
        .unwrap()
        .is_none());
    o.admit(&c, &third, 3).await.unwrap();
    assert_eq!(
        o.store
            .live_execution_windows_authenticated(&o.browser)
            .await
            .unwrap(),
        3
    );
    // Each conversation still has at most one unresolved window.
    let again = o.input(&a, "a-2").await;
    let mut fresh = again.clone();
    fresh.expected_generation = 1;
    fresh.predecessor_window_id = Some(first.status.window_id);
    assert!(o.admit(&a, &fresh, 8).await.is_err());
    let unresolved = o
        .store
        .unresolved_execution_windows_authenticated(&o.browser)
        .await
        .unwrap();
    assert_eq!(unresolved.len(), 3);
}

#[tokio::test]
async fn uncertain_conversation_blocks_only_itself_and_releases_capacity() {
    let o = owner().await;
    let b = o.conversation("isolated").await;
    o.bootstrap(&o.home, "home").await;
    let lost = o
        .admit(&o.home, &o.input(&o.home, "home-1").await, 1)
        .await
        .unwrap();
    o.bootstrap(&b, "isolated").await;
    let queued = o.input(&b, "isolated-1").await;
    assert!(matches!(
        o.admit(&b, &queued, 1).await,
        Err(RuntimeStoreError::Busy)
    ));
    o.store
        .reconcile_execution_window_authenticated(
            &o.browser,
            &o.home,
            lost.status.window_id,
            lost.status.generation,
        )
        .await
        .unwrap();
    assert_eq!(
        o.store
            .live_execution_windows_authenticated(&o.browser)
            .await
            .unwrap(),
        0
    );
    o.admit(&b, &queued, 1).await.unwrap();
    let mut successor = o.input(&o.home, "home-2").await;
    successor.expected_generation = 1;
    successor.predecessor_window_id = Some(lost.status.window_id);
    assert!(o.admit(&o.home, &successor, 8).await.is_err());
}

#[tokio::test]
async fn queue_is_durable_fifo_idempotent_and_dispatches_exactly_once() {
    let o = owner().await;
    let b = o.conversation("queued").await;
    let first = o.input(&o.home, "home-queued").await;
    let second = o.input(&b, "other-queued").await;
    let one = o
        .store
        .enqueue_execution_window_authenticated(&o.browser, &o.home, &first)
        .await
        .unwrap();
    let two = o
        .store
        .enqueue_execution_window_authenticated(&o.browser, &b, &second)
        .await
        .unwrap();
    assert_eq!((one.position, two.position), (Some(1), Some(2)));
    assert_eq!(one.state, QueuedWindowState::Queued);
    // Identical replay is stable; changed body or reused input conflicts.
    let replay = o
        .store
        .enqueue_execution_window_authenticated(&o.browser, &o.home, &first)
        .await
        .unwrap();
    assert_eq!(replay, one);
    let mut changed = first.clone();
    changed.expected_generation = 4;
    for (conversation, body) in [
        (&o.home, changed.clone()),
        (
            &o.home,
            ExecutionWindowRequest {
                request_key: "another-key".into(),
                ..first.clone()
            },
        ),
    ] {
        assert!(matches!(
            o.store
                .enqueue_execution_window_authenticated(&o.browser, conversation, &body)
                .await,
            Err(RuntimeStoreError::Conflict)
        ));
    }
    assert!(matches!(
        o.store
            .queued_execution_window_authenticated(&o.browser, &o.home, &changed)
            .await,
        Err(RuntimeStoreError::Conflict)
    ));
    // Follow-up intent never queues; a foreign or revoked browser reads nothing.
    let mut follow = first.clone();
    follow.window_id = Some(Uuid::new_v4());
    assert!(o
        .store
        .enqueue_execution_window_authenticated(&o.browser, &o.home, &follow)
        .await
        .is_err());
    assert!(o
        .store
        .execution_window_queue_authenticated("synthetic-foreign", None)
        .await
        .is_err());
    let all = o
        .store
        .execution_window_queue_authenticated(&o.browser, None)
        .await
        .unwrap();
    assert_eq!(all, vec![one.clone(), two.clone()]);
    // Admission of the second conversation marks only its row dispatched.
    o.bootstrap(&b, "queued").await;
    let admitted = o.admit(&b, &second, 8).await.unwrap();
    let dispatched = o
        .store
        .queued_execution_window_authenticated(&o.browser, &b, &second)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(dispatched.state, QueuedWindowState::Dispatched);
    assert_eq!(dispatched.window_id, Some(admitted.status.window_id));
    assert_eq!(dispatched.position, None);
    let remaining = o
        .store
        .execution_window_queue_authenticated(&o.browser, None)
        .await
        .unwrap();
    assert_eq!(remaining.len(), 1);
    assert_eq!(remaining[0].position, Some(1));
    // The dispatched input can never be admitted or queued a second time.
    let mut twice = second.clone();
    twice.request_key = "window-dispatched-again".into();
    assert!(o.admit(&b, &twice, 8).await.is_err());
    assert!(o
        .store
        .enqueue_execution_window_authenticated(&o.browser, &b, &twice)
        .await
        .is_err());
    // Withdrawal is terminal and leaves the message in history.
    let withdrawn = o
        .store
        .withdraw_queued_execution_window_authenticated(
            &o.browser,
            &o.home,
            &first.request_key,
            QueuedWindowWithdrawal::InputUnavailable,
        )
        .await
        .unwrap();
    assert_eq!(withdrawn.state, QueuedWindowState::Withdrawn);
    let again = o
        .store
        .withdraw_queued_execution_window_authenticated(
            &o.browser,
            &o.home,
            &first.request_key,
            QueuedWindowWithdrawal::AdmissionRefused,
        )
        .await
        .unwrap();
    assert_eq!(again, withdrawn);
    assert!(o
        .store
        .execution_window_queue_authenticated(&o.browser, Some(&o.home))
        .await
        .unwrap()
        .is_empty());
}

#[tokio::test]
async fn queued_rows_survive_reopen_without_dispatch() {
    let o = owner().await;
    let request = o.input(&o.home, "durable").await;
    o.store
        .enqueue_execution_window_authenticated(&o.browser, &o.home, &request)
        .await
        .unwrap();
    let path: String = sqlx::query_scalar("SELECT file FROM pragma_database_list WHERE name='main'")
        .fetch_one(&o.store.pool)
        .await
        .unwrap();
    o.store.close().await;
    let reopened = Store::open(std::path::Path::new(&path)).await.unwrap();
    let rows = reopened
        .execution_window_queue_authenticated(&o.browser, None)
        .await
        .unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].input_event_id, request.input_event_id);
    assert_eq!(rows[0].state, QueuedWindowState::Queued);
    let windows: i64 = sqlx::query_scalar("SELECT count(*) FROM execution_windows")
        .fetch_one(&reopened.pool)
        .await
        .unwrap();
    assert_eq!(windows, 0);
}
