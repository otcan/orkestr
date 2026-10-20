use super::*;
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn workspace_grant_has_separate_opt_in_and_is_worker_only() {
    let x = fixture().await; // Also proves Deep inference cannot issue a Worker tool parent.
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM worker_tool_delegations")
        .fetch_one(&x.f.store.pool)
        .await
        .unwrap();
    assert_eq!(count, 0);
    x.f.handle
        .revoke_workspace_exec(&x.f.token, &x.profile)
        .await
        .unwrap();
    assert!(x
        .f
        .handle
        .install_workspace_exec(&x.f.token, &x.workspace)
        .await
        .is_err());
    assert!(x
        .f
        .handle
        .delegate_native_workspace_exec(&x.f.token, &x.parent, &call(1), "printf denied", 5000)
        .await
        .is_err());
    cleanup(x).await;
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn exact_native_call_command_and_lifetime_are_immutable() {
    let x = fixture().await;
    let grant = delegated(&x, 1).await;
    let replay = x
        .f
        .handle
        .delegate_native_workspace_exec(&x.f.token, &x.parent, &call(1), "printf operational", 5000)
        .await
        .unwrap();
    assert!(matches!(replay, WorkspaceExecAdmission::Existing(_)));
    for (command, ttl) in [("printf changed", 5000), ("printf operational", 5001)] {
        assert!(matches!(
            x.f.handle
                .delegate_native_workspace_exec(&x.f.token, &x.parent, &call(1), command, ttl)
                .await,
            Err(RuntimeStoreError::Conflict)
        ));
    }
    let mut foreign = call(2);
    foreign.thread_id = "foreign".into();
    assert!(x
        .f
        .handle
        .delegate_native_workspace_exec(&x.f.token, &x.parent, &foreign, "printf operational", 5000)
        .await
        .is_err());
    let other = duplicate(&grant);
    let WorkspaceExecConsumption::Launch(launch) =
        x.f.handle
            .consume_workspace_exec(&x.f.token, grant)
            .await
            .unwrap()
    else {
        panic!()
    };
    assert!(matches!(
        x.f.handle
            .consume_workspace_exec(&x.f.token, other)
            .await
            .unwrap(),
        WorkspaceExecConsumption::ReconciliationRequired
    ));
    assert_eq!(launch.receipt().state, WorkspaceExecState::DeliveryUnknown);
    cleanup(x).await;
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn callback_gets_exact_descriptor_once_and_error_spends_authority() {
    let x = fixture().await;
    let launch = consumed(&x, 1).await;
    let identity = std::fs::metadata(&x.path).unwrap();
    let result =
        x.f.handle
            .with_workspace_exec_fence(&x.f.token, &launch, |d| {
                assert_eq!(d.workspace_identity().device(), identity.dev());
                assert_eq!(d.workspace_identity().inode(), identity.ino());
                Err::<(), _>("synthetic-spawn-failure")
            })
            .unwrap();
    assert_eq!(result, Err("synthetic-spawn-failure"));
    assert!(x
        .f
        .handle
        .with_workspace_exec_fence(&x.f.token, &launch, |_| Ok::<_, ()>(()))
        .is_err());
    cleanup(x).await;
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn project_substitution_profile_revocation_and_machine_revocation_prevent_spawn() {
    for kind in ["substitution", "profile", "machine"] {
        let x = fixture().await;
        let launch = consumed(&x, 1).await;
        match kind {
            "substitution" => {
                std::fs::rename(&x.path, x.path.with_extension("old")).unwrap();
                std::fs::create_dir_all(x.path.join(".git")).unwrap();
            }
            "profile" => {
                x.f.handle
                    .revoke_workspace_exec(&x.f.token, &x.profile)
                    .await
                    .unwrap()
            }
            _ => x.f.store.revoke_session(&x.f.token).await.unwrap(),
        }
        let mut called = false;
        assert!(x
            .f
            .handle
            .with_workspace_exec_fence(&x.f.token, &launch, |_| {
                called = true;
                Ok::<_, ()>(())
            })
            .is_err());
        assert!(!called);
        if kind == "substitution" {
            std::fs::remove_dir_all(x.path.with_extension("old")).unwrap();
        }
        cleanup(x).await;
    }
}
