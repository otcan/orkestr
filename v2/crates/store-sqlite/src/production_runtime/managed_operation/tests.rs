use super::*;
use crate::production_runtime::tests::{self as fixtures, Case};
use orkestr_v2_application::IntakeStore;
use orkestr_v2_contracts::{ExecutionWindowRequest, MessageInput};
use std::time::Duration;
#[path = "result_tests.rs"]
mod results;

async fn fixture_with_renewal() -> (
    Case,
    Store,
    String,
    ManagedOperationParent,
    ManagedCallerEvidence,
    RunRenewalAuthority,
) {
    let f = fixtures::setup().await;
    let roles = f
        .handle
        .ensure_role_bindings(&f.owner, &f.conversation)
        .await
        .unwrap();
    let receipt = f
        .store
        .admit(
            &f.owner,
            &f.conversation,
            &MessageInput {
                client_message_id: "managed-source".into(),
                text: "Synthetic owner input".into(),
            },
        )
        .await
        .unwrap()
        .receipt;
    let admitted = f
        .store
        .admit_execution_window_authenticated(
            &f.token,
            &f.conversation,
            &ExecutionWindowRequest {
                request_key: "managed-window".into(),
                input_message_id: receipt.message_id,
                input_event_id: receipt.event_id,
                input_request_key: "managed-source".into(),
                expected_generation: 0,
                window_id: None,
                predecessor_window_id: None,
            },
        )
        .await
        .unwrap();
    let grant = f
        .handle
        .issue_execution_window_credential(
            &f.token,
            admitted.status.window_id,
            1,
            "synthetic-boot",
            admitted.status.expires_at_ms,
            &"a".repeat(64),
        )
        .await
        .unwrap();
    let bound = f
        .handle
        .bind_execution_window(&f.token, &grant)
        .await
        .unwrap();
    bound
        .activate_execution_window(
            grant.credential(),
            admitted.status.window_id,
            1,
            "synthetic-boot",
        )
        .await
        .unwrap();
    let metadata = bound.authorize_session_metadata(&roles.deep).await.unwrap();
    let setup = ManagedOperationSetup::from_metadata(&metadata).unwrap();
    let b = bound
        .confirm_native_session(NativeSessionConfirmation {
            session_id: roles.deep.session_id,
            expected_generation: roles.deep.generation,
            native_session_id: "synthetic-native-deep".into(),
            protocol_version: "codex-rpc-1".into(),
            source_event_key: "managed-native-ready".into(),
        })
        .await
        .unwrap();
    let claim = bound
        .claim_next(
            &f.owner,
            &f.conversation,
            &b.session_id,
            Duration::from_secs(30),
        )
        .await
        .unwrap()
        .unwrap();
    let run = bound
        .admit_run(&claim, &b.session_id, b.generation, "managed-run")
        .await
        .unwrap();
    let DispatchClaimResult::Reserved(reservation) = bound
        .claim_provider_dispatch(&run, "managed-dispatch")
        .await
        .unwrap()
    else {
        panic!()
    };
    let ExecutionConsumption::Dispatch(consumed) =
        bound.consume_execution(&reservation).await.unwrap()
    else {
        panic!()
    };
    let parent = bound
        .authorize_managed_operation_parent(grant.credential(), &consumed, &setup)
        .await
        .unwrap();
    let source = ManagedCallerEvidence {
        run_id: parent.parent.run.run_id.to_string(),
        owner_id: f.owner.to_string(),
        conversation_id: f.conversation.to_string(),
        session_id: setup.binding.session_id.to_string(),
        generation: setup.binding.generation,
        incarnation: setup.incarnation.clone(),
        provider: "codex".into(),
        native_session_id: None,
        resume_setup_id: None,
        window_id: admitted.status.window_id,
        window_generation: 1,
        broker_pid: 10001,
        broker_start: 10001,
        caller_pid: 10002,
        caller_start: 10002,
        caller_uid: 10003,
    };
    let renewal = bound.authorize_running_renewal(&consumed).await.unwrap();
    (f, bound, grant.credential().into(), parent, source, renewal)
}
async fn fixture() -> (
    Case,
    Store,
    String,
    ManagedOperationParent,
    ManagedCallerEvidence,
) {
    let (f, bound, token, parent, source, _) = fixture_with_renewal().await;
    (f, bound, token, parent, source)
}
fn request() -> ManagedOperationRequest {
    ManagedOperationRequest {
        version: 1,
        request_key: "request:1".into(),
        operation: "root_request_submit".into(),
        arguments: json!({"action":"read","resource":"example.invalid","summary":"Agent-requested summary"}),
    }
}
#[tokio::test]
async fn concurrent_one_use_unknown_replay_and_changed_payload_conflict() {
    let (_f, bound, token, parent, source) = fixture().await;
    let id = Uuid::new_v4();
    let request = request();
    let (a, b) = tokio::join!(
        bound.consume_managed_operation(&token, &parent, id, &source, &request),
        bound.consume_managed_operation(&token, &parent, id, &source, &request)
    );
    let results = [a.unwrap(), b.unwrap()];
    assert_eq!(
        results
            .iter()
            .filter(|v| matches!(v, ManagedOperationConsumption::Operation(_)))
            .count(),
        1
    );
    assert_eq!(
        results
            .iter()
            .filter(|v| matches!(v, ManagedOperationConsumption::ReconciliationRequired))
            .count(),
        1
    );
    let mut changed = request;
    changed.arguments["summary"] = json!("Changed agent summary");
    assert!(matches!(
        bound
            .consume_managed_operation(&token, &parent, id, &source, &changed)
            .await,
        Err(RuntimeStoreError::Conflict)
    ));
}
#[tokio::test]
async fn caller_claims_cannot_substitute_setup_window_or_authentication() {
    let (_f, bound, token, parent, source) = fixture().await;
    let original = serde_json::to_value(&source).unwrap();
    for (field, value) in [
        ("run_id", json!(Uuid::new_v4().to_string())),
        ("conversation_id", json!(Uuid::new_v4().to_string())),
        ("generation", json!(999)),
        ("provider", json!("claude")),
        ("resume_setup_id", json!("forged")),
        ("window_generation", json!(2)),
        ("window_id", json!(Uuid::new_v4())),
        ("caller_uid", json!(0)),
    ] {
        let mut altered = original.clone();
        altered[field] = value;
        let source = serde_json::from_value(altered).unwrap();
        assert!(
            bound
                .consume_managed_operation(&token, &parent, Uuid::new_v4(), &source, &request())
                .await
                .is_err(),
            "{field}"
        );
    }
    assert!(bound
        .consume_managed_operation(
            &"b".repeat(64),
            &parent,
            Uuid::new_v4(),
            &source,
            &request()
        )
        .await
        .is_err());
    for operation in ["approve", "overrule", "execute"] {
        let mut request = request();
        request.operation = operation.into();
        assert!(bound
            .consume_managed_operation(&token, &parent, Uuid::new_v4(), &source, &request)
            .await
            .is_err());
    }
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn launch_is_once_even_on_callback_failure_and_revocation_precedes_io() {
    let (f, bound, token, parent, source) = fixture().await;
    let ManagedOperationConsumption::Operation(operation) = bound
        .consume_managed_operation(&token, &parent, Uuid::new_v4(), &source, &request())
        .await
        .unwrap()
    else {
        panic!()
    };
    assert!(bound
        .with_managed_operation_launch_fence(&token, &operation, || Err::<usize, _>(()))
        .unwrap()
        .is_err());
    assert!(bound
        .with_managed_operation_launch_fence(
            &token,
            &operation,
            || -> std::result::Result<usize, ()> { panic!("cannot retry unknown write") }
        )
        .is_err());
    let ManagedOperationConsumption::Operation(second) = bound
        .consume_managed_operation(&token, &parent, Uuid::new_v4(), &source, &request())
        .await
        .unwrap()
    else {
        panic!()
    };
    f.store.revoke_session(&token).await.unwrap();
    assert!(bound
        .with_managed_operation_launch_fence(
            &token,
            &second,
            || -> std::result::Result<usize, ()> { panic!("revoked write") }
        )
        .is_err());
}

#[tokio::test]
async fn fast_worker_durable_stop_and_closed_window_are_not_managed_authority() {
    let (f, bound, token, mut parent, source) = fixture().await;
    for role in [Role::Fast, Role::Worker] {
        parent.parent.run.role = role;
        assert!(bound
            .consume_managed_operation(&token, &parent, Uuid::new_v4(), &source, &request())
            .await
            .is_err());
    }
    parent.parent.run.role = Role::Deep;
    let ManagedOperationConsumption::Operation(operation) = bound
        .consume_managed_operation(&token, &parent, Uuid::new_v4(), &source, &request())
        .await
        .unwrap()
    else {
        panic!()
    };
    sqlx::query("UPDATE production_runs SET state='cancel_requested' WHERE id=?")
        .bind(parent.parent.run.run_id.to_string())
        .execute(&f.store.pool)
        .await
        .unwrap();
    assert!(bound
        .managed_operation_live(&token, &operation)
        .await
        .is_err());
    assert!(bound
        .consume_managed_operation(&token, &parent, Uuid::new_v4(), &source, &request())
        .await
        .is_err());
    let (f, bound, token, parent, source) = fixture().await;
    sqlx::query("UPDATE execution_windows SET state='retiring' WHERE id=?")
        .bind(source.window_id.to_string())
        .execute(&f.store.pool)
        .await
        .unwrap();
    assert!(bound
        .consume_managed_operation(&token, &parent, Uuid::new_v4(), &source, &request())
        .await
        .is_err());
}

#[tokio::test]
async fn submitted_receipt_is_not_approval_and_unknown_claims_consume_window_budget() {
    let (f, bound, token, parent, source) = fixture().await;
    let id = Uuid::new_v4();
    let ManagedOperationConsumption::Operation(operation) = bound
        .consume_managed_operation(&token, &parent, id, &source, &request())
        .await
        .unwrap()
    else {
        panic!()
    };
    assert_eq!(
        operation.root_request()["source_message_id"],
        parent.source_message_id
    );
    bound
        .complete_managed_operation(&token, operation, ManagedOperationOutcome::Submitted)
        .await
        .unwrap();
    let state: String = sqlx::query_scalar("SELECT state FROM managed_operations WHERE id=?")
        .bind(id.to_string())
        .fetch_one(&f.store.pool)
        .await
        .unwrap();
    assert_eq!(state, "submitted");
    for _ in 1..32 {
        assert!(matches!(
            bound
                .consume_managed_operation(&token, &parent, Uuid::new_v4(), &source, &request())
                .await
                .unwrap(),
            ManagedOperationConsumption::Operation(_)
        ));
    }
    assert!(bound
        .consume_managed_operation(&token, &parent, Uuid::new_v4(), &source, &request())
        .await
        .is_err());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn opaque_same_run_renewal_preserves_scope_hard_deadline_and_one_write() {
    use crate::production_runtime::observation_tests::input;
    let (_f, bound, token, mut parent, source, mut authority) = fixture_with_renewal().await;
    let ManagedOperationConsumption::Operation(mut operation) = bound
        .consume_managed_operation(&token, &parent, Uuid::new_v4(), &source, &request())
        .await
        .unwrap()
    else {
        panic!()
    };
    bound
        .with_managed_operation_launch_fence(&token, &operation, || Ok::<_, ()>(1))
        .unwrap()
        .unwrap();
    let original = operation.root_request();
    bound
        .append_provider_event(
            &parent.parent.run.owner_id,
            &parent.parent,
            &input(&parent.parent, 1, ProviderEvent::Started),
        )
        .await
        .unwrap();
    tokio::time::sleep(Duration::from_millis(20)).await;
    bound.heartbeat_supervisor().await.unwrap();
    bound.renew_running(&mut authority).await.unwrap();
    assert!(bound
        .managed_operation_live(&token, &operation)
        .await
        .is_err());
    let renewal = bound
        .renew_managed_operation(&token, &mut operation, &authority)
        .await
        .unwrap();
    bound
        .refresh_managed_operation_parent(&token, &mut parent, &authority)
        .await
        .unwrap();
    let renewed = renewal.root_request();
    for field in [
        "operation_id",
        "run_id",
        "evidence",
        "hard_deadline_ms",
        "source_message_id",
        "source_event_id",
    ] {
        assert_eq!(original[field], renewed[field], "{field}");
    }
    assert!(
        renewed["lease_generation"].as_u64().unwrap()
            > original["lease_generation"].as_u64().unwrap()
    );
    assert!(
        renewed["expires_at_ms"].as_i64().unwrap() > original["expires_at_ms"].as_i64().unwrap()
    );
    bound
        .with_managed_renewal_fence(&token, &renewal, || Ok::<_, ()>(1))
        .unwrap()
        .unwrap();
    assert!(bound
        .with_managed_renewal_fence(&token, &renewal, || -> std::result::Result<usize, ()> {
            panic!("renewal replay")
        })
        .is_err());
    bound
        .managed_operation_live(&token, &operation)
        .await
        .unwrap();
    assert!(bound
        .renew_managed_operation(&token, &mut operation, &authority)
        .await
        .is_err());
}
