//! Disposable Core state and synthetic provider readiness; no provider process.
use crate::conversation_resources_http::tests::{case, send, Case};
use orkestr_v2_application::runtime::{
    DispatchClaimResult, NativeSessionConfirmation, ProductionSupervisorConfig, ProductionTakeover,
    ProviderKind, RuntimeStore,
};
use orkestr_v2_store_sqlite::history_import::timers::{
    input::TimerInputRequest, TimerClaimRequest, TimerEnableRequest, TimerImportRequest,
    TimerSchedule, TimerTarget,
};
use orkestr_v2_store_sqlite::ExecutionConsumption;
use std::time::Duration;
use uuid::Uuid;

/// A conversation with a running Deep turn (also used by agent attachment tests).
pub(crate) async fn running(timer_origin: bool) -> Case {
    let case = case().await;
    let store = &case.state.store;
    let owner = store
        .credentials("synthetic-owner")
        .await
        .unwrap()
        .unwrap()
        .0;
    let handle = store
        .authorize_supervisor(
            &case.bearer,
            ProductionSupervisorConfig {
                provider: ProviderKind::Codex,
                namespace: "synthetic-timer-discovery".into(),
                supervisor_key: "synthetic-http".into(),
                takeover: ProductionTakeover::First,
            },
        )
        .await
        .unwrap();
    let binding = handle
        .ensure_role_bindings(&owner, &case.conversation)
        .await
        .unwrap()
        .deep;
    let binding = handle
        .confirm_native_session(NativeSessionConfirmation {
            session_id: binding.session_id,
            expected_generation: binding.generation,
            native_session_id: "synthetic-timer-native".into(),
            protocol_version: "codex-rpc-1".into(),
            source_event_key: "synthetic-timer-ready".into(),
        })
        .await
        .unwrap();
    if timer_origin {
        let namespace = Uuid::new_v4();
        let receipt = store
            .import_dormant_timer_for(
                &case.bearer,
                &owner,
                &TimerImportRequest {
                    namespace,
                    source_namespace: "synthetic-timer-source".into(),
                    source_timer_id: "synthetic-once".into(),
                    source_enabled: true,
                    schedule: TimerSchedule::Once {
                        due_ms: 4_000_000_000_000,
                    },
                },
                &TimerTarget {
                    conversation_id: case.conversation.clone(),
                    label: "Synthetic source timer".into(),
                    source_thread_id: "synthetic-source".into(),
                },
            )
            .await
            .unwrap();
        let receipt = store
            .enable_timer_input(
                &case.bearer,
                &owner,
                &TimerEnableRequest {
                    namespace,
                    expected_revision: receipt.revision,
                    request_key: "synthetic-enable".into(),
                    conversation_id: case.conversation.clone(),
                },
                1_000_000_000,
            )
            .await
            .unwrap();
        let due_ms = receipt.next_due_ms.unwrap();
        store
            .admit_timer_input(
                &case.bearer,
                &owner,
                &TimerInputRequest {
                    claim: TimerClaimRequest {
                        namespace,
                        generation: receipt.generation,
                        request_key: "synthetic-occurrence".into(),
                        due_ms,
                    },
                    text: "Synthetic timer input".into(),
                },
                due_ms,
            )
            .await
            .unwrap();
    } else {
        let body = serde_json::json!({
            "client_message_id":"synthetic-discovery-input",
            "text":"Synthetic owner input", "author":"owner"
        });
        assert_eq!(
            send(
                &case.state,
                "POST",
                &case.path("/messages"),
                &[&case.auth()],
                &body.to_string()
            )
            .await
            .0,
            202
        );
    }
    let claim = handle
        .claim_next(
            &owner,
            &case.conversation,
            &binding.session_id,
            Duration::from_secs(60),
        )
        .await
        .unwrap()
        .unwrap();
    let run = handle
        .admit_run(
            &claim,
            &binding.session_id,
            binding.generation,
            "synthetic-discovery-run",
        )
        .await
        .unwrap();
    let DispatchClaimResult::Reserved(reservation) = handle
        .claim_provider_dispatch(&run, "synthetic-discovery-dispatch")
        .await
        .unwrap()
    else {
        panic!("synthetic dispatch was not reserved");
    };
    assert!(matches!(
        handle.consume_execution(&reservation).await.unwrap(),
        ExecutionConsumption::Dispatch(_)
    ));
    case
}
