use super::*;
use crate::production_runtime::tests::{claim, ready, setup, Case};
async fn fixture() -> (Case, DeskLoginParent) {
    let f = setup().await;
    let bindings = f
        .handle
        .ensure_role_bindings(&f.owner, &f.conversation)
        .await
        .unwrap();
    let metadata = f
        .handle
        .authorize_session_metadata(&bindings.deep)
        .await
        .unwrap();
    let source = DeskLoginSetup::from_metadata(&metadata).unwrap();
    let binding = ready(&f).await;
    let claim = claim(&f, &binding).await;
    let run = f
        .handle
        .admit_run(
            &claim,
            &binding.session_id,
            binding.generation,
            "desk-parent",
        )
        .await
        .unwrap();
    let DispatchClaimResult::Reserved(reservation) = f
        .handle
        .claim_provider_dispatch(&run, "desk-dispatch")
        .await
        .unwrap()
    else {
        panic!()
    };
    let ExecutionConsumption::Dispatch(cap) =
        f.handle.consume_execution(&reservation).await.unwrap()
    else {
        panic!()
    };
    let parent = f
        .handle
        .authorize_desk_login_parent(&f.token, &cap, &source)
        .await
        .unwrap();
    (f, parent)
}
fn call() -> DeskLoginNativeCall {
    DeskLoginNativeCall {
        request_id: json!(7),
        call_id: "call:1".into(),
        thread_id: "synthetic-native-deep".into(),
        turn_id: "turn:1".into(),
        operation_id: "synthetic-desk-login".into(),
    }
}
#[tokio::test]
async fn durable_consumption_is_one_use_and_binds_exact_native_correlation() {
    let (f, parent) = fixture().await;
    let call = call();
    let (a, b) = tokio::join!(
        f.handle
            .consume_native_desk_login(&f.token, &parent, &call, 30000),
        f.handle
            .consume_native_desk_login(&f.token, &parent, &call, 30000)
    );
    let operations = [a.unwrap(), b.unwrap()];
    assert_eq!(
        operations
            .iter()
            .filter(|v| matches!(v, DeskLoginConsumption::Operation(_)))
            .count(),
        1
    );
    assert_eq!(
        operations
            .iter()
            .filter(|v| matches!(v, DeskLoginConsumption::ReconciliationRequired))
            .count(),
        1
    );
    let operation = operations
        .into_iter()
        .find_map(|v| {
            if let DeskLoginConsumption::Operation(v) = v {
                Some(v)
            } else {
                None
            }
        })
        .unwrap();
    f.handle
        .desk_login_live(&f.token, &operation)
        .await
        .unwrap();
    assert_eq!(
        operation.root_request()["run_id"],
        parent.parent.run.run_id.to_string()
    );
    let mut changed = call;
    changed.operation_id = "different-resource".into();
    assert!(matches!(
        f.handle
            .consume_native_desk_login(&f.token, &parent, &changed, 30000)
            .await,
        Err(RuntimeStoreError::Conflict)
    ));
    let persisted: String = sqlx::query_scalar("SELECT state FROM deep_desk_operations WHERE id=?")
        .bind(operation.id().to_string())
        .fetch_one(&f.store.pool)
        .await
        .unwrap();
    assert_eq!(persisted, "delivery_unknown");
    f.store.revoke_session(&f.token).await.unwrap();
    assert!(f
        .handle
        .desk_login_live(&f.token, &operation)
        .await
        .is_err());
    assert!(f
        .handle
        .consume_native_desk_login(&f.token, &parent, &changed, 30000)
        .await
        .is_err());
}
#[tokio::test]
async fn fast_worker_cross_conversation_and_invented_native_cannot_issue() {
    let (f, mut parent) = fixture().await;
    for role in [Role::Fast, Role::Worker] {
        parent.parent.run.role = role;
        assert!(f
            .handle
            .consume_native_desk_login(&f.token, &parent, &call(), 30000)
            .await
            .is_err());
    }
    parent.parent.run.role = Role::Deep;
    let original = parent.parent.run.conversation_id;
    parent.parent.run.conversation_id = orkestr_v2_contracts::ConversationId(Uuid::new_v4());
    assert!(f
        .handle
        .consume_native_desk_login(&f.token, &parent, &call(), 30000)
        .await
        .is_err());
    parent.parent.run.conversation_id = original;
    let mut request = call();
    request.thread_id = "another-native".into();
    assert!(f
        .handle
        .consume_native_desk_login(&f.token, &parent, &request, 30000)
        .await
        .is_err());
    request = call();
    request.operation_id = "/bin/sh -c anything".into();
    assert!(f
        .handle
        .consume_native_desk_login(&f.token, &parent, &request, 30000)
        .await
        .is_err());
    let n: i64 = sqlx::query_scalar("SELECT count(*) FROM deep_desk_operations")
        .fetch_one(&f.store.pool)
        .await
        .unwrap();
    assert_eq!(n, 0);
}
#[tokio::test]
async fn expiry_and_durable_stop_fence_retained_operation() {
    let (f, parent) = fixture().await;
    let DeskLoginConsumption::Operation(operation) = f
        .handle
        .consume_native_desk_login(&f.token, &parent, &call(), 100)
        .await
        .unwrap()
    else {
        panic!()
    };
    tokio::time::sleep(std::time::Duration::from_millis(110)).await;
    assert!(f
        .handle
        .desk_login_live(&f.token, &operation)
        .await
        .is_err());
    let mut request = call();
    request.call_id = "call:2".into();
    let DeskLoginConsumption::Operation(operation) = f
        .handle
        .consume_native_desk_login(&f.token, &parent, &request, 30000)
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
    assert!(f
        .handle
        .desk_login_live(&f.token, &operation)
        .await
        .is_err());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn immutable_result_is_current_and_written_once() {
    let (f, parent) = fixture().await;
    let DeskLoginConsumption::Operation(operation) = f
        .handle
        .consume_native_desk_login(&f.token, &parent, &call(), 30000)
        .await
        .unwrap()
    else {
        panic!()
    };
    let mut delivery = f
        .handle
        .prepare_desk_login_result(&f.token, operation, DeskLoginOutcome::HelperCompleted)
        .await
        .unwrap();
    let frame: Value = serde_json::from_slice(delivery.bytes()).unwrap();
    assert_eq!(frame["id"], 7);
    assert_eq!(frame["result"]["success"], true);
    let length = delivery.bytes().len();
    let mut calls = 0;
    assert_eq!(
        f.handle
            .with_desk_login_result_fence(&f.token, &mut delivery, 0, length, || {
                calls += 1;
                Ok::<_, ()>(length)
            })
            .unwrap(),
        Ok(length)
    );
    assert!(f
        .handle
        .with_desk_login_result_fence(&f.token, &mut delivery, 0, length, || {
            calls += 1;
            Ok::<_, ()>(length)
        })
        .is_err());
    assert_eq!(calls, 1); // An invented offset poisons the same result grant.
    assert!(f
        .handle
        .finish_desk_login_result(&f.token, delivery)
        .await
        .is_err());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn unknown_commit_after_result_io_cannot_retry() {
    let (f, parent) = fixture().await;
    let DeskLoginConsumption::Operation(operation) = f
        .handle
        .consume_native_desk_login(&f.token, &parent, &call(), 30000)
        .await
        .unwrap()
    else {
        panic!()
    };
    let mut delivery = f
        .handle
        .prepare_desk_login_result(&f.token, operation, DeskLoginOutcome::Failed)
        .await
        .unwrap();
    sqlx::raw_sql("CREATE TABLE synthetic_desk_commit_failure(marker TEXT REFERENCES owners(id) DEFERRABLE INITIALLY DEFERRED); CREATE TRIGGER synthetic_desk_fail_commit AFTER UPDATE OF written_bytes ON deep_desk_results BEGIN INSERT INTO synthetic_desk_commit_failure VALUES('missing-synthetic-owner'); END;").execute(&f.store.pool).await.unwrap();
    let length = delivery.bytes().len();
    let mut calls = 0;
    assert!(f
        .handle
        .with_desk_login_result_fence(&f.token, &mut delivery, 0, length, || {
            calls += 1;
            Ok::<_, ()>(length)
        })
        .is_err());
    assert!(f
        .handle
        .with_desk_login_result_fence(&f.token, &mut delivery, 0, length, || {
            calls += 1;
            Ok::<_, ()>(length)
        })
        .is_err());
    assert_eq!(calls, 1);
}
