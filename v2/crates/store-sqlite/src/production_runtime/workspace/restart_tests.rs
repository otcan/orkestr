use super::*;
use crate::production_runtime::{
    acceptance_tests::proposal,
    tests::{config, setup, snapshot},
};

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn reopened_workspace_restart_rebinds_before_reservation_without_generation_change() {
    let f = setup().await;
    let (g, _, allow, root) = super::tests::prepared(&f).await;
    let project = Uuid::parse_str(&g.project).unwrap();
    let (p, decision) = proposal(&f).await;
    f.store
        .accept_execution_authenticated(&f.token, &f.conversation, &decision)
        .await
        .unwrap();
    f.handle
        .retire_terminal_supervisor(&f.token, &p.run.run_id)
        .await
        .unwrap();
    let reopened = Store::open(&f.root.join("core.sqlite3")).await.unwrap();
    let takeover = || {
        config(ProductionTakeover::ExpiredPredecessor {
            incarnation_id: f.handle.supervisor_incarnation().unwrap().into(),
        })
    };
    let before = snapshot(&f.store).await;
    // Existing path remains fail closed when no installation is supplied.
    assert!(reopened
        .reattach_terminal_supervisor(&f.token, takeover(), &p.run.run_id)
        .await
        .is_err());
    assert_eq!(before, snapshot(&f.store).await);
    // A caller-selected different project cannot replace the durable association.
    assert!(reopened
        .reattach_terminal_supervisor_with_workspace(
            &f.token,
            takeover(),
            &p.run.run_id,
            Uuid::new_v4(),
            allow.installation(&root).unwrap()
        )
        .await
        .is_err());
    assert_eq!(before, snapshot(&f.store).await);
    let (next, metadata) = reopened
        .reattach_terminal_supervisor_with_workspace(
            &f.token,
            takeover(),
            &p.run.run_id,
            project,
            allow.installation(&root).unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(
        metadata.binding().native_session_id,
        p.binding.native_session_id
    );
    assert_ne!(
        next.supervisor_incarnation(),
        f.handle.supervisor_incarnation()
    );
    next.with_metadata_fence(&metadata, || Ok::<_, ()>(()))
        .unwrap()
        .unwrap();
    let renewed = next
        .register_workspace(
            &f.token,
            &f.conversation,
            project,
            allow.installation(&root).unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(renewed.generation(), g.generation());
    let row = sqlx::query(
        "SELECT generation,incarnation_id FROM workspace_session_projects WHERE project_id=?",
    )
    .bind(project.to_string())
    .fetch_one(&f.store.pool)
    .await
    .unwrap();
    assert_eq!(row.get::<i64, _>("generation"), g.generation);
    assert_eq!(
        row.get::<String, _>("incarnation_id"),
        next.supervisor_incarnation().unwrap()
    );
    assert!(reopened
        .reattach_terminal_supervisor_with_workspace(
            &f.token,
            takeover(),
            &p.run.run_id,
            project,
            allow.installation(&root).unwrap()
        )
        .await
        .is_err());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn workspace_restart_refuses_replacement_and_revocation_without_writes() {
    let f = setup().await;
    let (g, _, allow, root) = super::tests::prepared(&f).await;
    let project = Uuid::parse_str(&g.project).unwrap();
    let (p, decision) = proposal(&f).await;
    f.store
        .accept_execution_authenticated(&f.token, &f.conversation, &decision)
        .await
        .unwrap();
    f.handle
        .retire_terminal_supervisor(&f.token, &p.run.run_id)
        .await
        .unwrap();
    let takeover = || {
        config(ProductionTakeover::ExpiredPredecessor {
            incarnation_id: f.handle.supervisor_incarnation().unwrap().into(),
        })
    };
    let installation = allow.installation(&root).unwrap();
    std::fs::rename(&root, root.with_extension("old-project")).unwrap();
    std::fs::create_dir_all(root.join(".git")).unwrap();
    let before = snapshot(&f.store).await;
    assert!(f
        .store
        .reattach_terminal_supervisor_with_workspace(
            &f.token,
            takeover(),
            &p.run.run_id,
            project,
            installation
        )
        .await
        .is_err());
    assert_eq!(before, snapshot(&f.store).await);
    f.store.revoke_session(&f.token).await.unwrap();
    let before = snapshot(&f.store).await;
    assert!(f
        .store
        .reattach_terminal_supervisor_with_workspace(
            &f.token,
            takeover(),
            &p.run.run_id,
            project,
            allow.installation(&root).unwrap()
        )
        .await
        .is_err());
    assert_eq!(before, snapshot(&f.store).await);
}
