use super::super::tests::{setup, Case};
use super::*;
use std::{os::unix::fs::MetadataExt, path::PathBuf};
pub(super) fn installation(f: &Case) -> (WorkspaceOperatorAllowlist, PathBuf) {
    let root = f.root.with_extension("project");
    std::fs::create_dir_all(root.join(".git")).unwrap();
    let uid = std::fs::metadata(&root).unwrap().uid();
    let allow =
        WorkspaceOperatorAllowlist::new(vec![root.clone()], vec![f.root.clone()], uid).unwrap();
    (allow, root)
}
pub(super) async fn prepared(
    f: &Case,
) -> (
    WorkspaceGrant,
    BoundSessionMetadata,
    WorkspaceOperatorAllowlist,
    PathBuf,
) {
    let (allow, root) = installation(f);
    let grant = f
        .handle
        .register_workspace(
            &f.token,
            &f.conversation,
            Uuid::new_v4(),
            allow.installation(&root).unwrap(),
        )
        .await
        .unwrap();
    let binding = f
        .handle
        .ensure_role_bindings(&f.owner, &f.conversation)
        .await
        .unwrap()
        .deep;
    assert!(f.handle.authorize_session_metadata(&binding).await.is_err());
    f.handle
        .bind_workspace_session(&f.token, &grant, &binding)
        .await
        .unwrap();
    let metadata = f.handle.authorize_session_metadata(&binding).await.unwrap();
    (grant, metadata, allow, root)
}
pub(super) async fn launch(
    f: &Case,
    g: &WorkspaceGrant,
    m: &BoundSessionMetadata,
) -> WorkspaceLaunch {
    let WorkspaceLaunchReservationResult::Reserved(r) = f
        .handle
        .reserve_workspace_launch(&f.token, g, m, "launch")
        .await
        .unwrap()
    else {
        panic!("fresh")
    };
    let WorkspaceLaunchConsumption::Launch(l) = f
        .handle
        .consume_workspace_launch(&f.token, r)
        .await
        .unwrap()
    else {
        panic!("fresh")
    };
    l
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn committed_unknown_precedes_callback_and_error_spends_token() {
    let f = setup().await;
    let (g, m, _, _) = prepared(&f).await;
    let mut l = launch(&f, &g, &m).await;
    let state: String = sqlx::query_scalar("SELECT state FROM workspace_launches")
        .fetch_one(&f.store.pool)
        .await
        .unwrap();
    assert_eq!(state, "delivery_unknown");
    let value = f
        .handle
        .with_workspace_metadata_fence(&f.token, &mut l, &m, |d| {
            assert_eq!(
                d.workspace_identity().device(),
                g.installation.workspace.file.metadata().unwrap().dev()
            );
            Err::<(), _>("spawn-error")
        })
        .unwrap();
    assert_eq!(value, Err("spawn-error"));
    assert!(f
        .handle
        .with_workspace_metadata_fence(&f.token, &mut l, &m, |_| Ok::<_, ()>(()))
        .is_err());
    assert!(matches!(
        f.handle
            .reserve_workspace_launch(&f.token, &g, &m, "launch")
            .await
            .unwrap(),
        WorkspaceLaunchReservationResult::ReconciliationRequired
    ));
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn replacement_and_revocation_refuse_before_callback() {
    let f = setup().await;
    let (g, m, _, root) = prepared(&f).await;
    let mut l = launch(&f, &g, &m).await;
    std::fs::rename(&root, root.with_extension("old")).unwrap();
    std::fs::create_dir_all(root.join(".git")).unwrap();
    let mut called = false;
    assert!(f
        .handle
        .with_workspace_metadata_fence(&f.token, &mut l, &m, |_| {
            called = true;
            Ok::<_, ()>(())
        })
        .is_err());
    assert!(!called);
    f.handle.revoke_workspace(&f.token, &g).await.unwrap();
    assert!(f
        .handle
        .with_metadata_fence(&m, || Ok::<_, ()>(()))
        .is_err());
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn linked_worktree_and_reopen_require_exact_reinstallation() {
    let f = setup().await;
    let (allow, root) = installation(&f);
    std::fs::create_dir_all(root.join(".git/worktrees/worker")).unwrap();
    let worker = root.with_extension("linked");
    std::fs::create_dir_all(&worker).unwrap();
    std::fs::write(
        worker.join(".git"),
        format!("gitdir: {}\n", root.join(".git/worktrees/worker").display()),
    )
    .unwrap();
    std::fs::write(root.join(".git/worktrees/worker/commondir"), "../..\n").unwrap();
    let uid = std::fs::metadata(&root).unwrap().uid();
    let linked = WorkspaceOperatorAllowlist::new(vec![worker.clone()], vec![f.root.clone()], uid)
        .unwrap()
        .installation(&worker)
        .unwrap();
    assert!(
        linked.inner.descriptors().git_directory_identity()
            != linked.inner.descriptors().git_common_directory_identity()
    );
    let id = Uuid::new_v4();
    let g = f
        .handle
        .register_workspace(
            &f.token,
            &f.conversation,
            id,
            allow.installation(&root).unwrap(),
        )
        .await
        .unwrap();
    let b = f
        .handle
        .ensure_role_bindings(&f.owner, &f.conversation)
        .await
        .unwrap()
        .deep;
    f.handle
        .bind_workspace_session(&f.token, &g, &b)
        .await
        .unwrap();
    let reopened = Store::open(&f.root.join("core.sqlite3")).await.unwrap();
    let handle = f.handle.reattach_supervisor(&reopened).await.unwrap();
    assert!(handle.authorize_session_metadata(&b).await.is_err());
    handle
        .register_workspace(
            &f.token,
            &f.conversation,
            id,
            allow.installation(&root).unwrap(),
        )
        .await
        .unwrap();
    assert!(handle.authorize_session_metadata(&b).await.is_ok());
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn revoked_machine_and_foreign_binding_refuse() {
    let f = setup().await;
    let (g, m, _, _) = prepared(&f).await;
    let mut l = launch(&f, &g, &m).await;
    f.store.revoke_session(&f.token).await.unwrap();
    let mut called = false;
    assert!(f
        .handle
        .with_workspace_metadata_fence(&f.token, &mut l, &m, |_| {
            called = true;
            Ok::<_, ()>(())
        })
        .is_err());
    assert!(!called);
}
