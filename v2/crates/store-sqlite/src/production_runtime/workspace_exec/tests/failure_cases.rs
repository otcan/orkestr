use super::*;
use std::{
    io::{Read, Write},
    net::Shutdown,
    os::unix::net::UnixStream,
    time::Duration,
};

fn output() -> WorkspaceExecOutput {
    WorkspaceExecOutput {
        stdout: b"synthetic output".to_vec(),
        stderr: Vec::new(),
        exit_code: Some(0),
        signal: None,
    }
}

async fn launched(x: &Fixture, number: u64) -> ConsumedWorkspaceExec {
    let launch = consumed(x, number).await;
    // This Core fixture performs local I/O, never launches a native/provider child.
    x.f.handle
        .with_workspace_exec_fence(&x.f.token, &launch, |_| {
            std::fs::write(x.path.join(format!("effect-{number}")), b"once")
        })
        .unwrap()
        .unwrap();
    launch
}

async fn delivery(
    x: &Fixture,
    number: u64,
) -> (ConsumedWorkspaceExec, CompletedWorkspaceExecDelivery) {
    let launch = launched(x, number).await;
    let WorkspaceExecResultPreparation::Reserved(reservation) =
        x.f.handle
            .prepare_workspace_exec_result(&x.f.token, &launch, &output())
            .await
            .unwrap()
    else {
        panic!("fresh result reservation")
    };
    let WorkspaceExecResultConsumption::Deliver(result) =
        x.f.handle
            .consume_workspace_exec_result(&x.f.token, reservation)
            .await
            .unwrap()
    else {
        panic!("fresh result consumption")
    };
    (launch, result)
}

async fn result_state(x: &Fixture, id: Uuid) -> (String, i64) {
    sqlx::query_as("SELECT state,written_bytes FROM workspace_exec_results WHERE delegation_id=?")
        .bind(id.to_string())
        .fetch_one(&x.f.store.pool)
        .await
        .unwrap()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn elapsed_tool_lease_prevents_spawn_preparation_and_retained_result_write() {
    let x = fixture().await;
    let unstarted = consumed(&x, 1).await;
    let (finished, mut result) = delivery(&x, 2).await;
    let deadline = unstarted.expires_at_ms().max(finished.expires_at_ms());
    let clock = now(&mut x.f.store.pool.acquire().await.unwrap())
        .await
        .unwrap();
    tokio::time::sleep(Duration::from_millis(
        u64::try_from((deadline - clock).max(0)).unwrap() + 10,
    ))
    .await;
    let marker = x.path.join("expired-spawn");
    assert!(matches!(
        x.f.handle
            .with_workspace_exec_fence(&x.f.token, &unstarted, |_| {
                std::fs::write(&marker, b"must not happen")
            }),
        Err(RuntimeStoreError::Expired)
    ));
    assert!(!marker.exists());
    assert!(matches!(
        x.f.handle
            .prepare_workspace_exec_result(&x.f.token, &finished, &output())
            .await,
        Err(RuntimeStoreError::Expired)
    ));
    let (mut writer, mut reader) = UnixStream::pair().unwrap();
    assert!(matches!(
        x.f.handle
            .with_workspace_exec_result_fence(&x.f.token, &mut result, 0, 1, || writer.write(b"x")),
        Err(RuntimeStoreError::Expired)
    ));
    drop(writer);
    let mut bytes = Vec::new();
    reader.read_to_end(&mut bytes).unwrap();
    assert!(bytes.is_empty());
    assert_eq!(
        result_state(&x, finished.id()).await,
        ("delivery_unknown".into(), 0)
    );
    cleanup(x).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn actual_partial_io_error_poisoned_without_second_write_or_completion() {
    let x = fixture().await;
    let (launch, mut result) = delivery(&x, 1).await;
    let (mut writer, mut reader) = UnixStream::pair().unwrap();
    let failed =
        x.f.handle
            .with_workspace_exec_result_fence(&x.f.token, &mut result, 0, 8, || {
                writer.write_all(b"part")?;
                writer.shutdown(Shutdown::Write)?;
                writer.write_all(b"rest")?;
                Ok::<_, std::io::Error>(8)
            })
            .unwrap();
    assert_eq!(failed.unwrap_err().kind(), std::io::ErrorKind::BrokenPipe);
    let mut bytes = Vec::new();
    reader.read_to_end(&mut bytes).unwrap();
    assert_eq!(bytes, b"part");
    assert_eq!(
        result_state(&x, launch.id()).await,
        ("delivery_unknown".into(), 0)
    );
    assert!(x
        .f
        .handle
        .with_workspace_exec_result_fence(
            &x.f.token,
            &mut result,
            0,
            8,
            || -> std::io::Result<usize> {
                panic!("an uncertain partial write must never be retried")
            },
        )
        .is_err());
    assert!(x
        .f
        .handle
        .finish_workspace_exec_result(&x.f.token, result, 8)
        .await
        .is_err());
    cleanup(x).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn deferred_commit_failure_after_real_bytes_poisoned_without_redelivery() {
    let x = fixture().await;
    let (launch, mut result) = delivery(&x, 1).await;
    sqlx::raw_sql("CREATE TABLE synthetic_exec_commit_failure(marker TEXT REFERENCES owners(id) DEFERRABLE INITIALLY DEFERRED); CREATE TRIGGER synthetic_exec_fail_commit AFTER UPDATE OF written_bytes ON workspace_exec_results BEGIN INSERT INTO synthetic_exec_commit_failure VALUES('missing-synthetic-owner'); END;")
        .execute(&x.f.store.pool).await.unwrap();
    let (mut writer, mut reader) = UnixStream::pair().unwrap();
    assert!(x
        .f
        .handle
        .with_workspace_exec_result_fence(&x.f.token, &mut result, 0, 4, || {
            writer.write_all(b"sent")?;
            Ok::<_, std::io::Error>(4)
        })
        .is_err());
    drop(writer);
    let mut bytes = Vec::new();
    reader.read_to_end(&mut bytes).unwrap();
    assert_eq!(bytes, b"sent");
    assert_eq!(
        result_state(&x, launch.id()).await,
        ("delivery_unknown".into(), 0)
    );
    let mut called = false;
    assert!(x
        .f
        .handle
        .with_workspace_exec_result_fence(&x.f.token, &mut result, 0, 4, || {
            called = true;
            Ok::<_, ()>(4)
        })
        .is_err());
    assert!(!called);
    cleanup(x).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn parent_stop_and_revocation_refuse_spawn_and_output_preparation() {
    for transition in ["parent_stop", "worker_stop", "machine", "profile"] {
        let x = fixture().await;
        let unstarted = consumed(&x, 1).await;
        let finished = launched(&x, 2).await;
        match transition {
            "machine" => x.f.store.revoke_session(&x.f.token).await.unwrap(),
            "profile" => {
                x.f.handle
                    .revoke_workspace_exec(&x.f.token, &x.profile)
                    .await
                    .unwrap()
            }
            kind => {
                let run = if kind == "parent_stop" {
                    let id: String = sqlx::query_scalar("SELECT parent_run_id FROM worker_provider_delegations WHERE admitted_run_id=?")
                        .bind(x.parent.parent.run.run_id.to_string())
                        .fetch_one(&x.f.store.pool).await.unwrap();
                    RunId(id.parse().unwrap())
                } else {
                    x.parent.parent.run.run_id.clone()
                };
                x.f.handle
                    .request_cancel(&x.f.owner, &run, "synthetic-stop")
                    .await
                    .unwrap();
            }
        }
        let marker = x.path.join("fenced-spawn");
        assert!(x
            .f
            .handle
            .with_workspace_exec_fence(&x.f.token, &unstarted, |_| {
                std::fs::write(&marker, b"must not happen")
            })
            .is_err());
        assert!(!marker.exists());
        assert!(x
            .f
            .handle
            .prepare_workspace_exec_result(&x.f.token, &finished, &output())
            .await
            .is_err());
        assert_eq!(result_state(&x, finished.id()).await, ("bound".into(), 0));
        cleanup(x).await;
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cancelled_command_acknowledgement_never_restores_execution_authority() {
    let x = fixture().await;
    let launch = launched(&x, 1).await;
    let cancelled =
        x.f.handle
            .request_cancel(&x.f.owner, &x.parent.parent.run.run_id, "synthetic-stop")
            .await
            .unwrap();
    let mut control = (*x.parent.parent).clone();
    control.run = cancelled.new_fenced_admission;
    x.f.handle
        .revoke_workspace_exec(&x.f.token, &x.profile)
        .await
        .unwrap();
    let mut forged = control.clone();
    forged.run.dispatch_fence += 1;
    assert!(x
        .f
        .handle
        .acknowledge_workspace_exec_cancel(&x.f.token, &launch, &forged)
        .await
        .is_err());
    // No child exists in this Core fixture; Runtime must supply real reaping proof.
    let receipt =
        x.f.handle
            .acknowledge_workspace_exec_cancel(&x.f.token, &launch, &control)
            .await
            .unwrap();
    assert_eq!(receipt.state, WorkspaceExecState::Cancelled);
    assert!(x
        .f
        .handle
        .prepare_workspace_exec_result(&x.f.token, &launch, &output())
        .await
        .is_err());
    assert!(x
        .f
        .handle
        .with_workspace_exec_fence(&x.f.token, &launch, |_| Ok::<_, ()>(()))
        .is_err());
    cleanup(x).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn duplicate_grant_and_reopened_store_cannot_reissue_consumed_authority() {
    let x = fixture().await;
    let grant = delegated(&x, 1).await;
    let duplicate = duplicate(&grant);
    let WorkspaceExecConsumption::Launch(launch) =
        x.f.handle
            .consume_workspace_exec(&x.f.token, grant)
            .await
            .unwrap()
    else {
        panic!("first consumption")
    };
    drop(launch); // Lost reply: no effect occurred, but no replacement is allowed.
    let reopened = Store::open(&x.f.root.join("core.sqlite3")).await.unwrap();
    let attached = x.f.handle.reattach_supervisor(&reopened).await.unwrap();
    let allow = WorkspaceOperatorAllowlist::new(
        vec![x.path.clone()],
        vec![x.f.root.clone()],
        std::fs::metadata(&x.path).unwrap().uid(),
    )
    .unwrap();
    attached
        .register_workspace(
            &x.f.token,
            &x.f.conversation,
            x.workspace.exec_identity().0.parse().unwrap(),
            allow.installation(&x.path).unwrap(),
        )
        .await
        .unwrap();
    assert!(matches!(
        attached
            .consume_workspace_exec(&x.f.token, duplicate)
            .await
            .unwrap(),
        WorkspaceExecConsumption::ReconciliationRequired
    ));
    assert!(matches!(
        attached
            .delegate_native_workspace_exec(
                &x.f.token,
                &x.parent,
                &call(1),
                "printf operational",
                5000
            )
            .await
            .unwrap(),
        WorkspaceExecAdmission::Existing(WorkspaceExecReceipt {
            state: WorkspaceExecState::DeliveryUnknown,
            ..
        })
    ));
    reopened.close().await;
    cleanup(x).await;
}
