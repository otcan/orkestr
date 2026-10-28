//! Read-only parallel Deep slots: real Store transactions, synthetic natives.
//! Both switch states, conflict and side-effect guards, Stop and crash.
use super::*;
use orkestr_v2_application::IntakeStore;
use orkestr_v2_contracts::{
    ConversationProvider, ConversationSettingsUpdate, ExecutionAcceptanceRequest,
    ExecutionWindowReconciliationActor as Actor, ExecutionWindowReconciliationDecision as Decision,
    ExecutionWindowTerminalOutcome as Outcome, MessageInput,
};

async fn switch(w: &Window, on: bool) {
    let current =
        w.f.store
            .conversation_settings(&w.browser_credential, &w.f.owner, &w.f.conversation)
            .await
            .unwrap();
    w.f.store
        .update_conversation_settings(
            &w.browser_credential,
            &w.f.owner,
            &w.f.conversation,
            &ConversationSettingsUpdate {
                expected_revision: current.revision,
                provider: ConversationProvider::Codex,
                model: None,
                reasoning_effort: None,
                honor_no_reply: true,
                reply_prefix: None,
                reply_footer: None,
                review_before_accepting: false,
                parallel_deep: Some(on),
                deep_grouping: None,
            },
        )
        .await
        .unwrap();
}

/// Another owner input joined to the open window (a burst message).
async fn join(w: &Window, n: usize) -> ExecutionWindowRequest {
    let key = format!("parallel-burst-{n}");
    let receipt =
        w.f.store
            .admit(
                &w.f.owner,
                &w.f.conversation,
                &MessageInput {
                    client_message_id: key.clone(),
                    text: format!("PARALLEL_QUESTION_{n}"),
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

/// The canonical writer claims its next input and starts its turn.
async fn writer(w: &Window, key: &str) -> ConsumedProviderDispatch {
    let deep = w
        .bound
        .ensure_role_bindings(&w.f.owner, &w.f.conversation)
        .await
        .unwrap()
        .deep;
    let claim = w
        .bound
        .claim_next(
            &w.f.owner,
            &w.f.conversation,
            &deep.session_id,
            Duration::from_secs(30),
        )
        .await
        .unwrap()
        .unwrap();
    let admission = w
        .bound
        .admit_run(&claim, &deep.session_id, deep.generation, key)
        .await
        .unwrap();
    w.consume(&admission).await
}

/// A fresh, ready parallel slot session of this window.
async fn slot(w: &Window, name: &str) -> (Binding, u8) {
    let (binding, slot) = w
        .bound
        .allocate_parallel_deep_slot(w.credential.credential())
        .await
        .unwrap();
    let grant = w
        .bound
        .authorize_parallel_deep_metadata(w.credential.credential(), &binding)
        .await
        .unwrap();
    let ready = w
        .bound
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
        .clone();
    (ready, slot)
}

async fn claim(w: &Window, slot: &Binding) -> Option<InboxClaim> {
    w.bound
        .claim_parallel_deep_input(w.credential.credential(), &slot.session_id)
        .await
        .unwrap()
}

/// Claim and start one parallel turn through the ordinary admission path.
async fn parallel(w: &Window, slot: &Binding) -> ConsumedProviderDispatch {
    let claim = claim(w, slot).await.expect("an eligible queued input");
    let admission = w
        .bound
        .admit_run(
            &claim,
            &slot.session_id,
            slot.generation,
            &format!("parallel:{}", claim.event_id),
        )
        .await
        .unwrap();
    w.consume(&admission).await
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
    w.bound
        .append_provider_event(
            &w.f.owner,
            p,
            &observation(p, 3, ProviderEvent::CompletedProposal { synthetic: false }),
        )
        .await
        .unwrap()
        .event_id
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

async fn accept(w: &Window, p: &ProviderAdmission, text: &str) {
    let done = propose(w, p, text).await;
    decide(w, p, done).await;
}

async fn scalar(w: &Window, sql: &str, bind: &str) -> String {
    sqlx::query_scalar(sql)
        .bind(bind)
        .fetch_one(&w.f.store.pool)
        .await
        .unwrap()
}

async fn count(store: &Store, sql: &str) -> i64 {
    sqlx::query_scalar(sql)
        .fetch_one(&store.pool)
        .await
        .unwrap()
}

async fn status_run(w: &Window) -> RunId {
    w.bound
        .execution_status(&w.f.owner, &w.f.conversation)
        .await
        .unwrap()
        .unwrap()
        .run_id
        .unwrap()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn switch_off_starts_no_slot_and_keeps_the_single_lineage() {
    let w = Window::open().await;
    w.activate().await;
    let queued = [join(&w, 1).await, join(&w, 2).await];
    let before = fixtures::snapshot(&w.f.store).await;
    assert!(!w
        .bound
        .parallel_deep_enabled(w.credential.credential())
        .await
        .unwrap());
    // Off (the default): no slot, and nothing written by the attempt.
    assert!(matches!(
        w.bound
            .allocate_parallel_deep_slot(w.credential.credential())
            .await,
        Err(RuntimeStoreError::Fenced)
    ));
    assert_eq!(before, fixtures::snapshot(&w.f.store).await);
    // The writer answers every input in order, exactly as before.
    let first = writer(&w, "off-1").await;
    assert_eq!(first.source_event_id(), &w.source.input_event_id);
    assert_eq!(status_run(&w).await, first.provider().run.run_id);
    accept(&w, first.provider(), "first").await;
    for (n, request) in queued.iter().enumerate() {
        let next = writer(&w, &format!("off-{}", n + 2)).await;
        assert_eq!(next.source_event_id(), &request.input_event_id);
        accept(&w, next.provider(), "next").await;
    }
    assert_eq!(
        count(
            &w.f.store,
            "SELECT count(*) FROM session_bindings WHERE deep_slot>0"
        )
        .await,
        0
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn burst_answers_queued_inputs_in_slots_while_the_writer_runs() {
    let w = Window::open().await;
    w.activate().await;
    switch(&w, true).await;
    assert!(w
        .bound
        .parallel_deep_enabled(w.credential.credential())
        .await
        .unwrap());
    let burst: Vec<_> = {
        let mut burst = Vec::new();
        for n in 1..=4 {
            burst.push(join(&w, n).await);
        }
        burst
    };
    let (first_slot, number) = slot(&w, "parallel-1").await;
    assert_eq!(number, 1);
    // The writer is idle: it takes its own next input, no slot does.
    assert!(claim(&w, &first_slot).await.is_none());
    let writing = writer(&w, "writer-1").await;
    assert_eq!(writing.source_event_id(), &w.source.input_event_id);
    // While it runs, each slot takes the next queued input, in order.
    let mut caps = vec![parallel(&w, &first_slot).await];
    for n in 2..=3 {
        let (binding, number) = slot(&w, &format!("parallel-{n}")).await;
        assert_eq!(usize::from(number), n);
        caps.push(parallel(&w, &binding).await);
    }
    for (cap, request) in caps.iter().zip(&burst) {
        assert_eq!(cap.source_event_id(), &request.input_event_id);
        assert_eq!(cap.provider().run.role, Role::Deep);
    }
    // Ceiling: three parallel slots; the fourth input waits for the writer.
    assert!(matches!(
        w.bound
            .allocate_parallel_deep_slot(w.credential.credential())
            .await,
        Err(RuntimeStoreError::Busy)
    ));
    // The conversation's Deep status is still the writer's turn.
    assert_eq!(status_run(&w).await, writing.provider().run.run_id);
    // A used slot never answers a second input.
    assert!(w
        .bound
        .claim_parallel_deep_input(w.credential.credential(), &first_slot.session_id)
        .await
        .is_err());
    // Slots never become the conversation's Deep binding.
    assert_eq!(
        w.bound
            .ensure_role_bindings(&w.f.owner, &w.f.conversation)
            .await
            .unwrap()
            .deep
            .session_id,
        w.roles.deep.session_id
    );
    // Each input was consumed exactly once, by its own run.
    for (cap, request) in caps.iter().zip(&burst) {
        assert_eq!(
            scalar(
                &w,
                "SELECT state||':'||admitted_run_id FROM reasoning_inbox WHERE event_id=?",
                &request.input_event_id.to_string()
            )
            .await,
            format!("consumed:{}", cap.provider().run.run_id)
        );
    }
    // Slots finish in any order; the writer then takes only the fourth.
    for cap in caps.iter().rev() {
        accept(&w, cap.provider(), "parallel answer").await;
        w.bound
            .retire_parallel_deep_slot(w.credential.credential(), &cap.provider().run.run_id)
            .await
            .unwrap();
    }
    accept(&w, writing.provider(), "writer answer").await;
    let next = writer(&w, "writer-2").await;
    assert_eq!(next.source_event_id(), &burst[3].input_event_id);
    assert_eq!(status_run(&w).await, next.provider().run.run_id);
    // Schema: an input is still consumed by at most one Deep run.
    let dup: i64 = count(&w.f.store, "SELECT count(*) FROM (SELECT scope_sequence FROM production_runs WHERE role='deep' GROUP BY conversation_id,scope_sequence HAVING count(*)>1)").await;
    assert_eq!(dup, 0);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_slot_claim_and_the_writer_never_take_the_same_input() {
    let w = Window::open().await;
    w.activate().await;
    switch(&w, true).await;
    let second = join(&w, 1).await;
    let third = join(&w, 2).await;
    let writing = writer(&w, "race-writer").await;
    let (binding, _) = slot(&w, "race-slot").await;
    // The slot holds its claim (admission not yet committed) ...
    let held = claim(&w, &binding).await.unwrap();
    assert_eq!(held.event_id, second.input_event_id);
    // ... a second slot never takes the same input ...
    let (other, _) = slot(&w, "race-other").await;
    let other_claim = claim(&w, &other).await.unwrap();
    assert_eq!(other_claim.event_id, third.input_event_id);
    w.bound
        .admit_run(
            &other_claim,
            &other.session_id,
            other.generation,
            "race-other",
        )
        .await
        .unwrap();
    // ... and the writer, done meanwhile, neither waits behind the claim
    // nor takes it: nothing else is queued for it.
    accept(&w, writing.provider(), "writer").await;
    let deep = w
        .bound
        .ensure_role_bindings(&w.f.owner, &w.f.conversation)
        .await
        .unwrap()
        .deep;
    assert!(w
        .bound
        .claim_next(
            &w.f.owner,
            &w.f.conversation,
            &deep.session_id,
            Duration::from_secs(30)
        )
        .await
        .unwrap()
        .is_none());
    // A later input goes to the writer, ahead of the slot's earlier claim.
    let fourth = join(&w, 3).await;
    let next = writer(&w, "race-writer-2").await;
    assert_eq!(next.source_event_id(), &fourth.input_event_id);
    // The slot's claim still admits exactly its own input.
    let admitted = w
        .bound
        .admit_run(&held, &binding.session_id, binding.generation, "race-slot")
        .await
        .unwrap();
    assert_eq!(admitted.disposition, AdmissionDisposition::FreshCandidate);
    // A slot cannot use the canonical claim path at all.
    assert!(w
        .bound
        .claim_next(
            &w.f.owner,
            &w.f.conversation,
            &binding.session_id,
            Duration::from_secs(30)
        )
        .await
        .is_err());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn only_owner_chat_input_is_parallel_and_never_skipped_past() {
    let w = Window::open().await;
    w.activate().await;
    switch(&w, true).await;
    let relayed = join(&w, 1).await;
    let later = join(&w, 2).await;
    sqlx::query("INSERT INTO message_authors(message_id,author) VALUES(?,'v1_agent')")
        .bind(relayed.input_message_id.to_string())
        .execute(&w.f.store.pool)
        .await
        .unwrap();
    let _writing = writer(&w, "eligibility-writer").await;
    let (binding, _) = slot(&w, "eligibility-slot").await;
    // An agent-relayed input is the writer's; the later question is not
    // taken past it either, so the writer's order is kept.
    let before = fixtures::snapshot(&w.f.store).await;
    assert!(claim(&w, &binding).await.is_none());
    assert_eq!(before, fixtures::snapshot(&w.f.store).await);
    let _ = later;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_timer_occurrence_is_never_parallel() {
    let w = Window::open().await;
    w.activate().await;
    switch(&w, true).await;
    let timer = join(&w, 1).await;
    // A timer occurrence (typically outreach) stays with the writer. The
    // synthetic provenance row skips the timer tables' own chain.
    let mut conn = w.f.store.pool.acquire().await.unwrap();
    sqlx::raw_sql("PRAGMA foreign_keys=OFF")
        .execute(&mut *conn)
        .await
        .unwrap();
    sqlx::query("INSERT INTO dormant_timer_inputs(claim_id,owner_id,namespace,generation,input_digest,message_id,event_id,scope_sequence) VALUES('synthetic-claim',?,'synthetic',1,'digest',?,?,0)")
        .bind(w.f.owner.to_string()).bind(timer.input_message_id.to_string()).bind(timer.input_event_id.to_string())
        .execute(&mut *conn).await.unwrap();
    sqlx::raw_sql("PRAGMA foreign_keys=ON")
        .execute(&mut *conn)
        .await
        .unwrap();
    drop(conn);
    let _writing = writer(&w, "timer-writer").await;
    let (binding, _) = slot(&w, "timer-slot").await;
    let before = fixtures::snapshot(&w.f.store).await;
    assert!(claim(&w, &binding).await.is_none());
    assert_eq!(before, fixtures::snapshot(&w.f.store).await);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_slot_run_cannot_steer_delegate_or_anchor_the_lineage() {
    let w = Window::open().await;
    w.activate().await;
    switch(&w, true).await;
    let _second = join(&w, 1).await;
    let writing = writer(&w, "guard-writer").await;
    let (binding, _) = slot(&w, "guard-slot").await;
    let cap = parallel(&w, &binding).await;
    // Steering: only the canonical lineage.
    assert!(w.bound.authorize_codex_steering(&writing).await.is_ok());
    assert!(matches!(
        w.bound.authorize_codex_steering(&cap).await,
        Err(RuntimeStoreError::Fenced)
    ));
    // Worker delegation: a parallel run is never a Worker parent.
    w.bound
        .append_provider_event(
            &w.f.owner,
            cap.provider(),
            &observation(cap.provider(), 1, ProviderEvent::Started),
        )
        .await
        .unwrap();
    w.bound
        .append_provider_event(
            &w.f.owner,
            writing.provider(),
            &observation(writing.provider(), 1, ProviderEvent::Started),
        )
        .await
        .unwrap();
    let mut conn = w.bound.pool.acquire().await.unwrap();
    assert!(w
        .bound
        .worker_parent_current_in(&mut conn, &writing.provider().run.run_id)
        .await
        .is_ok());
    assert!(matches!(
        w.bound
            .worker_parent_current_in(&mut conn, &cap.provider().run.run_id)
            .await,
        Err(RuntimeStoreError::Fenced)
    ));
    drop(conn);
    // Window close: a slot run is never the successor's prior run.
    for (n, p) in [(2, cap.provider()), (2, writing.provider())] {
        let done = w
            .bound
            .append_provider_event(
                &w.f.owner,
                p,
                &observation(p, n, ProviderEvent::CompletedProposal { synthetic: false }),
            )
            .await
            .unwrap()
            .event_id;
        decide(&w, p, done).await;
    }
    w.bound
        .begin_execution_window_retirement(
            w.credential.credential(),
            w.status.window_id,
            1,
            "role-test-boot",
        )
        .await
        .unwrap();
    let before = fixtures::snapshot(&w.f.store).await;
    assert!(matches!(
        w.bound
            .retire_terminal_supervisor(w.credential.credential(), &cap.provider().run.run_id)
            .await,
        Err(RuntimeStoreError::Fenced)
    ));
    assert_eq!(before, fixtures::snapshot(&w.f.store).await);
    // The canonical close retires the settled slot with the context.
    w.bound
        .retire_terminal_supervisor(w.credential.credential(), &writing.provider().run.run_id)
        .await
        .unwrap();
    assert_eq!(
        scalar(
            &w,
            "SELECT state FROM session_bindings WHERE id=?",
            &binding.session_id.to_string()
        )
        .await,
        "retired"
    );
    w.bound
        .retire_execution_window(
            w.credential.credential(),
            w.status.window_id,
            1,
            "role-test-boot",
            &writing.provider().run.run_id,
        )
        .await
        .unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn stopping_a_slot_holds_nothing_and_the_owner_stop_holds_the_queue() {
    let w = Window::open().await;
    w.activate().await;
    switch(&w, true).await;
    let second = join(&w, 1).await;
    let writing = writer(&w, "stop-writer").await;
    let (binding, _) = slot(&w, "stop-slot").await;
    let cap = parallel(&w, &binding).await;
    assert_eq!(cap.source_event_id(), &second.input_event_id);
    let queued = join(&w, 2).await;
    let held = |w: &Window| {
        let pool = w.f.store.pool.clone();
        async move {
            sqlx::query_scalar::<_, String>(
                "SELECT event_id FROM production_held_inputs ORDER BY scope_sequence",
            )
            .fetch_all(&pool)
            .await
            .unwrap()
        }
    };
    // A slot's own Stop (deadline, shutdown, budget) holds no other input.
    w.bound
        .request_cancel(&w.f.owner, &cap.provider().run.run_id, "slot-deadline")
        .await
        .unwrap();
    assert!(held(&w).await.is_empty());
    assert_eq!(
        count(
            &w.f.store,
            "SELECT count(*) FROM production_stop_boundaries"
        )
        .await,
        0
    );
    // The writer's Stop is unchanged: it holds the queue up to the cut, but
    // never the slot's already-consumed input.
    w.bound
        .request_cancel(&w.f.owner, &writing.provider().run.run_id, "owner-stop")
        .await
        .unwrap();
    let held = held(&w).await;
    assert!(held.contains(&queued.input_event_id.to_string()));
    assert!(!held.contains(&second.input_event_id.to_string()));
    // The writer's status still names its own run.
    assert_eq!(status_run(&w).await, writing.provider().run.run_id);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn switch_turned_off_mid_burst_starts_nothing_new_and_running_slots_finish() {
    let w = Window::open().await;
    w.activate().await;
    switch(&w, true).await;
    let _second = join(&w, 1).await;
    let third = join(&w, 2).await;
    let writing = writer(&w, "toggle-writer").await;
    let (binding, _) = slot(&w, "toggle-slot").await;
    let (spare, _) = slot(&w, "toggle-spare").await;
    let cap = parallel(&w, &binding).await;
    switch(&w, false).await;
    assert!(!w
        .bound
        .parallel_deep_enabled(w.credential.credential())
        .await
        .unwrap());
    // Core rechecks the switch: no new slot and no new claim.
    assert!(matches!(
        w.bound
            .allocate_parallel_deep_slot(w.credential.credential())
            .await,
        Err(RuntimeStoreError::Fenced)
    ));
    assert!(claim(&w, &spare).await.is_none());
    // The running slot still finishes and retires normally.
    accept(&w, cap.provider(), "slot answer").await;
    w.bound
        .retire_parallel_deep_slot(w.credential.credential(), &cap.provider().run.run_id)
        .await
        .unwrap();
    // The writer takes the rest, as with the switch off.
    accept(&w, writing.provider(), "writer").await;
    let next = writer(&w, "toggle-writer-2").await;
    assert_eq!(next.source_event_id(), &third.input_event_id);
}

/// The opener dies with a slot proposal and the writer's turn unresolved.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn crash_abandons_slot_proposals_and_anchors_on_the_writer() {
    let w = Window::open().await;
    w.activate().await;
    switch(&w, true).await;
    let second = join(&w, 1).await;
    let writing = writer(&w, "crash-writer").await;
    let (binding, _) = slot(&w, "crash-slot").await;
    let cap = parallel(&w, &binding).await;
    // An allocated slot that never launched.
    let (unused, _) = w
        .bound
        .allocate_parallel_deep_slot(w.credential.credential())
        .await
        .unwrap();
    let writer_done = propose(&w, writing.provider(), "writer").await;
    // The slot run is later in the window than the writer's: the anchor
    // must still be the writer.
    let slot_done = propose(&w, cap.provider(), "slot").await;
    // Past the hard deadline and the acceptance grace; a fresh process.
    sqlx::query("UPDATE execution_windows SET opened_at_ms=opened_at_ms-?1,work_deadline_ms=work_deadline_ms-?1,expires_at_ms=expires_at_ms-?1 WHERE id=?2")
        .bind(900_001 + crate::production_runtime::execution_window::stranded::ACCEPTANCE_GRACE_MS).bind(w.status.window_id.to_string())
        .execute(&w.f.store.pool).await.unwrap();
    let fresh = Store::open(&w.f.root.join("core.sqlite3")).await.unwrap();
    fresh
        .reconcile_execution_window_authenticated(
            &w.browser_credential,
            &w.f.conversation,
            w.status.window_id,
            1,
        )
        .await
        .unwrap();
    let StrandedExecutionWindow::Pending(plan) = fresh
        .plan_stranded_execution_window_authenticated(
            &w.browser_credential,
            &w.f.conversation,
            w.status.window_id,
            1,
            Decision::AbandonUnaccepted,
            Actor::Startup,
        )
        .await
        .unwrap()
    else {
        panic!("unreconciled window must plan")
    };
    assert_eq!(plan.outcome, Outcome::Abandoned);
    assert_eq!(
        plan.prior_run_id,
        Some(writing.provider().run.run_id.clone())
    );
    assert_eq!(plan.terminal_event_id, Some(writer_done));
    let receipt = fresh
        .reconcile_stranded_execution_window_authenticated(
            &w.browser_credential,
            &plan,
            Decision::AbandonUnaccepted,
            Actor::Startup,
        )
        .await
        .unwrap();
    let mut expected = vec![
        writing.provider().run.run_id.clone(),
        cap.provider().run.run_id.clone(),
    ];
    expected.sort_by_key(|r| r.to_string());
    assert_eq!(receipt.abandoned_run_ids, expected);
    // The defer rule after a crash: the abandoned slot never answered, so its
    // input goes back to the writer's queue (released from the window,
    // recorded once, never taken by a slot again). Delivered only by the
    // writer of a successor window.
    assert!(receipt
        .released_input_event_ids
        .contains(&second.input_event_id));
    assert_eq!(
        scalar(
            &w,
            "SELECT state||':'||coalesce(admitted_run_id,'') FROM reasoning_inbox WHERE event_id=?",
            &second.input_event_id.to_string()
        )
        .await,
        "queued:"
    );
    assert_eq!(
        scalar(
            &w,
            "SELECT run_id FROM production_parallel_deep_deferrals WHERE event_id=?",
            &second.input_event_id.to_string()
        )
        .await,
        cap.provider().run.run_id.to_string()
    );
    assert_eq!(
        scalar(
            &w,
            "SELECT terminal_kind||':'||event_id FROM production_terminal_evidence WHERE run_id=?",
            &cap.provider().run.run_id.to_string()
        )
        .await,
        format!("abandoned:{slot_done}")
    );
    // No slot outlives the reconciled window; the writer's lineage remains.
    for session in [&binding.session_id, &unused.session_id] {
        assert_eq!(
            scalar(
                &w,
                "SELECT state FROM session_bindings WHERE id=?",
                &session.to_string()
            )
            .await,
            "retired"
        );
    }
    assert_eq!(
        count(
            &fresh,
            "SELECT count(*) FROM session_bindings WHERE role='deep' AND state!='retired'"
        )
        .await,
        1
    );
    fresh.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn schema_keeps_one_canonical_deep_and_bounded_slots() {
    let w = Window::open().await;
    let insert = |slot: i64, role: &'static str| {
        let pool = w.f.store.pool.clone();
        let owner = w.f.owner.to_string();
        let conversation = w.f.conversation.to_string();
        async move {
            sqlx::query("INSERT INTO session_bindings(id,owner_id,conversation_id,role,deep_slot) VALUES(?,?,?,?,?)")
                .bind(uuid::Uuid::new_v4().to_string()).bind(owner).bind(conversation).bind(role).bind(slot)
                .execute(&pool).await
        }
    };
    assert!(insert(0, "deep").await.is_err(), "one canonical Deep");
    assert!(insert(1, "fast").await.is_err(), "Deep slots are Deep only");
    assert!(insert(4, "deep").await.is_err());
    assert!(insert(-1, "deep").await.is_err());
    for slot in 1..=3 {
        assert!(insert(slot, "deep").await.is_ok());
    }
    assert!(insert(3, "deep").await.is_err());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn grouping_skips_slot_claims_and_a_slot_never_groups() {
    let w = Window::open().await;
    w.activate().await;
    switch(&w, true).await;
    // Owner chat inputs (grouping takes only verified owner input).
    let mut burst = Vec::new();
    for n in 1..=4 {
        let request = join(&w, n).await;
        sqlx::query("INSERT INTO message_authors(message_id,author) VALUES(?,'owner')")
            .bind(request.input_message_id.to_string())
            .execute(&w.f.store.pool)
            .await
            .unwrap();
        burst.push(request);
    }
    let writing = writer(&w, "group-writer").await;
    w.bound
        .append_provider_event(
            &w.f.owner,
            writing.provider(),
            &observation(writing.provider(), 1, ProviderEvent::Started),
        )
        .await
        .unwrap();
    // A slot admits the first queued input alone: the rest stays queued.
    let (first, _) = slot(&w, "group-slot-1").await;
    let alone = parallel(&w, &first).await;
    assert_eq!(alone.source_event_id(), &burst[0].input_event_id);
    for request in &burst[1..] {
        assert_eq!(
            scalar(
                &w,
                "SELECT state FROM reasoning_inbox WHERE event_id=?",
                &request.input_event_id.to_string()
            )
            .await,
            "queued"
        );
    }
    // A second slot holds a claim on the next one (not yet admitted).
    let (second, _) = slot(&w, "group-slot-2").await;
    let held = claim(&w, &second).await.unwrap();
    assert_eq!(held.event_id, burst[1].input_event_id);
    // The writer finishes; its next turn groups the rest of the burst past
    // the slot's claim, never taking it.
    let done = w
        .bound
        .append_provider_event(
            &w.f.owner,
            writing.provider(),
            &observation(
                writing.provider(),
                2,
                ProviderEvent::CompletedProposal { synthetic: false },
            ),
        )
        .await
        .unwrap()
        .event_id;
    decide(&w, writing.provider(), done).await;
    let grouped = writer(&w, "group-writer-2").await;
    assert_eq!(grouped.source_event_id(), &burst[2].input_event_id);
    assert_eq!(
        scalar(
            &w,
            "SELECT state||':'||admitted_run_id FROM reasoning_inbox WHERE event_id=?",
            &burst[3].input_event_id.to_string()
        )
        .await,
        format!("consumed:{}", grouped.provider().run.run_id)
    );
    assert_eq!(
        scalar(
            &w,
            "SELECT state FROM reasoning_inbox WHERE event_id=?",
            &burst[1].input_event_id.to_string()
        )
        .await,
        "claimed"
    );
    // The slot's claim still admits exactly its own input.
    let admitted = w
        .bound
        .admit_run(&held, &second.session_id, second.generation, "group-slot-2")
        .await
        .unwrap();
    assert_eq!(admitted.disposition, AdmissionDisposition::FreshCandidate);
    let dup: i64 = count(&w.f.store, "SELECT count(*) FROM (SELECT admitted_run_id FROM reasoning_inbox GROUP BY event_id HAVING count(*)>1)").await;
    assert_eq!(dup, 0);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_slot_turn_is_noted_read_only_with_a_digest_and_a_deep_model() {
    let w = Window::open().await;
    w.activate().await;
    switch(&w, true).await;
    let question = join(&w, 1).await;
    let writing = writer(&w, "note-writer").await;
    // The writer's own first turn is unchanged by the switch.
    assert!(!writing.text().contains("Parallel"));
    let (binding, _) = slot(&w, "note-slot").await;
    let cap = parallel(&w, &binding).await;
    assert_eq!(cap.source_event_id(), &question.input_event_id);
    let text = cap.text();
    assert!(text.contains(crate::production_runtime::parallel_deep_turns::SLOT_NOTE.trim()));
    assert!(text.ends_with("PARALLEL_QUESTION_1"), "{text}");
    // A fresh native: the bounded history digest comes first.
    assert!(text.starts_with("Historical conversation digest"), "{text}");
    // A slot runs on the read-only Fast profile: it always names a Deep model.
    assert_eq!(
        cap.launch().unwrap().codex_overrides(),
        Some((
            Some(crate::production_runtime::PARALLEL_DEEP_DEFAULT_MODEL),
            Some(crate::production_runtime::PARALLEL_DEEP_DEFAULT_EFFORT)
        ))
    );
    assert_eq!(
        writing.launch().unwrap().codex_overrides(),
        Some((None, None))
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_writer_is_told_each_parallel_answer_once() {
    let w = Window::open().await;
    w.activate().await;
    switch(&w, true).await;
    let _question = join(&w, 1).await;
    let writing = writer(&w, "told-writer").await;
    let (binding, _) = slot(&w, "told-slot").await;
    let cap = parallel(&w, &binding).await;
    accept(&w, cap.provider(), "PARALLEL_ANSWER_TEXT").await;
    accept(&w, writing.provider(), "writer").await;
    let next_input = join(&w, 2).await;
    let next = writer(&w, "told-writer-2").await;
    assert_eq!(next.source_event_id(), &next_input.input_event_id);
    assert!(next
        .text()
        .contains("Parallel answers since your previous turn"));
    assert!(next.text().contains("PARALLEL_ANSWER_TEXT"));
    assert!(next.text().contains("PARALLEL_QUESTION_1"));
    assert!(next.text().ends_with("PARALLEL_QUESTION_2"));
    accept(&w, next.provider(), "writer 2").await;
    let _third = join(&w, 3).await;
    let later = writer(&w, "told-writer-3").await;
    assert!(!later.text().contains("PARALLEL_ANSWER_TEXT"), "noted once");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_deferred_input_goes_to_the_writer_exactly_once() {
    let w = Window::open().await;
    w.activate().await;
    switch(&w, true).await;
    let action = join(&w, 1).await;
    let writing = writer(&w, "defer-writer").await;
    let (binding, _) = slot(&w, "defer-slot").await;
    let cap = parallel(&w, &binding).await;
    let run = cap.provider().run.run_id.clone();
    // Before acceptance nothing defers.
    assert!(w
        .bound
        .defer_parallel_deep_input(w.credential.credential(), &run)
        .await
        .is_err());
    accept(&w, cap.provider(), "  PARALLEL_DEFER\n").await;
    assert!(w
        .bound
        .defer_parallel_deep_input(w.credential.credential(), &run)
        .await
        .unwrap());
    // Idempotent.
    assert!(w
        .bound
        .defer_parallel_deep_input(w.credential.credential(), &run)
        .await
        .unwrap());
    assert!(
        w.f.store
            .deep_run_parallel_authenticated(
                &w.browser_credential,
                &w.f.owner,
                &w.f.conversation,
                &run
            )
            .await
            .unwrap()
            .2,
        "the exact-run status reports the input handed back"
    );
    assert_eq!(
        scalar(
            &w,
            "SELECT state FROM reasoning_inbox WHERE event_id=?",
            &action.input_event_id.to_string()
        )
        .await,
        "queued"
    );
    // Another slot never takes it again.
    let (other, _) = slot(&w, "defer-other").await;
    assert!(claim(&w, &other).await.is_none());
    // The writer takes it, and its note does not repeat the marker.
    accept(&w, writing.provider(), "writer").await;
    let next = writer(&w, "defer-writer-2").await;
    assert_eq!(next.source_event_id(), &action.input_event_id);
    assert!(!next.text().contains("PARALLEL_DEFER"));
    // An ordinary answer never defers.
    let w2 = Window::open().await;
    w2.activate().await;
    switch(&w2, true).await;
    let _q = join(&w2, 1).await;
    let _writing = writer(&w2, "nodefer-writer").await;
    let (binding, _) = slot(&w2, "nodefer-slot").await;
    let cap = parallel(&w2, &binding).await;
    accept(
        &w2,
        cap.provider(),
        "PARALLEL_DEFER is mentioned, but this is an answer",
    )
    .await;
    assert!(!w2
        .bound
        .defer_parallel_deep_input(w2.credential.credential(), &cap.provider().run.run_id)
        .await
        .unwrap());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn burst_marker_and_review_gate() {
    let w = Window::open().await;
    w.activate().await;
    switch(&w, true).await;
    let _q = join(&w, 1).await;
    let writing = writer(&w, "marker-writer").await;
    let marker = |run: RunId| {
        let w = &w;
        async move {
            w.f.store
                .deep_run_parallel_authenticated(
                    &w.browser_credential,
                    &w.f.owner,
                    &w.f.conversation,
                    &run,
                )
                .await
                .unwrap()
        }
    };
    // A lone writer turn carries no marker.
    assert_eq!(
        marker(writing.provider().run.run_id.clone()).await,
        (false, false, false)
    );
    assert!(w
        .bound
        .parallel_deep_candidate(w.credential.credential())
        .await
        .unwrap());
    let (binding, _) = slot(&w, "marker-slot").await;
    let cap = parallel(&w, &binding).await;
    assert!(!w
        .bound
        .parallel_deep_candidate(w.credential.credential())
        .await
        .unwrap());
    assert_eq!(
        marker(cap.provider().run.run_id.clone()).await,
        (true, true, false)
    );
    assert_eq!(
        marker(writing.provider().run.run_id.clone()).await,
        (false, true, false)
    );
    assert!(w
        .f
        .store
        .deep_run_parallel_authenticated(
            &"f".repeat(64),
            &w.f.owner,
            &w.f.conversation,
            &writing.provider().run.run_id
        )
        .await
        .is_err());
    // Review before accepting: parallel answers are server-accepted, so no
    // slot starts while the owner reviews each reply.
    let current =
        w.f.store
            .conversation_settings(&w.browser_credential, &w.f.owner, &w.f.conversation)
            .await
            .unwrap();
    w.f.store
        .update_conversation_settings(
            &w.browser_credential,
            &w.f.owner,
            &w.f.conversation,
            &ConversationSettingsUpdate {
                expected_revision: current.revision,
                provider: ConversationProvider::Codex,
                model: None,
                reasoning_effort: None,
                honor_no_reply: true,
                reply_prefix: None,
                reply_footer: None,
                review_before_accepting: true,
                parallel_deep: None,
                deep_grouping: None,
            },
        )
        .await
        .unwrap();
    assert!(!w
        .bound
        .parallel_deep_enabled(w.credential.credential())
        .await
        .unwrap());
    assert!(matches!(
        w.bound
            .allocate_parallel_deep_slot(w.credential.credential())
            .await,
        Err(RuntimeStoreError::Fenced)
    ));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_failed_slot_turn_returns_its_input_to_the_writer() {
    let w = Window::open().await;
    w.activate().await;
    switch(&w, true).await;
    let question = join(&w, 1).await;
    let writing = writer(&w, "failed-writer").await;
    let (binding, _) = slot(&w, "failed-slot").await;
    let cap = parallel(&w, &binding).await;
    let p = cap.provider();
    w.bound
        .append_provider_event(&w.f.owner, p, &observation(p, 1, ProviderEvent::Started))
        .await
        .unwrap();
    w.bound
        .append_provider_event(
            &w.f.owner,
            p,
            &observation(
                p,
                2,
                ProviderEvent::FailedWith(orkestr_v2_contracts::ExecutionFailureClass::Quota),
            ),
        )
        .await
        .unwrap();
    assert!(w
        .bound
        .defer_parallel_deep_input(w.credential.credential(), &p.run.run_id)
        .await
        .unwrap());
    assert_eq!(
        scalar(
            &w,
            "SELECT state FROM reasoning_inbox WHERE event_id=?",
            &question.input_event_id.to_string()
        )
        .await,
        "queued"
    );
    accept(&w, writing.provider(), "writer").await;
    let next = writer(&w, "failed-writer-2").await;
    assert_eq!(next.source_event_id(), &question.input_event_id);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn writer_notes_never_starve_on_empty_or_oversized_answers() {
    let w = Window::open().await;
    w.activate().await;
    switch(&w, true).await;
    for n in 1..=8 {
        join(&w, n).await;
    }
    let writing = writer(&w, "starve-writer").await;
    // Eight slot answers (three at a time): two empty-of-text defers first,
    // then one far larger than the note bound once escaped, then ordinary.
    let texts = [
        "PARALLEL_DEFER".to_owned(),
        "PARALLEL_DEFER".to_owned(),
        "\u{0001}".repeat(4_000),
        "ANSWER_FOUR".into(),
        "ANSWER_FIVE".into(),
        "ANSWER_SIX".into(),
        "ANSWER_SEVEN".into(),
        "ANSWER_EIGHT".into(),
    ];
    let mut done = Vec::new();
    for chunk in texts.chunks(3) {
        let mut caps = Vec::new();
        for (n, _) in chunk.iter().enumerate() {
            let (binding, _) = slot(&w, &format!("starve-{}-{n}", done.len())).await;
            caps.push(parallel(&w, &binding).await);
        }
        for (cap, text) in caps.iter().zip(chunk) {
            accept(&w, cap.provider(), text).await;
            w.bound
                .retire_parallel_deep_slot(w.credential.credential(), &cap.provider().run.run_id)
                .await
                .unwrap();
            done.push(cap.provider().run.run_id.clone());
        }
    }
    accept(&w, writing.provider(), "writer").await;
    let nine = join(&w, 9).await;
    let next = writer(&w, "starve-writer-2").await;
    assert_eq!(next.source_event_id(), &nine.input_event_id);
    // The oversized answer is carried shortened, and every later answer is
    // carried by this turn or the next: none is held back forever.
    assert!(next
        .text()
        .contains("Parallel answers since your previous turn"));
    let noted: i64 = count(
        &w.f.store,
        "SELECT count(*) FROM production_parallel_deep_notes",
    )
    .await;
    assert!(
        noted >= 3,
        "the empty and oversized answers do not block the selection"
    );
    accept(&w, next.provider(), "writer 2").await;
    join(&w, 10).await;
    let later = writer(&w, "starve-writer-3").await;
    accept(&w, later.provider(), "writer 3").await;
    join(&w, 11).await;
    let _last = writer(&w, "starve-writer-4").await;
    let noted: i64 = count(
        &w.f.store,
        "SELECT count(*) FROM production_parallel_deep_notes",
    )
    .await;
    assert_eq!(noted, 8, "every parallel answer is eventually noted once");
}

async fn review(w: &Window, on: bool) {
    let current =
        w.f.store
            .conversation_settings(&w.browser_credential, &w.f.owner, &w.f.conversation)
            .await
            .unwrap();
    w.f.store
        .update_conversation_settings(
            &w.browser_credential,
            &w.f.owner,
            &w.f.conversation,
            &ConversationSettingsUpdate {
                expected_revision: current.revision,
                provider: ConversationProvider::Codex,
                model: None,
                reasoning_effort: None,
                honor_no_reply: true,
                reply_prefix: None,
                reply_footer: None,
                review_before_accepting: on,
                parallel_deep: None,
                deep_grouping: None,
            },
        )
        .await
        .unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn review_switched_on_mid_slot_withdraws_the_proposal_at_close_and_the_writer_answers() {
    let w = Window::open().await;
    w.activate().await;
    switch(&w, true).await;
    let question = join(&w, 1).await;
    let writing = writer(&w, "withdraw-writer").await;
    let (binding, _) = slot(&w, "withdraw-slot").await;
    let cap = parallel(&w, &binding).await;
    let run = cap.provider().run.run_id.clone();
    // The owner turns review on mid-turn: no server acceptance happens.
    review(&w, true).await;
    let done = propose(&w, cap.provider(), "slot answer awaiting review").await;
    assert!(w
        .bound
        .auto_accept_window_proposals(&w.f.conversation)
        .await
        .unwrap()
        .is_empty());
    // A running turn, or a run of another kind, is never withdrawn.
    assert!(w
        .bound
        .withdraw_parallel_deep_proposal(w.credential.credential(), &writing.provider().run.run_id)
        .await
        .is_err());
    // The writer's turn ends; the window closes.
    accept(&w, writing.provider(), "writer").await;
    w.bound
        .begin_execution_window_retirement(
            w.credential.credential(),
            w.status.window_id,
            1,
            "role-test-boot",
        )
        .await
        .unwrap();
    // The drain deadline withdraws it in the live process.
    w.bound
        .withdraw_parallel_deep_proposal(w.credential.credential(), &run)
        .await
        .unwrap();
    assert!(w
        .bound
        .withdraw_parallel_deep_proposal(w.credential.credential(), &run)
        .await
        .is_err());
    assert_eq!(
        scalar(
            &w,
            "SELECT terminal_kind||':'||event_id FROM production_terminal_evidence WHERE run_id=?",
            &run.to_string()
        )
        .await,
        format!("abandoned:{done}")
    );
    // Never accepted afterwards.
    let revision: i64 =
        sqlx::query_scalar("SELECT revision FROM execution_revisions WHERE conversation_id=?")
            .bind(w.f.conversation.to_string())
            .fetch_one(&w.f.store.pool)
            .await
            .unwrap();
    assert!(w
        .f
        .store
        .accept_execution_authenticated(
            &w.browser_credential,
            &w.f.conversation,
            &ExecutionAcceptanceRequest {
                run_id: run.clone(),
                completion_event_id: done,
                expected_revision: revision,
                request_key: "late-accept".into(),
            },
        )
        .await
        .is_err());
    // The input is back with the writer, recorded once.
    assert_eq!(
        scalar(
            &w,
            "SELECT state FROM reasoning_inbox WHERE event_id=?",
            &question.input_event_id.to_string()
        )
        .await,
        "queued"
    );
    assert!(
        w.f.store
            .deep_run_parallel_authenticated(
                &w.browser_credential,
                &w.f.owner,
                &w.f.conversation,
                &run
            )
            .await
            .unwrap()
            .2
    );
    assert!(w
        .bound
        .defer_parallel_deep_input(w.credential.credential(), &run)
        .await
        .unwrap());
    // The used slot retires and the window closes now, not after the hard
    // deadline plus the acceptance grace.
    w.bound
        .retire_parallel_deep_slot(w.credential.credential(), &run)
        .await
        .unwrap();
    w.bound
        .retire_terminal_supervisor(w.credential.credential(), &writing.provider().run.run_id)
        .await
        .unwrap();
    w.bound
        .retire_execution_window(
            w.credential.credential(),
            w.status.window_id,
            1,
            "role-test-boot",
            &writing.provider().run.run_id,
        )
        .await
        .unwrap();
    assert_eq!(
        scalar(
            &w,
            "SELECT state FROM execution_windows WHERE id=?",
            &w.status.window_id.to_string()
        )
        .await,
        "closed"
    );
}
