use super::*;
use orkestr_v2_contracts::{ConversationProvider, ConversationSettingsUpdate};
#[tokio::test]
async fn native_result_uses_real_worker_consumption_and_only_accepted_payload() {
    let (f, store, token, parent, source) = running().await;
    let call = store
        .begin_native_worker_call(
            &token,
            &parent,
            Uuid::new_v4(),
            &source,
            &submit(),
            available(),
        )
        .await
        .unwrap();
    let binding = store
        .create_worker_binding(
            &f.owner,
            &f.conversation,
            Some(&parent.parent.run.session_id),
            "native-synthetic-worker",
        )
        .await
        .unwrap();
    let metadata = store
        .authorize_worker_metadata(&token, &parent.parent.run.run_id, &binding)
        .await
        .unwrap();
    let ready = store
        .confirm_metadata_session(
            metadata,
            NativeSessionConfirmation {
                session_id: binding.session_id,
                expected_generation: binding.generation,
                native_session_id: "synthetic-worker-native".into(),
                protocol_version: "codex-rpc-1".into(),
                source_event_key: "native-worker-ready".into(),
            },
        )
        .await
        .unwrap();
    let claim = store
        .claim_worker_task(&token, &parent.parent.run.run_id)
        .await
        .unwrap()
        .unwrap();
    let delegation = store
        .delegate_worker_task(&token, claim, ready.binding())
        .await
        .unwrap();
    let admitted = store.admit_worker(&token, delegation).await.unwrap();
    let DispatchClaimResult::Reserved(reserved) = store
        .claim_provider_dispatch(&admitted, "native-worker-dispatch")
        .await
        .unwrap()
    else {
        panic!()
    };
    let ExecutionConsumption::Dispatch(consumed) =
        store.consume_execution(&reserved).await.unwrap()
    else {
        panic!()
    };
    assert_eq!(
        consumed.text(),
        submit().arguments["instructions"].as_str().unwrap()
    );
    let worker = consumed.provider().clone();
    drop(consumed);
    for (sequence, event) in [
        (1, ProviderEvent::Started),
        (2, ProviderEvent::Progress("earlier draft".into())),
        (
            3,
            ProviderEvent::Progress("Exact accepted Worker answer: 3.".into()),
        ),
    ] {
        store
            .append_provider_event(&f.owner, &worker, &input(&worker, sequence, event))
            .await
            .unwrap();
    }
    let actual = store
        .observe_native_worker_call(&token, &parent, &call)
        .await
        .unwrap();
    assert_eq!(actual.result["phase"], "running");
    assert_eq!(actual.result["run_id"], worker.run.run_id.to_string());
    assert_eq!(actual.result["provider"], "codex");
    assert!(actual.result["result"].is_null());
    let proposal = store
        .append_provider_event(
            &f.owner,
            &worker,
            &input(
                &worker,
                4,
                ProviderEvent::CompletedProposal { synthetic: false },
            ),
        )
        .await
        .unwrap();
    let observed = store
        .observe_native_worker_call(&token, &parent, &call)
        .await
        .unwrap();
    assert_eq!(observed.result["phase"], "awaiting_acceptance");
    assert!(!observed.terminal());
    assert!(observed.result["result"].is_null());
    let browser = format!("browser:{}", "ef".repeat(32));
    f.store.save_session(&browser, &f.owner).await.unwrap();
    let mut settings = ConversationSettingsUpdate {
        expected_revision: 0,
        provider: ConversationProvider::Codex,
        model: None,
        reasoning_effort: None,
        honor_no_reply: true,
        reply_prefix: None,
        reply_footer: None,
        review_before_accepting: true,
        deep_grouping: None,
        parallel_deep: None,
    };
    f.store
        .update_conversation_settings(&browser, &f.owner, &f.conversation, &settings)
        .await
        .unwrap();
    assert!(store
        .auto_accept_window_proposals(&f.conversation)
        .await
        .unwrap()
        .is_empty());
    assert_eq!(
        store
            .observe_native_worker_call(&token, &parent, &call)
            .await
            .unwrap()
            .result["phase"],
        "awaiting_acceptance"
    );
    settings.expected_revision = 1;
    settings.review_before_accepting = false;
    f.store
        .update_conversation_settings(&browser, &f.owner, &f.conversation, &settings)
        .await
        .unwrap();
    let accepted = store
        .auto_accept_window_proposals(&f.conversation)
        .await
        .unwrap();
    assert_eq!(accepted.len(), 1);
    assert_eq!(accepted[0].run_id, worker.run.run_id);
    assert_eq!(accepted[0].completion_event_id, proposal.event_id);
    let audited: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM production_auto_acceptances WHERE run_id=? AND actor='auto_accept'",
    )
    .bind(worker.run.run_id.to_string())
    .fetch_one(&store.pool)
    .await
    .unwrap();
    assert_eq!(audited, 1);
    let observed = store
        .observe_native_worker_call(&token, &parent, &call)
        .await
        .unwrap();
    assert_eq!(observed.result["phase"], "completed");
    assert!(observed.terminal());
    assert_eq!(
        observed.result["result"]["text"],
        "Exact accepted Worker answer: 3."
    );
    assert!(!observed.result["result"]["payload_id"].is_null());
    let status = request("worker_status", json!({"task_id":call.task}));
    let read = store
        .begin_native_worker_call(
            &token,
            &parent,
            Uuid::new_v4(),
            &source,
            &status,
            available(),
        )
        .await
        .unwrap();
    assert_eq!(
        store
            .observe_native_worker_call(&token, &parent, &read)
            .await
            .unwrap()
            .result,
        observed.result
    );
}
