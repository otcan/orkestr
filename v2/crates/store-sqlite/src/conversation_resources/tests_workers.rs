use super::tests_settings::Case;
use super::*;
use orkestr_v2_contracts::*;

fn worker(id: &str, index: u32, state: LegacyWorkerSourceState) -> LegacyWorkerRecord {
    LegacyWorkerRecord {
        source_thread_id: id.into(),
        source_parent_thread_id: "parent-1".into(),
        worker_index: Some(index),
        title: format!("Parent / Worker {index}"),
        source_state: state,
        branch: Some(format!("orkestr/parent/w{index}")),
        worktree_path: Some(format!("/srv/example/worktrees/parent-1/{id}")),
    }
}
fn register(snapshot: &str, workers: Vec<LegacyWorkerRecord>) -> LegacyWorkerRegisterRequest {
    LegacyWorkerRegisterRequest {
        source_instance: "orkestr-v1".into(),
        snapshot_id: snapshot.into(),
        workers,
    }
}
fn step(id: &str, revision: i64, action: LegacyWorkerAction) -> LegacyWorkerTransition {
    LegacyWorkerTransition {
        source_instance: "orkestr-v1".into(),
        source_thread_id: id.into(),
        expected_revision: revision,
        action,
    }
}
use LegacyWorkerAction as A;
use LegacyWorkerSourceState::{Active, Retired};

#[tokio::test]
async fn registration_defaults_idempotency_and_identity_conflicts() {
    let case = Case::new().await;
    let (t, o, c) = (&case.token, &case.owner, &case.conversation);
    let first = register(
        "s1",
        vec![worker("w1", 1, Active), worker("w2", 2, Retired)],
    );
    let receipt = case
        .store
        .register_legacy_workers(t, o, c, &first)
        .await
        .unwrap();
    assert!(receipt
        .items
        .iter()
        .all(|i| i.outcome == LegacyWorkerRegisterOutcome::Inserted));
    let list = case.store.legacy_workers(t, o, c).await.unwrap();
    let defaults: Vec<_> = list
        .workers
        .iter()
        .map(|w| (w.disposition, w.worktree_writer))
        .collect();
    assert_eq!(
        defaults,
        [
            (LegacyWorkerDisposition::FinishInV1, WorktreeWriter::V1),
            (LegacyWorkerDisposition::Archived, WorktreeWriter::V1)
        ]
    );
    let again = case
        .store
        .register_legacy_workers(t, o, c, &first)
        .await
        .unwrap();
    assert!(again
        .items
        .iter()
        .all(|i| i.outcome == LegacyWorkerRegisterOutcome::Unchanged));
    let mut moved = worker("w1", 1, Active);
    moved.worktree_path = Some("/srv/example/elsewhere".into());
    let conflict = case
        .store
        .register_legacy_workers(t, o, c, &register("s2", vec![moved]))
        .await
        .unwrap();
    assert_eq!(
        conflict.items[0].outcome,
        LegacyWorkerRegisterOutcome::Conflict
    );
    // A worker can belong to only one parent per conversation and one conversation.
    let mut stranger = worker("w9", 9, Active);
    stranger.source_parent_thread_id = "parent-2".into();
    assert_eq!(
        case.store
            .register_legacy_workers(t, o, c, &register("s2", vec![stranger]))
            .await
            .unwrap_err(),
        ResourceError::Conflict("parent_mismatch")
    );
    let other = case.conversation("elsewhere").await;
    let elsewhere = case
        .store
        .register_legacy_workers(t, o, &other, &register("s2", vec![worker("w1", 1, Active)]))
        .await
        .unwrap();
    assert_eq!(
        elsewhere.items[0].outcome,
        LegacyWorkerRegisterOutcome::Conflict
    );
    case.finish().await;
}

#[tokio::test]
async fn worktree_moves_from_v1_to_v2_only_through_none_after_retirement() {
    let case = Case::new().await;
    let (t, o, c) = (&case.token, &case.owner, &case.conversation);
    case.store
        .register_legacy_workers(t, o, c, &register("s1", vec![worker("w1", 1, Active)]))
        .await
        .unwrap();
    macro_rules! go {
        ($r:expr, $a:expr) => {
            case.store
                .transition_legacy_worker(t, o, c, &step("w1", $r, $a))
        };
    }
    let recreate = A::SetDisposition {
        disposition: LegacyWorkerDisposition::RecreateInV2,
    };
    let link = go!(1, recreate.clone()).await.unwrap();
    assert_eq!(link.revision, 2);
    // Active in V1: V1 keeps writing, V2 cannot claim.
    assert_eq!(
        go!(2, A::ReleaseV1Worktree).await.unwrap_err(),
        ResourceError::Conflict("worker_still_active")
    );
    assert_eq!(
        go!(2, A::ClaimV2Worktree).await.unwrap_err(),
        ResourceError::Conflict("worktree_not_released")
    );
    // Fresh snapshot shows the worker retired in V1.
    let updated = case
        .store
        .register_legacy_workers(t, o, c, &register("s2", vec![worker("w1", 1, Retired)]))
        .await
        .unwrap();
    assert_eq!(
        updated.items[0].outcome,
        LegacyWorkerRegisterOutcome::Updated
    );
    assert_eq!(
        go!(2, A::ReleaseV1Worktree).await.unwrap_err(),
        ResourceError::Conflict("worker_revision_mismatch")
    );
    let released = go!(3, A::ReleaseV1Worktree).await.unwrap();
    assert_eq!(released.worktree_writer, WorktreeWriter::None);
    let claimed = go!(4, A::ClaimV2Worktree).await.unwrap();
    assert_eq!(
        (claimed.worktree_writer, claimed.revision),
        (WorktreeWriter::V2, 5)
    );
    // Replaying an action already in effect is a no-op.
    assert_eq!(go!(4, A::ClaimV2Worktree).await.unwrap().revision, 5);
    // V2 owns it: V1 restore is refused, finish_in_v1 is refused.
    let restore = case
        .store
        .register_legacy_workers(t, o, c, &register("s3", vec![worker("w1", 1, Active)]))
        .await
        .unwrap();
    assert_eq!(
        restore.items[0].outcome,
        LegacyWorkerRegisterOutcome::Conflict
    );
    assert_eq!(
        go!(
            5,
            A::SetDisposition {
                disposition: LegacyWorkerDisposition::FinishInV1
            }
        )
        .await
        .unwrap_err(),
        ResourceError::Conflict("worker_retired")
    );
    // Linking requires an existing V2 Worker task of this conversation.
    let missing = TaskId(uuid::Uuid::new_v4());
    assert_eq!(
        go!(5, A::LinkTask { task_id: missing }).await.unwrap_err(),
        ResourceError::Conflict("worker_task_not_found")
    );
    // Rollback path: V2 releases, V1 gets it back.
    go!(5, A::ReleaseV2Worktree).await.unwrap();
    let back = go!(6, A::ReturnV1Worktree).await.unwrap();
    assert_eq!(back.worktree_writer, WorktreeWriter::V1);
    assert_eq!(
        case.count("SELECT count(*) FROM legacy_worker_transitions")
            .await,
        7
    );
    assert!(sqlx::query("DELETE FROM legacy_worker_transitions")
        .execute(&case.store.pool)
        .await
        .is_err());
    case.finish().await;
}

#[tokio::test]
async fn one_v2_writer_per_worktree_path_and_archive_counts() {
    let case = Case::new().await;
    let (t, o, c) = (&case.token, &case.owner, &case.conversation);
    let mut twin = worker("w2", 2, Retired);
    twin.worktree_path = worker("w1", 1, Retired).worktree_path;
    case.store
        .register_legacy_workers(
            t,
            o,
            c,
            &register("s1", vec![worker("w1", 1, Retired), twin]),
        )
        .await
        .unwrap();
    for id in ["w1", "w2"] {
        case.store
            .transition_legacy_worker(t, o, c, &step(id, 1, A::ReleaseV1Worktree))
            .await
            .unwrap();
    }
    case.store
        .transition_legacy_worker(t, o, c, &step("w1", 2, A::ClaimV2Worktree))
        .await
        .unwrap();
    assert_eq!(
        case.store
            .transition_legacy_worker(t, o, c, &step("w2", 2, A::ClaimV2Worktree))
            .await
            .unwrap_err(),
        ResourceError::Conflict("worktree_claimed")
    );
    // Archived history imported under the worker id is reported per link.
    let request = ArchivedImportRequest {
        source_instance: "orkestr-v1".into(),
        source_thread_id: "w1".into(),
        snapshot_id: "s1".into(),
        messages: vec![ArchivedMessage {
            source_message_id: "m1".into(),
            source_position: 1,
            source_cursor: 1,
            role: "assistant".into(),
            phase: None,
            state: None,
            source_kind: None,
            created_at: None,
            updated_at: None,
            text: "synthetic".into(),
            attachments: vec![],
        }],
    };
    case.store
        .import_archived_history(t, o, c, &request)
        .await
        .unwrap();
    let list = case.store.legacy_workers(t, o, c).await.unwrap();
    assert_eq!(
        list.workers
            .iter()
            .map(|w| w.archived_messages)
            .collect::<Vec<_>>(),
        [1, 0]
    );
    case.finish().await;
}
