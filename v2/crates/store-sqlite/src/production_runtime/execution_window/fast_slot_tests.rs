//! Concurrent window Fast slots: real Store transactions, synthetic natives.
use super::*;
use orkestr_v2_application::IntakeStore;
use orkestr_v2_contracts::{ExecutionAcceptanceRequest, MessageInput};

async fn ready(w: &Window, binding: &Binding, name: &str) -> Binding {
    let grant = w
        .bound
        .authorize_bounded_fast_metadata(w.credential.credential(), binding)
        .await
        .unwrap();
    let binding = grant.binding().clone();
    w.bound
        .confirm_metadata_session(
            grant,
            NativeSessionConfirmation {
                session_id: binding.session_id.clone(),
                expected_generation: binding.generation,
                native_session_id: name.into(),
                protocol_version: "synthetic-codex-1".into(),
                source_event_key: format!("ready:{name}"),
            },
        )
        .await
        .unwrap()
        .binding()
        .clone()
}

fn fast_input(binding: &Binding, request: &ExecutionWindowRequest) -> FastAdmissionInput {
    FastAdmissionInput {
        source_message_id: request.input_message_id.clone(),
        source_event_id: request.input_event_id.clone(),
        fast_binding_id: binding.session_id.clone(),
        expected_binding_generation: binding.generation,
        request_key: format!("fast-http:{}", request.input_event_id),
    }
}

async fn present(
    w: &Window,
    binding: &Binding,
    request: &ExecutionWindowRequest,
) -> ConsumedProviderDispatch {
    let admission = w
        .bound
        .admit_fast(w.credential.credential(), &fast_input(binding, request))
        .await
        .unwrap();
    w.consume(&admission).await
}

async fn accept(w: &Window, p: &ProviderAdmission, text: &str) {
    let done = propose(w, p, text).await;
    decide(w, p, done).await;
}

async fn propose(w: &Window, p: &ProviderAdmission, text: &str) -> EventId {
    for (n, event) in [
        (1, ProviderEvent::Started),
        (2, ProviderEvent::Progress(text.into())),
    ] {
        w.bound
            .append_provider_event(&w.f.owner, p, &observation(p, n, event))
            .await
            .unwrap();
    }
    let done = w
        .bound
        .append_provider_event(
            &w.f.owner,
            p,
            &observation(p, 3, ProviderEvent::CompletedProposal { synthetic: false }),
        )
        .await
        .unwrap()
        .event_id;
    done
}

async fn decide(w: &Window, p: &ProviderAdmission, done: EventId) {
    let revision: i64 =
        sqlx::query_scalar("SELECT revision FROM execution_revisions WHERE conversation_id=?")
            .bind(w.f.conversation.to_string())
            .fetch_one(&w.f.store.pool)
            .await
            .unwrap();
    w.f.store
        .accept_execution_authenticated(
            &w.browser_credential,
            &w.f.conversation,
            &ExecutionAcceptanceRequest {
                run_id: p.run.run_id.clone(),
                completion_event_id: done,
                expected_revision: revision,
                request_key: format!("accept:{}", p.run.run_id),
            },
        )
        .await
        .unwrap();
}

/// Another owner input joined to the open window (a burst message).
async fn join(w: &Window, n: usize) -> ExecutionWindowRequest {
    let key = format!("burst-{n}");
    let receipt =
        w.f.store
            .admit(
                &w.f.owner,
                &w.f.conversation,
                &MessageInput {
                    client_message_id: key.clone(),
                    text: format!("BURST_MESSAGE_{n}"),
                },
            )
            .await
            .unwrap()
            .receipt;
    let request = ExecutionWindowRequest {
        request_key: format!("window:{key}"),
        input_message_id: receipt.message_id,
        input_event_id: receipt.event_id,
        input_request_key: key,
        expected_generation: 1,
        window_id: Some(w.status.window_id),
        predecessor_window_id: None,
    };
    w.f.store
        .admit_execution_window_authenticated(&w.browser_credential, &w.f.conversation, &request)
        .await
        .unwrap();
    request
}

async fn live_fast(w: &Window) -> Vec<(String, i64, String)> {
    sqlx::query_as("SELECT id,fast_slot,state FROM session_bindings WHERE conversation_id=? AND role='fast' AND state!='retired' ORDER BY fast_slot")
        .bind(w.f.conversation.to_string())
        .fetch_all(&w.f.store.pool)
        .await
        .unwrap()
}

async fn allocate(w: &Window) -> (Binding, u8) {
    w.bound
        .allocate_bounded_fast_slot(w.credential.credential())
        .await
        .unwrap()
}

async fn state(w: &Window, session: &SessionId) -> String {
    sqlx::query_scalar("SELECT state FROM session_bindings WHERE id=?")
        .bind(session.to_string())
        .fetch_one(&w.f.store.pool)
        .await
        .unwrap()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn burst_presents_every_input_in_its_own_concurrent_fresh_session() {
    let w = Window::open().await;
    let lineage = ready(&w, &w.roles.fast, "slot-lineage").await;
    // Slots belong to a live (active) window only.
    assert!(w
        .bound
        .allocate_bounded_fast_slot(w.credential.credential())
        .await
        .is_err());
    w.activate().await;
    let mut burst = vec![w.source.clone()];
    for n in 1..9 {
        burst.push(join(&w, n).await);
    }
    let deep_before = w
        .bound
        .ensure_role_bindings(&w.f.owner, &w.f.conversation)
        .await
        .unwrap()
        .deep;
    let inbox_before: Vec<(String, String, i64)> = sqlx::query_as(
        "SELECT event_id,state,claim_generation FROM reasoning_inbox ORDER BY sequence",
    )
    .fetch_all(&w.f.store.pool)
    .await
    .unwrap();
    // Slot 0 presents the first input; seven slots present the next seven
    // concurrently, none waiting for another's acceptance.
    let mut caps = vec![present(&w, &lineage, &burst[0]).await];
    for (n, request) in burst.iter().enumerate().take(8).skip(1) {
        let (binding, slot) = allocate(&w).await;
        assert_eq!(usize::from(slot), n);
        let binding = ready(&w, &binding, &format!("slot-native-{n}")).await;
        caps.push(present(&w, &binding, request).await);
    }
    assert_eq!(live_fast(&w).await.len(), 8);
    let busy: i64 = sqlx::query_scalar("SELECT count(*) FROM production_runs WHERE role='fast' AND state NOT IN ('succeeded','cancelled','failed')")
        .fetch_one(&w.f.store.pool).await.unwrap();
    assert_eq!(busy, 8);
    // Hard per-conversation ceiling: the ninth waits for a free slot.
    assert!(matches!(
        w.bound
            .allocate_bounded_fast_slot(w.credential.credential())
            .await,
        Err(RuntimeStoreError::Busy)
    ));
    // Each reply is bound to its own message and fresh native session.
    let mut sessions = std::collections::HashSet::new();
    for (cap, request) in caps.iter().zip(&burst) {
        assert_eq!(cap.source_event_id(), &request.input_event_id);
        assert_eq!(cap.message_id(), &request.input_message_id);
        assert!(sessions.insert(cap.provider().run.session_id.clone()));
        let digest: String = sqlx::query_scalar(
            "SELECT source_event_id FROM production_fast_digests WHERE run_id=?",
        )
        .bind(cap.provider().run.run_id.to_string())
        .fetch_one(&w.f.store.pool)
        .await
        .unwrap();
        assert_eq!(digest, request.input_event_id.to_string());
    }
    for (n, cap) in caps.iter().enumerate().skip(1) {
        assert!(cap.text().ends_with(&format!("BURST_MESSAGE_{n}")));
    }
    // An input already presented can never be presented by another slot.
    let (spare, _) = {
        accept(&w, caps[1].provider(), "first slot answer").await;
        w.bound
            .retire_bounded_fast_slot(w.credential.credential(), &caps[1].provider().run.run_id)
            .await
            .unwrap();
        allocate(&w).await
    };
    let spare = ready(&w, &spare, "slot-native-spare").await;
    assert!(w
        .bound
        .admit_fast(w.credential.credential(), &fast_input(&spare, &burst[2]))
        .await
        .is_err());
    // The freed slot presents the ninth input.
    let ninth = present(&w, &spare, &burst[8]).await;
    assert_eq!(ninth.source_event_id(), &burst[8].input_event_id);
    // Deep's binding and inbox are untouched by every Fast slot.
    assert_eq!(
        deep_before,
        w.bound
            .ensure_role_bindings(&w.f.owner, &w.f.conversation)
            .await
            .unwrap()
            .deep
    );
    let inbox_after: Vec<(String, String, i64)> = sqlx::query_as(
        "SELECT event_id,state,claim_generation FROM reasoning_inbox ORDER BY sequence",
    )
    .fetch_all(&w.f.store.pool)
    .await
    .unwrap();
    assert_eq!(inbox_before, inbox_after);
    // The canonical lineage is still the only slot-0 binding.
    assert_eq!(
        w.bound
            .ensure_role_bindings(&w.f.owner, &w.f.conversation)
            .await
            .unwrap()
            .fast
            .session_id,
        lineage.session_id
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn slot_retirement_needs_exact_terminal_truth_and_never_replaces() {
    let w = Window::open().await;
    let lineage = ready(&w, &w.roles.fast, "retire-lineage").await;
    w.activate().await;
    let second = join(&w, 1).await;
    let lineage_cap = present(&w, &lineage, &w.source).await;
    let (binding, slot) = allocate(&w).await;
    assert_eq!(slot, 1);
    let binding = ready(&w, &binding, "retire-slot").await;
    let cap = present(&w, &binding, &second).await;
    let run = cap.provider().run.run_id.clone();
    let before = fixtures::snapshot(&w.f.store).await;
    // Unaccepted work, the canonical lineage and foreign credentials refuse.
    for (credential, run) in [
        (w.credential.credential(), &run),
        (
            w.credential.credential(),
            &lineage_cap.provider().run.run_id,
        ),
        (&"f".repeat(64)[..], &run),
    ] {
        assert!(w
            .bound
            .retire_bounded_fast_slot(credential, run)
            .await
            .is_err());
    }
    assert_eq!(before, fixtures::snapshot(&w.f.store).await);
    accept(&w, cap.provider(), "slot answer").await;
    accept(&w, lineage_cap.provider(), "lineage answer").await;
    assert!(w
        .bound
        .retire_bounded_fast_slot(
            w.credential.credential(),
            &lineage_cap.provider().run.run_id
        )
        .await
        .is_err());
    // An accepted slot session is never replaced through the lineage seam.
    let used = w
        .bound
        .bounded_fast_slot_binding(w.credential.credential(), &binding.session_id)
        .await
        .unwrap();
    assert!(w
        .bound
        .authorize_bounded_fast_metadata(w.credential.credential(), &used)
        .await
        .is_err());
    // Only slot 0 keeps a warm native: a used slot session is never
    // continued on another input, while the accepted lineage may be.
    let third = join(&w, 2).await;
    assert!(!w
        .bound
        .bounded_fast_reusable(w.credential.credential(), &used, &third.input_event_id)
        .await
        .unwrap());
    assert!(w
        .bound
        .admit_fast(w.credential.credential(), &fast_input(&used, &third))
        .await
        .is_err());
    let canonical = w
        .bound
        .ensure_role_bindings(&w.f.owner, &w.f.conversation)
        .await
        .unwrap()
        .fast;
    assert_eq!(canonical.session_id, lineage.session_id);
    assert!(w
        .bound
        .bounded_fast_reusable(w.credential.credential(), &canonical, &third.input_event_id)
        .await
        .unwrap());
    w.bound
        .retire_bounded_fast_slot(w.credential.credential(), &run)
        .await
        .unwrap();
    assert_eq!(state(&w, &binding.session_id).await, "retired");
    assert!(w
        .bound
        .retire_bounded_fast_slot(w.credential.credential(), &run)
        .await
        .is_err());
    // The lineage still rotates exactly as before.
    let released = w
        .bound
        .ensure_role_bindings(&w.f.owner, &w.f.conversation)
        .await
        .unwrap()
        .fast;
    let next = ready(&w, &released, "retire-lineage-next").await;
    assert_ne!(next.session_id, lineage.session_id);
    assert_eq!(state(&w, &lineage.session_id).await, "retired");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn window_close_requires_every_slot_terminal_and_retires_leftover_slots() {
    let w = Window::open().await;
    let lineage = ready(&w, &w.roles.fast, "close-lineage").await;
    w.activate().await;
    let inputs = [join(&w, 1).await, join(&w, 2).await];
    let lineage_cap = present(&w, &lineage, &w.source).await;
    let mut slot_caps = Vec::new();
    for (n, request) in inputs.iter().enumerate() {
        let (binding, _) = allocate(&w).await;
        let binding = ready(&w, &binding, &format!("close-slot-{n}")).await;
        slot_caps.push((
            binding.session_id.clone(),
            present(&w, &binding, request).await,
        ));
    }
    // An allocated slot that never launched (window closed during setup).
    let (unused, _) = allocate(&w).await;
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
    let deep = w
        .bound
        .admit_run(
            &claim,
            &w.roles.deep.session_id,
            w.roles.deep.generation,
            "close-deep",
        )
        .await
        .unwrap();
    let deep = w.consume(&deep).await;
    let late = propose(&w, slot_caps[1].1.provider(), "late slot answer").await;
    accept(&w, lineage_cap.provider(), "lineage answer").await;
    accept(&w, slot_caps[0].1.provider(), "slot answer").await;
    accept(&w, deep.provider(), "deep answer").await;
    w.bound
        .begin_execution_window_retirement(
            w.credential.credential(),
            w.status.window_id,
            1,
            "role-test-boot",
        )
        .await
        .unwrap();
    // One slot still awaits its owner decision: close is refused.
    let before = fixtures::snapshot(&w.f.store).await;
    assert!(w
        .bound
        .retire_terminal_supervisor(w.credential.credential(), &deep.provider().run.run_id)
        .await
        .is_err());
    assert_eq!(before, fixtures::snapshot(&w.f.store).await);
    decide(&w, slot_caps[1].1.provider(), late).await;
    // Slot 0 (first) retired itself; the others are swept at close.
    w.bound
        .retire_bounded_fast_slot(
            w.credential.credential(),
            &slot_caps[0].1.provider().run.run_id,
        )
        .await
        .unwrap();
    w.bound
        .retire_terminal_supervisor(w.credential.credential(), &deep.provider().run.run_id)
        .await
        .unwrap();
    for (session, _) in &slot_caps {
        assert_eq!(state(&w, session).await, "retired");
    }
    assert_eq!(state(&w, &unused.session_id).await, "retired");
    // At rest only the canonical lineage remains, exactly as before slots.
    let live = live_fast(&w).await;
    assert_eq!(live.len(), 1);
    assert_eq!(live[0].0, lineage.session_id.to_string());
    assert_eq!(live[0].1, 0);
    w.bound
        .retire_execution_window(
            w.credential.credential(),
            w.status.window_id,
            1,
            "role-test-boot",
            &deep.provider().run.run_id,
        )
        .await
        .unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn schema_keeps_one_live_record_per_slot_and_deep_single() {
    let w = Window::open().await;
    let insert = |slot: i64, role: &'static str| {
        let pool = w.f.store.pool.clone();
        let owner = w.f.owner.to_string();
        let conversation = w.f.conversation.to_string();
        async move {
            sqlx::query("INSERT INTO session_bindings(id,owner_id,conversation_id,role,fast_slot) VALUES(?,?,?,?,?)")
                .bind(uuid::Uuid::new_v4().to_string()).bind(owner).bind(conversation).bind(role).bind(slot)
                .execute(&pool).await
        }
    };
    // Slot 0 Fast and Deep already exist for this window.
    assert!(insert(0, "fast").await.is_err());
    assert!(insert(0, "deep").await.is_err());
    assert!(insert(1, "deep").await.is_err());
    assert!(insert(8, "fast").await.is_err());
    assert!(insert(-1, "fast").await.is_err());
    assert!(insert(3, "fast").await.is_ok());
    assert!(insert(3, "fast").await.is_err());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn crash_leftover_slots_retire_once_settled_and_unresolved_ones_stay() {
    let w = Window::open().await;
    let lineage = ready(&w, &w.roles.fast, "leftover-lineage").await;
    w.activate().await;
    let inputs = [join(&w, 1).await, join(&w, 2).await];
    let _lineage_cap = present(&w, &lineage, &w.source).await;
    let mut caps = Vec::new();
    for (n, request) in inputs.iter().enumerate() {
        let (binding, _) = allocate(&w).await;
        let binding = ready(&w, &binding, &format!("leftover-slot-{n}")).await;
        caps.push((
            binding.session_id.clone(),
            present(&w, &binding, request).await,
        ));
    }
    accept(&w, caps[0].1.provider(), "settled slot answer").await;
    // A crash: recovery marked every native of the incarnation lost.
    sqlx::query("UPDATE session_bindings SET state='lost' WHERE fast_slot>0 AND state!='retired'")
        .execute(&w.f.store.pool)
        .await
        .unwrap();
    let mut tx = w.f.store.pool.begin().await.unwrap();
    crate::production_runtime::fast_slots::retire_settled(
        &mut tx,
        &w.f.owner.to_string(),
        &w.f.conversation.to_string(),
        None,
    )
    .await
    .unwrap();
    tx.commit().await.unwrap();
    assert_eq!(state(&w, &caps[0].0).await, "retired");
    // Its run has no terminal truth yet: stranded handling decides first.
    assert_eq!(state(&w, &caps[1].0).await, "lost");
    assert_eq!(state(&w, &lineage.session_id).await, "busy");
}
