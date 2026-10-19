use super::super::tests::{claim, setup};
use super::tests::{installation, launch, prepared};
use super::*;
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn actual_post_callback_commit_failure_spends_unknown() {
    let f = setup().await;
    let (g, m, _, _) = prepared(&f).await;
    let mut l = launch(&f, &g, &m).await;
    sqlx::raw_sql("CREATE TABLE synthetic_workspace_commit_failure(marker TEXT REFERENCES owners(id) DEFERRABLE INITIALLY DEFERRED); CREATE TRIGGER synthetic_workspace_commit AFTER UPDATE OF callback_attempted ON workspace_launches BEGIN INSERT INTO synthetic_workspace_commit_failure VALUES('missing-owner'); END;").execute(&f.store.pool).await.unwrap();
    let mut calls = 0;
    assert!(f
        .handle
        .with_workspace_metadata_fence(&f.token, &mut l, &m, |_| {
            calls += 1;
            Ok::<_, ()>(())
        })
        .is_err());
    assert_eq!(calls, 1);
    assert!(f
        .handle
        .with_workspace_metadata_fence(&f.token, &mut l, &m, |_| {
            calls += 1;
            Ok::<_, ()>(())
        })
        .is_err());
    assert_eq!(calls, 1);
    let (state, attempted): (String, i64) =
        sqlx::query_as("SELECT state,callback_attempted FROM workspace_launches")
            .fetch_one(&f.store.pool)
            .await
            .unwrap();
    assert_eq!((state.as_str(), attempted), ("delivery_unknown", 0));
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn two_pool_consumption_has_one_winner_and_no_reissue() {
    let f = setup().await;
    let (g, m, allow, path) = prepared(&f).await;
    let WorkspaceLaunchReservationResult::Reserved(r) = f
        .handle
        .reserve_workspace_launch(&f.token, &g, &m, "launch")
        .await
        .unwrap()
    else {
        panic!("fresh")
    };
    // Crate-private test duplication probes durable CAS; no public Clone exists.
    let duplicate = WorkspaceLaunchReservation {
        grant: Box::new(r.grant.retained()),
        binding: r.binding.clone(),
        id: r.id.clone(),
        nonce: r.nonce.clone(),
        metadata_key: r.metadata_key.clone(),
    };
    let pool = Store::open(&f.root.join("core.sqlite3")).await.unwrap();
    let other = f.handle.reattach_supervisor(&pool).await.unwrap();
    other
        .register_workspace(
            &f.token,
            &f.conversation,
            g.project.parse().unwrap(),
            allow.installation(&path).unwrap(),
        )
        .await
        .unwrap();
    let (a, b) = tokio::join!(
        f.handle.consume_workspace_launch(&f.token, r),
        other.consume_workspace_launch(&f.token, duplicate)
    );
    assert_eq!(
        [a.unwrap(), b.unwrap()]
            .into_iter()
            .filter(|x| matches!(x, WorkspaceLaunchConsumption::Launch(_)))
            .count(),
        1
    );
    assert!(matches!(
        other
            .reserve_workspace_launch(&f.token, &g, &m, "launch")
            .await
            .unwrap(),
        WorkspaceLaunchReservationResult::ReconciliationRequired
    ));
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn generation_replacement_fences_metadata_and_inference_but_not_cancel() {
    let f = setup().await;
    let (g, m, _, path) = prepared(&f).await;
    let mut l = launch(&f, &g, &m).await;
    f.handle
        .with_workspace_metadata_fence(&f.token, &mut l, &m, |_| Ok::<_, ()>(()))
        .unwrap()
        .unwrap();
    let b = f
        .handle
        .confirm_metadata_session(
            m,
            NativeSessionConfirmation {
                session_id: l.reservation.binding.session_id.clone(),
                expected_generation: l.reservation.binding.generation,
                native_session_id: "synthetic-workspace-native".into(),
                protocol_version: "codex-rpc-1".into(),
                source_event_key: "workspace-ready".into(),
            },
        )
        .await
        .unwrap()
        .binding()
        .clone();
    let inbox = claim(&f, &b).await;
    let candidate = f
        .handle
        .admit_run(&inbox, &b.session_id, b.generation, "workspace-run")
        .await
        .unwrap();
    let DispatchClaimResult::Reserved(reservation) = f
        .handle
        .claim_provider_dispatch(&candidate, "workspace-dispatch")
        .await
        .unwrap()
    else {
        panic!("fresh")
    };
    let ExecutionConsumption::Dispatch(cap) =
        f.handle.consume_execution(&reservation).await.unwrap()
    else {
        panic!("consumed")
    };
    assert!(f
        .handle
        .with_execution_fence(&cap.provider, || Ok::<_, ()>(()))
        .is_ok());
    let replacement = path.with_extension("replacement");
    std::fs::create_dir_all(replacement.join(".git")).unwrap();
    use std::os::unix::fs::MetadataExt;
    let allow = WorkspaceOperatorAllowlist::new(
        vec![replacement.clone()],
        vec![f.root.clone()],
        std::fs::metadata(&replacement).unwrap().uid(),
    )
    .unwrap();
    let next = f
        .handle
        .replace_workspace(&f.token, &g, allow.installation(&replacement).unwrap())
        .await
        .unwrap();
    assert!(next.generation() > g.generation());
    assert!(f
        .handle
        .with_execution_fence(&cap.provider, || Ok::<_, ()>(()))
        .is_err());
    // Ordinary cancellation does not depend on project filesystem authority.
    let receipt = f
        .handle
        .request_cancel(&f.owner, &cap.provider.run.run_id, "workspace-stop")
        .await
        .unwrap();
    let mut control = cap.provider.clone();
    control.run = receipt.new_fenced_admission;
    assert!(f
        .handle
        .with_cancellation_fence(&control, || Ok::<_, ()>(()))
        .is_ok());
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn symlink_foreign_uid_protected_overlap_and_git_replacement_refuse() {
    let f = setup().await;
    let (allow, path) = installation(&f);
    use std::os::unix::fs::{symlink, MetadataExt};
    let uid = std::fs::metadata(&path).unwrap().uid();
    let alias = path.with_extension("alias");
    symlink(&path, &alias).unwrap();
    let aliases =
        WorkspaceOperatorAllowlist::new(vec![alias.clone()], vec![f.root.clone()], uid).unwrap();
    assert!(aliases.installation(&alias).is_err());
    let foreign = WorkspaceOperatorAllowlist::new(
        vec![path.clone()],
        vec![f.root.clone()],
        uid.wrapping_add(1),
    )
    .unwrap();
    assert!(foreign.installation(&path).is_err());
    let overlap =
        WorkspaceOperatorAllowlist::new(vec![path.clone()], vec![path.join(".git")], uid).unwrap();
    assert!(overlap.installation(&path).is_err());
    let held = allow.installation(&path).unwrap();
    std::fs::write(path.join(".git/HEAD"), "inert-head-change").unwrap();
    assert!(held.inner.check().is_ok());
    std::fs::rename(path.join(".git"), path.join("old-git")).unwrap();
    std::fs::create_dir(path.join(".git")).unwrap();
    assert!(held.inner.check().is_err());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn foreign_store_and_changed_key_refuse_without_new_launch() {
    let f = setup().await;
    let (g, m, _, _) = prepared(&f).await;
    let _l = launch(&f, &g, &m).await;
    assert!(matches!(
        f.handle
            .reserve_workspace_launch(&f.token, &g, &m, "different-key")
            .await,
        Err(RuntimeStoreError::Conflict)
    ));
    let other = setup().await;
    assert!(other
        .handle
        .reserve_workspace_launch(&other.token, &g, &m, "foreign")
        .await
        .is_err());
    let rows: i64 = sqlx::query_scalar("SELECT count(*) FROM workspace_launches")
        .fetch_one(&f.store.pool)
        .await
        .unwrap();
    assert_eq!(rows, 1);
    let foreign: i64 = sqlx::query_scalar("SELECT count(*) FROM workspace_launches")
        .fetch_one(&other.store.pool)
        .await
        .unwrap();
    assert_eq!(foreign, 0);
}
