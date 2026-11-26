//! ORK-837 follow-up: a result handed back to the previous provider's Deep
//! turn, queued AHEAD of the policy switch's first ordinary input, never
//! holds the conversation. It is settled like the results the switch
//! withdraws behind its source, and the next input switches.
use super::*;

#[tokio::test]
async fn a_result_of_the_previous_provider_queued_ahead_of_the_source_never_holds_the_switch() {
    qualified(async {
        use orkestr_v2_application::runtime::NativeSessionConfirmation;
        use orkestr_v2_contracts::ConversationProvider;
        let f = fixture().await;
        let conversation = f.conversation("policy-fenced-head").await;
        let mut controller = f.controller(8);
        controller.config.provider_routing = Some(away_from_codex(true));
        controller.config.claude = Some(synthetic_claude());
        controller.queue.swept.store(true, Ordering::Release);
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
        let opening = f.request(&conversation, "fenced-head-window-input").await;
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
                    native_session_id: "synthetic-fenced-head-native".into(),
                    protocol_version: "codex-rpc-1".into(),
                    source_event_key: "synthetic-fenced-head-ready".into(),
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
        // A host result of the running turn queues first, before anything
        // matched; then the source matches and queues behind it.
        let head = follow_up(&f, &conversation, &window, "fenced-head-host-result").await;
        f.store
            .enqueue_execution_window_authenticated(BROWSER, &conversation, &head)
            .await
            .unwrap();
        let source = follow_up(&f, &conversation, &window, "fenced-head-source").await;
        let WindowOutcome::Queued(queued) = controller
            .process(BROWSER, &f.owner, &conversation, &source)
            .await
            .unwrap()
        else {
            panic!("a matching input must queue behind the switch, never join")
        };
        assert_eq!(queued.state, QueuedWindowState::Queued);
        assert_eq!(
            queued_keys(&f, &conversation).await,
            vec![head.request_key.clone(), source.request_key.clone()]
        );
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
        // The head was handed back to that window's Deep run.
        sql(
            &f,
            "INSERT INTO source_admission_fences(message_id,expected_provider_generation,source_run_id,source_native_session_id,source_provider,source_binding_generation) SELECT ?1,0,r.id,r.native_session_id,r.provider_kind,r.binding_generation FROM production_runs r WHERE r.conversation_id=?2 AND r.role='deep'",
            serde_json::json!([head.input_message_id, conversation]),
        );
        // Dispatch takes the head first. It never becomes the switch's
        // source and never holds the source behind it.
        for _ in 0..3 {
            controller.queue.pending.store(false, Ordering::Release);
            controller.drain_locked(BROWSER).await;
        }
        let settled = f
            .store
            .queued_execution_window_authenticated(BROWSER, &conversation, &head)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            (settled.state, settled.withdrawal),
            (
                QueuedWindowState::Withdrawn,
                Some(QueuedWindowWithdrawal::InputUnavailable)
            )
        );
        assert!(f
            .store
            .execution_window_input_retired_authenticated(BROWSER, &conversation, &head)
            .await
            .unwrap());
        assert!(
            !controller
                .queue
                .failures
                .lock()
                .unwrap()
                .contains_key(&head.input_event_id.to_string()),
            "the head was settled, never refused as the switch's source"
        );
        let switched = f
            .store
            .conversation_settings(BROWSER, &f.owner, &conversation)
            .await
            .unwrap();
        assert_eq!(switched.provider, ConversationProvider::Claude);
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
        assert!(queued_keys(&f, &conversation).await.is_empty());
        controller.queue.close().await;
    })
    .await;
}

/// An ordinary queued input is never settled by this path: it is the switch's
/// source, and nothing is withdrawn without a fence.
#[tokio::test]
async fn an_ordinary_input_is_never_withdrawn_as_a_superseded_result() {
    let f = fixture().await;
    let conversation = f.conversation("policy-ordinary-head").await;
    let request = f.request(&conversation, "policy-ordinary-head-input").await;
    f.store
        .enqueue_execution_window_authenticated(BROWSER, &conversation, &request)
        .await
        .unwrap();
    assert_eq!(
        f.store
            .withdraw_policy_superseded_result_authenticated(
                BROWSER,
                &conversation,
                &request.request_key
            )
            .await
            .unwrap(),
        None
    );
    assert_eq!(
        queued_keys(&f, &conversation).await,
        vec![request.request_key.clone()]
    );
}
