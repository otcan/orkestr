//! Controller queue, restart sweep and exactly-once dispatch. No manager runs:
//! a dispatched window's transport fails closed, which must never re-dispatch.
use super::*;
use crate::{
    beta_config::BetaConfig,
    window_runtime::{
        controller::WindowOutcome, handles::Handles, initial::InitialAuthority,
        manager_client::ManagerClient,
    },
};
use orkestr_v2_application::{
    runtime::{ProductionSupervisorConfig, ProductionTakeover, ProviderKind},
    IntakeStore,
};
use orkestr_v2_contracts::{
    ConversationId, ConversationInput, ExecutionWindowLimits, MessageInput, OwnerId,
    QueuedWindowState,
};
use orkestr_v2_store_sqlite::Store;
use uuid::Uuid;

const BROWSER: &str = "synthetic-browser";

struct Fixture {
    root: std::path::PathBuf,
    store: Store,
    owner: OwnerId,
    home: ConversationId,
}

async fn fixture() -> Fixture {
    let root = std::path::PathBuf::from(std::env::var_os("ORKESTR_V2_HOME").unwrap())
        .join(format!("window-dispatch-{}", Uuid::new_v4()));
    std::fs::create_dir_all(&root).unwrap();
    let store = Store::open(&root.join("core.sqlite3")).await.unwrap();
    let home = store.setup("owner", "synthetic-hash").await.unwrap();
    let owner = store.credentials("owner").await.unwrap().unwrap().0;
    store.save_session(BROWSER, &owner).await.unwrap();
    Fixture {
        root,
        store,
        owner,
        home,
    }
}

impl Fixture {
    fn controller(&self, capacity: u32) -> Controller {
        let config: BetaConfig = serde_json::from_value(serde_json::json!({
            "schema_version":1,"owner_id":self.owner,"conversation_id":self.home,
            "manager_socket":self.root.join("absent-manager.sock"),"launcher":"/opt/synthetic/launcher",
            "launcher_sha256":"a".repeat(64),"workspace":"/srv/synthetic/workspace",
            "namespace":"synthetic-native","supervisor_key":"synthetic-supervisor",
            "max_active_windows":capacity
        }))
        .unwrap();
        let stat = std::fs::read_to_string("/proc/self/stat").unwrap();
        let parent = stat.rsplit_once(')').unwrap().1.split_whitespace().nth(1);
        let manager = ManagerClient::new(
            config.manager_socket.clone(),
            self.owner.clone(),
            self.home.clone(),
            parent.unwrap().parse().unwrap(),
        )
        .unwrap();
        Controller::new(
            config.clone(),
            self.root.clone(),
            self.store.clone(),
            Arc::new(InitialAuthority::new(&config).unwrap()),
            Handles::new(self.owner.clone(), self.home.clone()).unwrap(),
            manager,
        )
    }
    async fn conversation(&self, name: &str) -> ConversationId {
        self.store
            .create_conversation_authenticated(
                BROWSER,
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
    async fn request(&self, conversation: &ConversationId, key: &str) -> ExecutionWindowRequest {
        let receipt = self
            .store
            .admit(
                &self.owner,
                conversation,
                &MessageInput {
                    client_message_id: key.into(),
                    text: "synthetic input".into(),
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
    /// A live window opened by "another process": Core rows only, no local task.
    async fn occupy(&self, conversation: &ConversationId, name: &str) -> ExecutionWindowStatus {
        self.store
            .bootstrap_execution_window_authenticated(
                BROWSER,
                conversation,
                ProductionSupervisorConfig {
                    provider: ProviderKind::Codex,
                    namespace: format!("synthetic-{name}"),
                    supervisor_key: format!("synthetic-{name}-supervisor"),
                    takeover: ProductionTakeover::First,
                },
            )
            .await
            .unwrap();
        let request = self.request(conversation, &format!("{name}-live")).await;
        self.store
            .admit_execution_window_capped_authenticated(BROWSER, conversation, &request, 8)
            .await
            .unwrap()
            .status
    }
    async fn windows(&self, conversation: &ConversationId) -> usize {
        let status = self
            .store
            .execution_window_status_authenticated(BROWSER, conversation)
            .await
            .unwrap();
        status.map_or(0, |status| status.generation as usize)
    }
}

#[tokio::test]
async fn saturated_capacity_queues_durably_then_dispatches_exactly_once() {
    let f = fixture().await;
    let (busy, waiting) = (
        f.conversation("busy").await,
        f.conversation("waiting").await,
    );
    let live = f.occupy(&busy, "busy").await;
    let controller = f.controller(1);
    // The busy window stands for live work in this same process, so the
    // cold-start orphan sweep (covered separately) must not reclaim it.
    controller.queue.swept.store(true, Ordering::Release);
    let request = f.request(&waiting, "queued").await;
    let WindowOutcome::Queued(queued) = controller
        .process(BROWSER, &f.owner, &waiting, &request)
        .await
        .unwrap()
    else {
        panic!("saturated capacity must queue, not start or refuse")
    };
    assert_eq!(
        (queued.state, queued.position),
        (QueuedWindowState::Queued, Some(1))
    );
    // Identical retry replays the queue receipt; a changed body conflicts.
    let WindowOutcome::Queued(replay) = controller
        .process(BROWSER, &f.owner, &waiting, &request)
        .await
        .unwrap()
    else {
        panic!("retry must replay the queue receipt")
    };
    assert_eq!(replay, queued);
    let mut changed = request.clone();
    changed.input_request_key = "changed".into();
    assert!(controller
        .process(BROWSER, &f.owner, &waiting, &changed)
        .await
        .is_err());
    let queue = controller.queue_status(BROWSER, &waiting).await.unwrap();
    assert_eq!(
        (queue.capacity, queue.active, queue.queued_total),
        (1, 1, 1)
    );
    assert_eq!(queue.entries, vec![queued.clone()]);
    assert_eq!(f.windows(&waiting).await, 0);
    // No conversation borrows another conversation's local handles.
    for conversation in [&busy, &waiting, &f.home] {
        assert!(controller.snapshot(&f.owner, conversation).is_none());
        assert!(controller.fast_snapshot(&f.owner, conversation).is_none());
    }
    // Still saturated: a dispatch pass leaves the intent queued.
    controller.dispatch_once().await;
    assert_eq!(f.windows(&waiting).await, 0);
    // The busy window becomes uncertain elsewhere: its slot frees.
    f.store
        .reconcile_execution_window_authenticated(BROWSER, &busy, live.window_id, live.generation)
        .await
        .unwrap();
    controller.queue.wake();
    controller.dispatch_once().await;
    let dispatched = f
        .store
        .queued_execution_window_authenticated(BROWSER, &waiting, &request)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(dispatched.state, QueuedWindowState::Dispatched);
    assert_eq!(f.windows(&waiting).await, 1);
    // The absent manager failed the transport; nothing is admitted again.
    for _ in 0..4 {
        controller.queue.wake();
        controller.dispatch_once().await;
    }
    assert_eq!(f.windows(&waiting).await, 1);
    assert!(controller
        .queue_status(BROWSER, &waiting)
        .await
        .unwrap()
        .entries
        .is_empty());
    let WindowOutcome::Queued(after) = controller
        .process(BROWSER, &f.owner, &waiting, &request)
        .await
        .unwrap()
    else {
        panic!("a dispatched intent replays its queue receipt")
    };
    assert_eq!(after.window_id, dispatched.window_id);
    controller.queue.close().await;
}

#[tokio::test]
async fn restart_sweep_reconciles_every_orphaned_window_and_frees_capacity() {
    let f = fixture().await;
    let (a, b, c) = (
        f.conversation("first").await,
        f.conversation("second").await,
        f.conversation("third").await,
    );
    let first = f.occupy(&a, "first").await;
    let second = f.occupy(&b, "second").await;
    assert_eq!(
        f.store
            .live_execution_windows_authenticated(BROWSER)
            .await
            .unwrap(),
        2
    );
    // A fresh process owns neither window. Its first authenticated read arms
    // the sweep; each orphan blocks only its own conversation afterwards.
    let controller = f.controller(2);
    assert!(controller.status(BROWSER, &c).await.unwrap().is_none());
    controller.dispatch_once().await;
    for (conversation, window) in [(&a, &first), (&b, &second)] {
        let status = f
            .store
            .execution_window_status_authenticated(BROWSER, conversation)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(status.window_id, window.window_id);
        assert_eq!(status.state, ExecutionWindowState::ReconciliationRequired);
    }
    assert_eq!(
        f.store
            .live_execution_windows_authenticated(BROWSER)
            .await
            .unwrap(),
        0
    );
    // An unaffected conversation still gets a full-capacity admission in Core.
    f.occupy(&c, "third").await;
    controller.queue.close().await;
}

#[test]
fn queued_intent_is_rebuilt_against_current_window_state() {
    let conversation = ConversationId(Uuid::new_v4());
    let row = ExecutionWindowQueued {
        conversation_id: conversation.clone(),
        request_key: "queued".into(),
        input_message_id: orkestr_v2_contracts::MessageId(Uuid::new_v4()),
        input_event_id: orkestr_v2_contracts::EventId(Uuid::new_v4()),
        input_request_key: "input".into(),
        state: QueuedWindowState::Queued,
        position: Some(1),
        queued_at_ms: 0,
        window_id: None,
        withdrawal: None,
    };
    let status = |state, deadline| ExecutionWindowStatus {
        window_id: Uuid::from_u128(9),
        conversation_id: conversation.clone(),
        generation: 4,
        state,
        input_message_id: row.input_message_id.clone(),
        input_event_id: row.input_event_id.clone(),
        predecessor_window_id: None,
        opened_at_ms: 0,
        work_deadline_ms: deadline,
        expires_at_ms: deadline + 30_000,
        limits: ExecutionWindowLimits::default(),
    };
    const HOUR: i64 = 3_600_000;
    let Plan::Admit(first) = plan(&row, None, 1_000, HOUR) else {
        panic!("no window starts generation one")
    };
    assert_eq!((first.expected_generation, first.window_id), (0, None));
    let Plan::Admit(next) = plan(
        &row,
        Some(&status(ExecutionWindowState::Closed, 0)),
        1_000,
        HOUR,
    ) else {
        panic!("closed predecessor starts a successor")
    };
    assert_eq!(next.expected_generation, 4);
    assert_eq!(next.predecessor_window_id, Some(Uuid::from_u128(9)));
    let Plan::Admit(follow) = plan(
        &row,
        Some(&status(ExecutionWindowState::Active, 100_000)),
        1_000,
        HOUR,
    ) else {
        panic!("a live window takes the follow-up")
    };
    assert_eq!(follow.window_id, Some(Uuid::from_u128(9)));
    assert_eq!(follow.request_key, row.request_key);
    for (state, deadline) in [
        (ExecutionWindowState::Active, 3_000),
        (ExecutionWindowState::Opening, 100_000),
        (ExecutionWindowState::Retiring, 100_000),
    ] {
        assert!(matches!(
            plan(&row, Some(&status(state, deadline)), 1_000, HOUR),
            Plan::Wait
        ));
    }
    // Less than ten minutes of work left: a follow-up joins only if the
    // window can still be extended that far, else it opens the successor.
    let short = status(ExecutionWindowState::Active, 870_000);
    assert!(matches!(
        plan(&row, Some(&short), 300_000, 900_000),
        Plan::Wait
    ));
    assert!(matches!(
        plan(&row, Some(&short), 300_000, HOUR),
        Plan::Admit(ExecutionWindowRequest {
            window_id: Some(_),
            ..
        })
    ));
    let capped = status(ExecutionWindowState::Active, HOUR - 30_000);
    assert!(matches!(
        plan(&row, Some(&capped), HOUR - 500_000, HOUR),
        Plan::Wait
    ));
    assert!(matches!(
        plan(&row, Some(&capped), HOUR - 700_000, HOUR),
        Plan::Admit(_)
    ));
    assert!(matches!(
        plan(
            &row,
            Some(&status(ExecutionWindowState::ReconciliationRequired, 0)),
            1_000,
            HOUR
        ),
        Plan::Withdraw(QueuedWindowWithdrawal::ReconciliationRequired)
    ));
}

fn pressure_fixture(
    root: &std::path::Path,
    cpu_avg60: f64,
) -> crate::window_runtime::pressure::Source {
    let dir = root.join("proc");
    std::fs::create_dir_all(dir.join("pressure")).unwrap();
    std::fs::write(
        dir.join("pressure/cpu"),
        format!("some avg10={cpu_avg60:.2} avg60={cpu_avg60:.2} avg300=0.00 total=1\n"),
    )
    .unwrap();
    std::fs::write(
        dir.join("pressure/memory"),
        "some avg10=0.00 avg60=0.00 avg300=0.00 total=0\n",
    )
    .unwrap();
    std::fs::write(dir.join("meminfo"), "MemAvailable:   41627040 kB\n").unwrap();
    crate::window_runtime::pressure::Source::at(&dir)
}

#[tokio::test]
async fn host_pressure_queues_new_windows_and_owner_input_goes_before_timers() {
    let f = fixture().await;
    let (busy, owner_chat, timer_chat) = (
        f.conversation("busy").await,
        f.conversation("owner-chat").await,
        f.conversation("timer-chat").await,
    );
    f.occupy(&busy, "busy").await;
    let mut controller = f.controller(64);
    controller.queue.swept.store(true, Ordering::Release);
    // Saturated CPU: even owner input waits although the backstop has room.
    controller.pressure = pressure_fixture(&f.root, 90.0);
    let owner = f.request(&owner_chat, "owner-input").await;
    let WindowOutcome::Queued(queued) = controller
        .process(BROWSER, &f.owner, &owner_chat, &owner)
        .await
        .unwrap()
    else {
        panic!("a busy host must queue a new window")
    };
    assert_eq!(queued.state, QueuedWindowState::Queued);
    let host = controller
        .queue_status(BROWSER, &owner_chat)
        .await
        .unwrap()
        .host
        .unwrap();
    assert_eq!(
        (host.cpu_pressure_pct, host.interactive_wait),
        (90, Some(orkestr_v2_contracts::HostBusyReason::CpuPressure))
    );
    controller.dispatch_once().await;
    assert_eq!(f.windows(&owner_chat).await, 0);
    // Moderate pressure: owner input opens, a timer occurrence keeps waiting.
    controller.pressure = pressure_fixture(&f.root, 55.0);
    let mut timer = f.request(&timer_chat, "timer:synthetic-claim").await;
    timer.request_key = "timer-window:synthetic".into();
    let WindowOutcome::Queued(_) = controller
        .process(BROWSER, &f.owner, &timer_chat, &timer)
        .await
        .unwrap()
    else {
        panic!("background work waits on a moderately busy host")
    };
    controller.queue.wake();
    controller.dispatch_once().await;
    assert_eq!(f.windows(&owner_chat).await, 1);
    assert_eq!(f.windows(&timer_chat).await, 0);
    // Calm host: the timer opens too.
    controller.pressure = pressure_fixture(&f.root, 5.0);
    controller.queue.wake();
    controller.dispatch_once().await;
    assert_eq!(f.windows(&timer_chat).await, 1);
    controller.queue.close().await;
}
