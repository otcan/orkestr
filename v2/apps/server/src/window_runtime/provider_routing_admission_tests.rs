//! Provider decisions are durable before either admission path launches.
use super::*;

fn provider_routing_policy() -> crate::beta_config::provider_routing::ProviderRouting {
    serde_json::from_value(serde_json::json!({"rules":[{
        "id":"synthetic-route", "terms":[{"text":"synthetic", "weight":3}],
        "threshold":3, "excluded":"claude", "preferred":"codex"
    }]}))
    .unwrap()
}

async fn select_synthetic_claude(f: &Fixture, conversation: &ConversationId) {
    let update = serde_json::from_value(serde_json::json!({
        "expected_revision":0,"provider":"claude","model":"synthetic-model",
        "reasoning_effort":"high","honor_no_reply":false,"reply_prefix":"kept:",
        "reply_footer":"kept footer","review_before_accepting":true
    }))
    .unwrap();
    f.store
        .update_conversation_settings(BROWSER, &f.owner, conversation, &update)
        .await
        .unwrap();
}

#[tokio::test]
async fn provider_routing_precedes_direct_admission_and_authenticates_the_input() {
    use orkestr_v2_contracts::ConversationProvider;
    let f = fixture().await;
    let conversation = f.conversation("policy-direct").await;
    select_synthetic_claude(&f, &conversation).await;
    let request = f.request(&conversation, "policy-direct").await;
    let mut controller = f.controller(8);
    controller.config.provider_routing = Some(provider_routing_policy());
    assert!(controller
        .process("foreign-browser", &f.owner, &conversation, &request)
        .await
        .is_err());
    let before = f
        .store
        .conversation_settings(BROWSER, &f.owner, &conversation)
        .await
        .unwrap();
    assert_eq!(before.provider, ConversationProvider::Claude);
    assert_eq!(f.windows(&conversation).await, 0);
    // No manager exists: a transport failure cannot undo the earlier durable
    // route, and no provider process is needed to test the admission boundary.
    let _ = controller
        .process(BROWSER, &f.owner, &conversation, &request)
        .await;
    let after = f
        .store
        .conversation_settings(BROWSER, &f.owner, &conversation)
        .await
        .unwrap();
    assert_eq!(after.provider, ConversationProvider::Codex);
    assert_eq!(after.revision, before.revision + 1);
    assert!(after.model.is_none());
    assert!(after.reasoning_effort.is_none());
    assert_eq!(after.reply_prefix, before.reply_prefix);
    assert_eq!(after.reply_footer, before.reply_footer);
    assert_eq!(after.honor_no_reply, before.honor_no_reply);
    assert_eq!(
        after.review_before_accepting,
        before.review_before_accepting
    );
}

#[tokio::test]
async fn provider_routing_also_precedes_durable_queue_dispatch() {
    use orkestr_v2_contracts::ConversationProvider;
    let f = fixture().await;
    let conversation = f.conversation("policy-queued").await;
    select_synthetic_claude(&f, &conversation).await;
    let request = f.request(&conversation, "policy-queued").await;
    f.store
        .enqueue_execution_window_authenticated(BROWSER, &conversation, &request)
        .await
        .unwrap();
    let mut controller = f.controller(8);
    controller.config.provider_routing = Some(provider_routing_policy());
    controller.queue.swept.store(true, Ordering::Release);
    controller.drain_locked(BROWSER).await;
    let after = f
        .store
        .conversation_settings(BROWSER, &f.owner, &conversation)
        .await
        .unwrap();
    assert_eq!(after.provider, ConversationProvider::Codex);
}

#[tokio::test]
async fn provider_routing_cannot_switch_an_existing_window_or_consume_its_followup() {
    use orkestr_v2_contracts::ConversationProvider;
    let f = fixture().await;
    let conversation = f.conversation("policy-existing").await;
    let live = f.occupy(&conversation, "policy-existing").await;
    let mut request = f.request(&conversation, "policy-followup").await;
    request.window_id = Some(live.window_id);
    request.expected_generation = live.generation;
    let mut policy = provider_routing_policy();
    policy.rules[0].excluded = ConversationProvider::Codex;
    policy.rules[0].preferred = ConversationProvider::Claude;
    let mut controller = f.controller(8);
    controller.config.provider_routing = Some(policy);
    controller.config.claude = Some(crate::beta_config::ClaudeWindow {
        launcher: "/opt/synthetic/claude-launcher".into(),
        launcher_sha256: "b".repeat(64),
        workspace: "/srv/synthetic/claude-workspace".into(),
        default: false,
        fast: false,
    });
    // Exercise the shared admission boundary directly: the outer controller
    // may durably queue a follow-up whose predecessor is near its deadline.
    let entry = controller.entry(&conversation).unwrap();
    let result = entry
        .process(BROWSER, &f.owner, &conversation, &request)
        .await;
    assert!(
        matches!(
            result,
            Err("provider routing requires an explicit provider handoff")
        ),
        "unexpected refusal: {}",
        result.err().unwrap_or("admitted")
    );
    let settings = f
        .store
        .conversation_settings(BROWSER, &f.owner, &conversation)
        .await
        .unwrap();
    assert_eq!(settings.provider, ConversationProvider::Codex);
    assert_eq!(settings.revision, 0);
    assert_eq!(f.windows(&conversation).await, 1);
}

/// Routing away from Codex, with or without standing native handoff authority.
fn away_from_codex(
    allow_native_handoff: bool,
) -> crate::beta_config::provider_routing::ProviderRouting {
    use orkestr_v2_contracts::ConversationProvider;
    let mut policy = provider_routing_policy();
    policy.rules[0].excluded = ConversationProvider::Codex;
    policy.rules[0].preferred = ConversationProvider::Claude;
    policy.allow_native_handoff = allow_native_handoff;
    policy
}

fn synthetic_claude() -> crate::beta_config::ClaudeWindow {
    crate::beta_config::ClaudeWindow {
        launcher: "/opt/synthetic/claude-launcher".into(),
        launcher_sha256: "b".repeat(64),
        workspace: "/srv/synthetic/claude-workspace".into(),
        default: false,
        fast: false,
    }
}

/// Direct synthetic Core edits (the Store pool is private to its crate).
fn sql(f: &Fixture, statement: &str, args: serde_json::Value) {
    let out = std::process::Command::new("python3")
        .args([
            "-I",
            "-S",
            "-B",
            "-c",
            "import sqlite3,json,sys; c=sqlite3.connect(sys.argv[1]); c.execute(sys.argv[2],json.loads(sys.argv[3])); c.commit()",
        ])
        .arg(f.root.join("core.sqlite3"))
        .arg(statement)
        .arg(args.to_string())
        .env("PYTHONDONTWRITEBYTECODE", "1")
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
}

async fn queued_keys(f: &Fixture, conversation: &ConversationId) -> Vec<String> {
    f.store
        .execution_window_queue_authenticated(BROWSER, Some(conversation))
        .await
        .unwrap()
        .into_iter()
        .map(|row| row.request_key)
        .collect()
}

/// A follow-up of the live `window`, as a client sends it.
async fn follow_up(
    f: &Fixture,
    conversation: &ConversationId,
    window: &ExecutionWindowStatus,
    key: &str,
) -> ExecutionWindowRequest {
    let mut input = f.request(conversation, key).await;
    input.window_id = Some(window.window_id);
    input.expected_generation = window.generation;
    input
}

/// A qualified synthetic build whose root manager reports the window
/// released. A unit test process has neither.
async fn qualified(test: impl std::future::Future<Output = ()>) {
    crate::provider_policy::TEST_SOURCE_COMMIT
        .scope(
            "0123456789abcdef0123456789abcdef01234567",
            crate::window_runtime::controller::TEST_MANAGER_RELEASED.scope(true, test),
        )
        .await;
}

#[tokio::test]
async fn refused_policy_decision_backs_off_alerts_on_the_third_and_never_rewakes() {
    use orkestr_v2_contracts::ConversationProvider;
    let f = fixture().await;
    let conversation = f.conversation("policy-refused").await;
    let live = f.occupy(&conversation, "policy-refused").await;
    sql(
        &f,
        "UPDATE execution_windows SET state='closed' WHERE id=?1",
        serde_json::json!([live.window_id]),
    );
    let request = f.request(&conversation, "policy-refused-input").await;
    f.store
        .enqueue_execution_window_authenticated(BROWSER, &conversation, &request)
        .await
        .unwrap();
    let mut controller = f.controller(8);
    // No standing handoff authority: every pass refuses this decision.
    controller.config.provider_routing = Some(away_from_codex(false));
    controller.queue.swept.store(true, Ordering::Release);
    let key = request.input_event_id.to_string();
    for attempt in 1..=3u32 {
        if let Some(retry) = controller.queue.failures.lock().unwrap().get_mut(&key) {
            retry.1 = Instant::now();
        }
        controller.queue.pending.store(false, Ordering::Release);
        controller.drain_locked(BROWSER).await;
        assert_eq!(controller.queue.failures.lock().unwrap()[&key].0, attempt);
        assert!(
            !controller.queue.retry_due(&key),
            "attempt {attempt} backs off"
        );
        assert!(
            !controller.queue.pending.load(Ordering::Acquire),
            "attempt {attempt} must not wake the dispatcher again"
        );
        // Inside its backoff the decision is not evaluated again.
        controller.drain_locked(BROWSER).await;
        assert_eq!(controller.queue.failures.lock().unwrap()[&key].0, attempt);
    }
    let rows = f
        .store
        .execution_window_queue_authenticated(BROWSER, Some(&conversation))
        .await
        .unwrap();
    assert_eq!(rows.len(), 1, "the intent is kept, never withdrawn");
    assert_eq!(
        deferred_alert(&rows[0], "provider_policy_refused"),
        format!(
            "ALERT orkestr-v2-server window_queue_deferred conversation={conversation} event={} cause=provider_policy_refused",
            request.input_event_id
        )
    );
    let settings = f
        .store
        .conversation_settings(BROWSER, &f.owner, &conversation)
        .await
        .unwrap();
    assert_eq!(
        (settings.provider, settings.revision),
        (ConversationProvider::Codex, 0)
    );
    controller.queue.close().await;
}

/// ORK-837: the source matches while its window is active, so it and the
/// inputs that inherit its match (two host results of the running turn and a
/// timer firing) are queued. The window then closes. The switch waits only
/// for work in flight, then commits; the source opens the first window of
/// the new provider and the timer waits next in line. The two host results
/// were handed back to a turn of the previous provider: they are withdrawn
/// and retired with the switch, never handed to a session that did not ask.
#[tokio::test]
async fn policy_switch_waits_only_for_work_in_flight_and_admits_the_source_first() {
    qualified(async {
        use orkestr_v2_application::runtime::NativeSessionConfirmation;
        use orkestr_v2_contracts::ConversationProvider;
        let f = fixture().await;
        let conversation = f.conversation("policy-successors").await;
        let mut controller = f.controller(8);
        controller.config.provider_routing = Some(away_from_codex(true));
        controller.config.claude = Some(synthetic_claude());
        controller.queue.swept.store(true, Ordering::Release);
        // The conversation's ordinary window, opened and active.
        let scope =
            crate::window_runtime::controller::selected_config(&controller.config, &conversation)
                .unwrap();
        let initial = f
            .store
            .bootstrap_execution_window_authenticated(
                BROWSER,
                &conversation,
                ProductionSupervisorConfig {
                    provider: ProviderKind::Codex,
                    namespace: scope.namespace.clone(),
                    supervisor_key: scope.supervisor_key.clone(),
                    takeover: ProductionTakeover::First,
                },
            )
            .await
            .unwrap();
        let opening = f.request(&conversation, "policy-window-input").await;
        let window = f
            .store
            .admit_execution_window_capped_authenticated(BROWSER, &conversation, &opening, 8)
            .await
            .unwrap()
            .status;
        let cap = initial
            .store()
            .issue_execution_window_credential(
                initial.credential(),
                window.window_id,
                window.generation,
                "seed-boot",
                window.expires_at_ms,
                &"a".repeat(64),
            )
            .await
            .unwrap();
        let bound = initial
            .store()
            .bind_execution_window(initial.credential(), &cap)
            .await
            .unwrap();
        let binding = initial.binding();
        let metadata = bound.authorize_session_metadata(binding).await.unwrap();
        let ready = bound
            .confirm_metadata_session(
                metadata,
                NativeSessionConfirmation {
                    session_id: binding.session_id.clone(),
                    expected_generation: binding.generation,
                    native_session_id: "synthetic-policy-native".into(),
                    protocol_version: "codex-rpc-1".into(),
                    source_event_key: "synthetic-policy-ready".into(),
                },
            )
            .await
            .unwrap();
        bound
            .activate_execution_window(
                cap.credential(),
                window.window_id,
                window.generation,
                "seed-boot",
            )
            .await
            .unwrap();
        // The source and every later input arrive as follow-ups of the
        // active window; the match (then its inheritance) queues them all.
        let source = follow_up(&f, &conversation, &window, "policy-source").await;
        let results = [
            follow_up(&f, &conversation, &window, "policy-host-result-one").await,
            follow_up(&f, &conversation, &window, "policy-host-result-two").await,
        ];
        let timer = follow_up(&f, &conversation, &window, "policy-timer-firing").await;
        for input in std::iter::once(&source)
            .chain(&results)
            .chain(std::iter::once(&timer))
        {
            let WindowOutcome::Queued(queued) = controller
                .process(BROWSER, &f.owner, &conversation, input)
                .await
                .unwrap()
            else {
                panic!("a matching input must queue behind the switch, never join")
            };
            assert_eq!(queued.state, QueuedWindowState::Queued);
        }
        let order: Vec<String> = [&source, &results[0], &results[1], &timer]
            .iter()
            .map(|input| input.request_key.clone())
            .collect();
        assert_eq!(queued_keys(&f, &conversation).await, order);
        crate::window_runtime::closed_idle_process_tests::retirement::close(
            &bound,
            &f.store,
            BROWSER,
            &f.owner,
            &conversation,
            ready.binding(),
            cap.credential(),
            &window,
        )
        .await;
        // The host results were handed back to that window's Deep run.
        for result in &results {
            sql(
                &f,
                "INSERT INTO source_admission_fences(message_id,expected_provider_generation,source_run_id,source_native_session_id,source_provider,source_binding_generation) SELECT ?1,0,r.id,r.native_session_id,r.provider_kind,r.binding_generation FROM production_runs r WHERE r.conversation_id=?2 AND r.role='deep'",
                serde_json::json!([result.input_message_id, conversation]),
            );
        }
        // Another input a session still holds is work in flight.
        let in_flight = f.request(&conversation, "policy-in-flight").await;
        sql(
            &f,
            "UPDATE reasoning_inbox SET state='claimed',claimant_session_id=?1,claim_deadline_ms=1 WHERE message_id=?2",
            serde_json::json!([ready.binding().session_id, in_flight.input_message_id]),
        );
        let key = source.input_event_id.to_string();
        controller.queue.pending.store(false, Ordering::Release);
        controller.drain_locked(BROWSER).await;
        assert_eq!(controller.queue.failures.lock().unwrap()[&key].0, 1);
        assert!(!controller.queue.retry_due(&key), "a blocked switch backs off");
        assert!(
            !controller.queue.pending.load(Ordering::Acquire),
            "a blocked switch must not wake the dispatcher again"
        );
        let unchanged = f
            .store
            .conversation_settings(BROWSER, &f.owner, &conversation)
            .await
            .unwrap();
        assert_eq!(unchanged.provider, ConversationProvider::Codex);
        assert_eq!(queued_keys(&f, &conversation).await, order);
        // Released, it is an inbox row no window claims: no longer in flight.
        sql(
            &f,
            "UPDATE reasoning_inbox SET state='queued',claimant_session_id=NULL,claim_deadline_ms=NULL WHERE message_id=?1",
            serde_json::json!([in_flight.input_message_id]),
        );
        controller.queue.failures.lock().unwrap().get_mut(&key).unwrap().1 = Instant::now();
        controller.drain_locked(BROWSER).await;
        let switched = f
            .store
            .conversation_settings(BROWSER, &f.owner, &conversation)
            .await
            .unwrap();
        assert_eq!(switched.provider, ConversationProvider::Claude);
        assert_eq!(switched.revision, unchanged.revision + 1);
        for result in &results {
            let row = f
                .store
                .queued_execution_window_authenticated(BROWSER, &conversation, result)
                .await
                .unwrap()
                .unwrap();
            assert_eq!(
                (row.state, row.withdrawal),
                (
                    QueuedWindowState::Withdrawn,
                    Some(QueuedWindowWithdrawal::InputUnavailable)
                )
            );
            assert!(f
                .store
                .execution_window_input_retired_authenticated(BROWSER, &conversation, result)
                .await
                .unwrap());
        }
        assert_eq!(
            queued_keys(&f, &conversation).await,
            vec![source.request_key.clone(), timer.request_key.clone()]
        );
        // The source opens the successor window first, as the new provider.
        controller.drain_locked(BROWSER).await;
        let first = f
            .store
            .queued_execution_window_authenticated(BROWSER, &conversation, &source)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(first.state, QueuedWindowState::Dispatched);
        let successor = f
            .store
            .execution_window_status_authenticated(BROWSER, &conversation)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(first.window_id, Some(successor.window_id));
        assert_eq!(successor.generation, window.generation + 1);
        assert_eq!(
            queued_keys(&f, &conversation).await,
            vec![timer.request_key.clone()]
        );
        controller.queue.close().await;
    })
    .await;
}

#[path = "provider_routing_fenced_head_tests.rs"]
mod fenced_head;
