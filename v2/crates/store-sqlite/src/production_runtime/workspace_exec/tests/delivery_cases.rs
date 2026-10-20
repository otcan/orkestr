use super::*;
fn output() -> WorkspaceExecOutput {
    WorkspaceExecOutput {
        stdout: b"operational".to_vec(),
        stderr: Vec::new(),
        exit_code: Some(0),
        signal: None,
    }
}
async fn prepared(x: &Fixture) -> WorkspaceExecResultReservation {
    let launch = consumed(x, 1).await;
    x.f.handle
        .with_workspace_exec_fence(&x.f.token, &launch, |_| Ok::<_, ()>(()))
        .unwrap()
        .unwrap();
    let WorkspaceExecResultPreparation::Reserved(reservation) =
        x.f.handle
            .prepare_workspace_exec_result(&x.f.token, &launch, &output())
            .await
            .unwrap()
    else {
        panic!()
    };
    reservation
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn completed_result_is_consumed_once_and_suffix_write_is_fenced() {
    let x = fixture().await;
    let reservation = prepared(&x).await;
    let WorkspaceExecResultConsumption::Deliver(mut delivery) =
        x.f.handle
            .consume_workspace_exec_result(&x.f.token, reservation)
            .await
            .unwrap()
    else {
        panic!()
    };
    assert!(delivery.native_call() == &call(1));
    assert!(delivery.text().contains("operational"));
    assert!(delivery.success());
    x.f.handle
        .with_workspace_exec_result_fence(&x.f.token, &mut delivery, 0, 5, || Ok::<_, ()>(5))
        .unwrap()
        .unwrap();
    x.f.handle
        .finish_workspace_exec_result(&x.f.token, delivery, 5)
        .await
        .unwrap();
    let state: String = sqlx::query_scalar("SELECT state FROM workspace_exec_results")
        .fetch_one(&x.f.store.pool)
        .await
        .unwrap();
    assert_eq!(state, "delivered");
    cleanup(x).await;
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn revoked_workspace_or_profile_cannot_deliver_retained_result() {
    for profile_only in [true, false] {
        let x = fixture().await;
        let reservation = prepared(&x).await;
        let WorkspaceExecResultConsumption::Deliver(mut delivery) =
            x.f.handle
                .consume_workspace_exec_result(&x.f.token, reservation)
                .await
                .unwrap()
        else {
            panic!()
        };
        if profile_only {
            x.f.handle
                .revoke_workspace_exec(&x.f.token, &x.profile)
                .await
                .unwrap();
        } else {
            x.f.handle
                .revoke_workspace(&x.f.token, &x.workspace)
                .await
                .unwrap();
        }
        let mut called = false;
        assert!(x
            .f
            .handle
            .with_workspace_exec_result_fence(&x.f.token, &mut delivery, 0, 1, || {
                called = true;
                Ok::<_, ()>(1)
            })
            .is_err());
        assert!(!called);
        cleanup(x).await;
    }
}
