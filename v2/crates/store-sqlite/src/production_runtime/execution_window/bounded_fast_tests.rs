//! Real Store transactions; native IDs and child-cleanup boundary are synthetic.
use super::*;
use orkestr_v2_application::IntakeStore;
use orkestr_v2_contracts::{ExecutionAcceptanceRequest, MessageInput};

async fn fresh(w: &Window, binding: &Binding, name: &str) -> Binding {
    let grant = w
        .bound
        .authorize_bounded_fast_metadata(w.credential.credential(), binding)
        .await
        .unwrap();
    assert_eq!(grant.binding().role, Role::Fast);
    assert_eq!(grant.binding().native_session_id, None);
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

async fn present(
    w: &Window,
    binding: &Binding,
    request: &ExecutionWindowRequest,
) -> ConsumedProviderDispatch {
    let admission = w
        .bound
        .admit_fast(
            w.credential.credential(),
            &FastAdmissionInput {
                source_message_id: request.input_message_id.clone(),
                source_event_id: request.input_event_id.clone(),
                fast_binding_id: binding.session_id.clone(),
                expected_binding_generation: binding.generation,
                request_key: format!("fast-http:{}", request.input_event_id),
            },
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

async fn accept(w: &Window, p: &ProviderAdmission, completion: EventId) {
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
                completion_event_id: completion,
                expected_revision: revision,
                request_key: format!("accept:{}", p.run.run_id),
            },
        )
        .await
        .unwrap();
}

async fn ready(w: &Window) -> Binding {
    w.bound
        .ensure_role_bindings(&w.f.owner, &w.f.conversation)
        .await
        .unwrap()
        .fast
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn accepted_fast_rotates_once_without_changing_deep_input_order_or_dispatch_identity() {
    let w = Window::open().await;
    let first = fresh(&w, &w.roles.fast, "bounded-first").await;
    w.activate().await;
    let cap = present(&w, &first, &w.source).await;
    let before = fixtures::snapshot(&w.f.store).await;
    assert!(w
        .bound
        .authorize_bounded_fast_metadata(w.credential.credential(), &ready(&w).await)
        .await
        .is_err());
    assert_eq!(before, fixtures::snapshot(&w.f.store).await);
    let completion = propose(&w, cap.provider(), "accepted historical answer").await;
    let before = fixtures::snapshot(&w.f.store).await;
    assert!(w
        .bound
        .authorize_bounded_fast_metadata(w.credential.credential(), &ready(&w).await)
        .await
        .is_err());
    assert_eq!(before, fixtures::snapshot(&w.f.store).await);
    accept(&w, cap.provider(), completion).await;
    let released = ready(&w).await;
    let mut next = input(&w.f, "bounded-current").await;
    next.expected_generation = 1;
    next.window_id = Some(w.status.window_id);
    w.f.store
        .admit_execution_window_authenticated(&w.browser_credential, &w.f.conversation, &next)
        .await
        .unwrap();
    // Same-window reuse is allowed, but the scheduler may still rotate; the
    // read-only eligibility query never changes state.
    let before = fixtures::snapshot(&w.f.store).await;
    assert!(w
        .bound
        .bounded_fast_reusable(w.credential.credential(), &released, &next.input_event_id)
        .await
        .unwrap());
    assert_eq!(before, fixtures::snapshot(&w.f.store).await);
    let deep = w
        .bound
        .ensure_role_bindings(&w.f.owner, &w.f.conversation)
        .await
        .unwrap()
        .deep;
    let inbox: Vec<(String, String, i64)> = sqlx::query_as(
        "SELECT event_id,state,claim_generation FROM reasoning_inbox ORDER BY sequence",
    )
    .fetch_all(&w.f.store.pool)
    .await
    .unwrap();
    let second = fresh(&w, &released, "bounded-second").await;
    assert_ne!(second.session_id, first.session_id);
    assert_ne!(second.native_session_id, first.native_session_id);
    let old: (String, String) =
        sqlx::query_as("SELECT state,native_session_id FROM session_bindings WHERE id=?")
            .bind(first.session_id.to_string())
            .fetch_one(&w.f.store.pool)
            .await
            .unwrap();
    assert_eq!(old, ("retired".into(), "bounded-first".into()));
    assert_eq!(
        deep,
        w.bound
            .ensure_role_bindings(&w.f.owner, &w.f.conversation)
            .await
            .unwrap()
            .deep
    );
    let after: Vec<(String, String, i64)> = sqlx::query_as(
        "SELECT event_id,state,claim_generation FROM reasoning_inbox ORDER BY sequence",
    )
    .fetch_all(&w.f.store.pool)
    .await
    .unwrap();
    assert_eq!(inbox, after);
    let before = fixtures::snapshot(&w.f.store).await;
    assert!(w
        .bound
        .authorize_bounded_fast_metadata(w.credential.credential(), &released)
        .await
        .is_err());
    assert!(w
        .bound
        .admit_fast(
            w.credential.credential(),
            &FastAdmissionInput {
                source_message_id: w.source.input_message_id.clone(),
                source_event_id: w.source.input_event_id.clone(),
                fast_binding_id: second.session_id.clone(),
                expected_binding_generation: second.generation,
                request_key: format!("fast-http:{}", w.source.input_event_id),
            }
        )
        .await
        .is_err());
    assert_eq!(before, fixtures::snapshot(&w.f.store).await);
    let next_cap = present(&w, &second, &next).await;
    assert_eq!(next_cap.source_event_id(), &next.input_event_id);
    assert_eq!(next_cap.message_id(), &next.input_message_id);
    assert!(next_cap.text().contains("accepted historical answer"));
    assert!(next_cap
        .text()
        .ends_with("Exact current input:\nsynthetic window input"));
    let digest: (String, String, i64) = sqlx::query_as("SELECT source_event_id,digest_text,cutoff_sequence FROM production_fast_digests WHERE run_id=?")
        .bind(next_cap.provider().run.run_id.to_string()).fetch_one(&w.f.store.pool).await.unwrap();
    assert_eq!(digest.0, next.input_event_id.to_string());
    assert!(digest.1.len() <= 8192);
    assert!(digest.1.contains("accepted historical answer"));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn same_window_fast_reuses_the_accepted_child_without_digest_until_the_cap() {
    let w = Window::open().await;
    let first = fresh(&w, &w.roles.fast, "warm-native").await;
    w.activate().await;
    let cap = present(&w, &first, &w.source).await;
    let done = propose(&w, cap.provider(), "warm first answer").await;
    accept(&w, cap.provider(), done).await;
    let digests = |run: String| {
        let pool = w.f.store.pool.clone();
        async move {
            sqlx::query_scalar::<_, i64>(
                "SELECT count(*) FROM production_fast_digests WHERE run_id=?",
            )
            .bind(run)
            .fetch_one(&pool)
            .await
            .unwrap()
        }
    };
    assert_eq!(digests(cap.provider().run.run_id.to_string()).await, 1);
    let join = |key: String| {
        let w = &w;
        async move {
            let mut next = input(&w.f, &key).await;
            next.expected_generation = 1;
            next.window_id = Some(w.status.window_id);
            w.f.store
                .admit_execution_window_authenticated(
                    &w.browser_credential,
                    &w.f.conversation,
                    &next,
                )
                .await
                .unwrap();
            next
        }
    };
    for turn in 2..=super::super::fast_continuity::MAX_WINDOW_FAST_TURNS {
        let released = ready(&w).await;
        assert_eq!(released.session_id, first.session_id);
        let next = join(format!("warm-{turn}")).await;
        // Another conversation's binding identity is never eligible here.
        let foreign = Binding {
            conversation_id: ConversationId(uuid::Uuid::new_v4()),
            ..released.clone()
        };
        assert!(!w
            .bound
            .bounded_fast_reusable(w.credential.credential(), &foreign, &next.input_event_id)
            .await
            .unwrap());
        assert!(!w
            .bound
            .bounded_fast_reusable(
                w.credential.credential(),
                &w.roles.deep,
                &next.input_event_id
            )
            .await
            .unwrap());
        assert!(w
            .bound
            .bounded_fast_reusable(w.credential.credential(), &released, &next.input_event_id)
            .await
            .unwrap());
        let cap = present(&w, &released, &next).await;
        assert_eq!(cap.provider().run.session_id, first.session_id);
        assert_eq!(
            cap.provider().run.native_session_id,
            first.native_session_id
        );
        // The warm native child already holds this window's turns.
        assert_eq!(cap.text(), "synthetic window input");
        assert_eq!(digests(cap.provider().run.run_id.to_string()).await, 0);
        let done = propose(&w, cap.provider(), "warm later answer").await;
        accept(&w, cap.provider(), done).await;
    }
    // The cap forces a fresh bounded presentation with the digest again.
    let released = ready(&w).await;
    let next = join("warm-capped".into()).await;
    let before = fixtures::snapshot(&w.f.store).await;
    assert!(!w
        .bound
        .bounded_fast_reusable(w.credential.credential(), &released, &next.input_event_id)
        .await
        .unwrap());
    assert!(w
        .bound
        .admit_fast(
            w.credential.credential(),
            &FastAdmissionInput {
                source_message_id: next.input_message_id.clone(),
                source_event_id: next.input_event_id.clone(),
                fast_binding_id: released.session_id.clone(),
                expected_binding_generation: released.generation,
                request_key: format!("fast-http:{}", next.input_event_id),
            }
        )
        .await
        .is_err());
    assert_eq!(before, fixtures::snapshot(&w.f.store).await);
    let rotated = fresh(&w, &released, "warm-rotated").await;
    assert_ne!(rotated.session_id, first.session_id);
    let cap = present(&w, &rotated, &next).await;
    assert!(cap.text().contains("warm later answer"));
    assert_eq!(digests(cap.provider().run.run_id.to_string()).await, 1);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn digest_cutoff_excludes_later_inputs_and_unaccepted_proposals() {
    let w = Window::open().await;
    let fast = fresh(&w, &w.roles.fast, "digest-cutoff").await;
    w.activate().await;
    // These commits occur after the current source, even though dispatch is later.
    w.f.store
        .admit(
            &w.f.owner,
            &w.f.conversation,
            &MessageInput {
                client_message_id: "future-input".into(),
                text: "FUTURE_INPUT_MUST_NOT_APPEAR".into(),
            },
        )
        .await
        .unwrap();
    let deep_claim = w
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
            &deep_claim,
            &w.roles.deep.session_id,
            w.roles.deep.generation,
            "unaccepted-deep",
        )
        .await
        .unwrap();
    let deep = w.consume(&deep).await;
    propose(&w, deep.provider(), "UNACCEPTED_PROPOSAL_MUST_NOT_APPEAR").await;
    let cap = present(&w, &fast, &w.source).await;
    assert!(!cap.text().contains("FUTURE_INPUT_MUST_NOT_APPEAR"));
    assert!(!cap.text().contains("UNACCEPTED_PROPOSAL_MUST_NOT_APPEAR"));
    assert_eq!(cap.source_event_id(), &w.source.input_event_id);
    assert!(cap.text().ends_with("synthetic window input"));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn foreign_role_namespace_revocation_and_uncertain_setup_are_fenced() {
    let w = Window::open().await;
    let fast = fresh(&w, &w.roles.fast, "bounded-fenced").await;
    w.activate().await;
    let cap = present(&w, &fast, &w.source).await;
    let done = propose(&w, cap.provider(), "historical proposal").await;
    accept(&w, cap.provider(), done).await;
    let released = ready(&w).await;
    let before = fixtures::snapshot(&w.f.store).await;
    assert!(w
        .bound
        .authorize_bounded_fast_metadata(w.credential.credential(), &w.roles.deep)
        .await
        .is_err());
    assert!(w
        .bound
        .authorize_bounded_fast_metadata(&"f".repeat(64), &released)
        .await
        .is_err());
    assert_eq!(before, fixtures::snapshot(&w.f.store).await);
    // A reserved native resume cannot be silently replaced by this seam.
    let _uncertain = w
        .bound
        .authorize_accepted_session_metadata(
            w.credential.credential(),
            &cap.provider().run.run_id,
            &released,
        )
        .await
        .unwrap();
    let before = fixtures::snapshot(&w.f.store).await;
    assert!(w
        .bound
        .authorize_bounded_fast_metadata(w.credential.credential(), &released)
        .await
        .is_err());
    assert_eq!(before, fixtures::snapshot(&w.f.store).await);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn stop_holds_a_fast_accepted_source_still_queued_for_deep_and_excludes_its_answer() {
    async fn join(w: &Window, key: &str, text: &str) -> ExecutionWindowRequest {
        let receipt =
            w.f.store
                .admit(
                    &w.f.owner,
                    &w.f.conversation,
                    &MessageInput {
                        client_message_id: key.into(),
                        text: text.into(),
                    },
                )
                .await
                .unwrap()
                .receipt;
        let request = ExecutionWindowRequest {
            request_key: format!("window:{key}"),
            input_message_id: receipt.message_id,
            input_event_id: receipt.event_id,
            input_request_key: key.into(),
            expected_generation: 1,
            window_id: Some(w.status.window_id),
            predecessor_window_id: None,
        };
        w.f.store
            .admit_execution_window_authenticated(
                &w.browser_credential,
                &w.f.conversation,
                &request,
            )
            .await
            .unwrap();
        request
    }
    let w = Window::open().await;
    let first = fresh(&w, &w.roles.fast, "hold-first").await;
    w.activate().await;
    let cap = present(&w, &first, &w.source).await;
    let done = propose(&w, cap.provider(), "prior unheld answer").await;
    accept(&w, cap.provider(), done).await;
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
            "hold-parent",
        )
        .await
        .unwrap();
    let deep = w.consume(&deep).await;
    w.bound
        .append_provider_event(
            &w.f.owner,
            deep.provider(),
            &observation(deep.provider(), 1, ProviderEvent::Started),
        )
        .await
        .unwrap();
    let held = join(&w, "later-held", "HELD_OWNER_SOURCE").await;
    let second = fresh(&w, &ready(&w).await, "hold-second").await;
    let cap = present(&w, &second, &held).await;
    let done = propose(&w, cap.provider(), "HELD_ACCEPTED_ANSWER").await;
    accept(&w, cap.provider(), done).await;
    w.bound
        .request_cancel(
            &w.f.owner,
            &deep.provider().run.run_id,
            "hold-before-next-fast",
        )
        .await
        .unwrap();
    let holds: i64 =
        sqlx::query_scalar("SELECT count(*) FROM ordinary_input_holds WHERE event_id=?")
            .bind(held.input_event_id.to_string())
            .fetch_one(&w.f.store.pool)
            .await
            .unwrap();
    assert_eq!(
        holds, 1,
        "supported Deep Stop holds the queued owner source despite Fast acceptance"
    );
    let current = join(&w, "after-hold", "NEW_CURRENT_INPUT").await;
    let third = fresh(&w, &ready(&w).await, "hold-third").await;
    let cap = present(&w, &third, &current).await;
    assert!(!cap.text().contains("HELD_OWNER_SOURCE"));
    assert!(!cap.text().contains("HELD_ACCEPTED_ANSWER"));
    assert!(cap.text().contains("prior unheld answer"));
    assert!(cap.text().ends_with("NEW_CURRENT_INPUT"));
}

async fn join_window(w: &Window, key: &str, text: &str) -> ExecutionWindowRequest {
    let receipt =
        w.f.store
            .admit(
                &w.f.owner,
                &w.f.conversation,
                &MessageInput {
                    client_message_id: key.into(),
                    text: text.into(),
                },
            )
            .await
            .unwrap()
            .receipt;
    let request = ExecutionWindowRequest {
        request_key: format!("window:{key}"),
        input_message_id: receipt.message_id,
        input_event_id: receipt.event_id,
        input_request_key: key.into(),
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

async fn deep_run(w: &Window, key: &str) -> ConsumedProviderDispatch {
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
            key,
        )
        .await
        .unwrap();
    w.consume(&deep).await
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn warm_fast_receives_only_the_deep_answers_accepted_since_its_previous_turn() {
    let w = Window::open().await;
    let first = fresh(&w, &w.roles.fast, "warm-update").await;
    w.activate().await;
    let cap = present(&w, &first, &w.source).await;
    let done = propose(&w, cap.provider(), "WARM_OWN_ANSWER").await;
    accept(&w, cap.provider(), done).await;
    let deep = deep_run(&w, "warm-update-deep").await;
    let done = propose(&w, deep.provider(), "DEEP_ANSWER_SINCE").await;
    accept(&w, deep.provider(), done).await;
    let next = join_window(&w, "warm-update-next", "SECOND_OWNER_INPUT").await;
    let released = ready(&w).await;
    assert!(w
        .bound
        .bounded_fast_reusable(w.credential.credential(), &released, &next.input_event_id)
        .await
        .unwrap());
    let cap = present(&w, &released, &next).await;
    assert_eq!(
        cap.provider().run.native_session_id,
        first.native_session_id
    );
    // The warm child already holds its own turns; it gets only Deep's answer.
    assert!(cap
        .text()
        .starts_with("Conversation update since your previous turn"));
    assert!(cap.text().contains("DEEP_ANSWER_SINCE"));
    assert!(!cap.text().contains("WARM_OWN_ANSWER"));
    assert!(!cap.text().contains("synthetic window input"));
    assert!(cap
        .text()
        .ends_with("Exact current input:\nSECOND_OWNER_INPUT"));
    let done = propose(&w, cap.provider(), "WARM_SECOND_ANSWER").await;
    accept(&w, cap.provider(), done).await;
    // Nothing new since: the next warm turn is the exact input, no digest row.
    let third = join_window(&w, "warm-update-third", "THIRD_OWNER_INPUT").await;
    let cap = present(&w, &ready(&w).await, &third).await;
    assert_eq!(cap.text(), "THIRD_OWNER_INPUT");
    let rows: i64 =
        sqlx::query_scalar("SELECT count(*) FROM production_fast_digests WHERE run_id=?")
            .bind(cap.provider().run.run_id.to_string())
            .fetch_one(&w.f.store.pool)
            .await
            .unwrap();
    assert_eq!(rows, 0);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_source_held_by_stop_never_stays_in_a_warm_fast_session() {
    let w = Window::open().await;
    let first = fresh(&w, &w.roles.fast, "warm-hold").await;
    w.activate().await;
    let cap = present(&w, &first, &w.source).await;
    let done = propose(&w, cap.provider(), "prior unheld answer").await;
    accept(&w, cap.provider(), done).await;
    let deep = deep_run(&w, "warm-hold-parent").await;
    w.bound
        .append_provider_event(
            &w.f.owner,
            deep.provider(),
            &observation(deep.provider(), 1, ProviderEvent::Started),
        )
        .await
        .unwrap();
    let held = join_window(&w, "warm-later-held", "HELD_OWNER_SOURCE").await;
    let released = ready(&w).await;
    assert!(w
        .bound
        .bounded_fast_reusable(w.credential.credential(), &released, &held.input_event_id)
        .await
        .unwrap());
    let cap = present(&w, &released, &held).await;
    let done = propose(&w, cap.provider(), "HELD_ACCEPTED_ANSWER").await;
    accept(&w, cap.provider(), done).await;
    w.bound
        .request_cancel(&w.f.owner, &deep.provider().run.run_id, "warm-hold-stop")
        .await
        .unwrap();
    let current = join_window(&w, "warm-after-hold", "NEW_CURRENT_INPUT").await;
    let released = ready(&w).await;
    assert_eq!(released.session_id, first.session_id);
    let before = fixtures::snapshot(&w.f.store).await;
    assert!(!w
        .bound
        .bounded_fast_reusable(
            w.credential.credential(),
            &released,
            &current.input_event_id
        )
        .await
        .unwrap());
    assert!(w
        .bound
        .admit_fast(
            w.credential.credential(),
            &FastAdmissionInput {
                source_message_id: current.input_message_id.clone(),
                source_event_id: current.input_event_id.clone(),
                fast_binding_id: released.session_id.clone(),
                expected_binding_generation: released.generation,
                request_key: format!("fast-http:{}", current.input_event_id),
            }
        )
        .await
        .is_err());
    assert_eq!(before, fixtures::snapshot(&w.f.store).await);
    let rotated = fresh(&w, &released, "warm-hold-rotated").await;
    let cap = present(&w, &rotated, &current).await;
    assert!(!cap.text().contains("HELD_OWNER_SOURCE"));
    assert!(!cap.text().contains("HELD_ACCEPTED_ANSWER"));
    assert!(cap.text().contains("prior unheld answer"));
    assert!(cap.text().ends_with("NEW_CURRENT_INPUT"));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn abort_before_dispatch_fences_unused_setup_and_preserves_eligible_source() {
    for confirmed in [false, true] {
        let w = Window::open().await;
        let grant = w
            .bound
            .authorize_bounded_fast_metadata(w.credential.credential(), &w.roles.fast)
            .await
            .unwrap();
        let setup = grant.binding().clone();
        if confirmed {
            w.bound
                .confirm_metadata_session(
                    grant,
                    NativeSessionConfirmation {
                        session_id: setup.session_id.clone(),
                        expected_generation: setup.generation,
                        native_session_id: "synthetic-aborted-setup".into(),
                        protocol_version: "synthetic-1".into(),
                        source_event_key: "aborted-ready".into(),
                    },
                )
                .await
                .unwrap();
        }
        // The trusted composition boundary supplies the actual original-child
        // witness separately; this transaction cannot construct one or mint I/O.
        w.bound
            .retire_bounded_fast_setup(w.credential.credential(), &setup)
            .await
            .unwrap();
        let old: String = sqlx::query_scalar("SELECT state FROM session_bindings WHERE id=?")
            .bind(setup.session_id.to_string())
            .fetch_one(&w.f.store.pool)
            .await
            .unwrap();
        assert_eq!(old, "retired");
        let fresh = w
            .bound
            .ensure_role_bindings(&w.f.owner, &w.f.conversation)
            .await
            .unwrap()
            .fast;
        assert_ne!(fresh.session_id, setup.session_id);
        assert_eq!(fresh.state, SessionState::Starting);
        let _new = w
            .bound
            .authorize_bounded_fast_metadata(w.credential.credential(), &fresh)
            .await
            .unwrap();
        w.activate().await;
        let source = w
            .bound
            .next_fast_source(w.credential.credential(), &w.f.conversation, 0)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(source.event_id, w.source.input_event_id);
        let runs: i64 = sqlx::query_scalar("SELECT count(*) FROM production_runs")
            .fetch_one(&w.f.store.pool)
            .await
            .unwrap();
        assert_eq!(runs, 0);
    }
}
