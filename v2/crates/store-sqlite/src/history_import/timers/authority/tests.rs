//! Synthetic Store tests. Issuer bootstrap/current-context validation is Core-owned.
use super::*;
const TOKEN: &str = "synthetic-durable-owner-session";
async fn fixture() -> (Store, OwnerId, DurableTimerEnable, std::path::PathBuf) {
    let dir = std::env::temp_dir().join(format!("durable-timer-{}", Uuid::new_v4()));
    std::fs::create_dir(&dir).unwrap();
    let store = Store::open(&dir.join("store.sqlite3")).await.unwrap();
    let conversation = store
        .setup("synthetic-owner", "synthetic-hash")
        .await
        .unwrap();
    let owner = store
        .credentials("synthetic-owner")
        .await
        .unwrap()
        .unwrap()
        .0;
    store.save_session(TOKEN, &owner).await.unwrap();
    let exists: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM sqlite_master WHERE name='durable_timer_authorities'",
    )
    .fetch_one(&store.pool)
    .await
    .unwrap();
    if exists == 0 {
        sqlx::raw_sql(include_str!("schema-proposal.sql"))
            .execute(&store.pool)
            .await
            .unwrap();
    }
    let namespace = Uuid::new_v4();
    store
        .import_dormant_timer(
            TOKEN,
            &owner,
            &TimerImportRequest {
                namespace,
                source_namespace: "synthetic-source".into(),
                source_timer_id: "fake-weekly".into(),
                source_enabled: true,
                schedule: TimerSchedule::Interval {
                    every_ms: 7 * 86_400_000,
                },
            },
        )
        .await
        .unwrap();
    let request = DurableTimerEnable {
        timer: TimerEnableRequest {
            namespace,
            expected_revision: 1,
            request_key: "fresh-owner-enable".into(),
            conversation_id: conversation,
        },
        instruction: "Fresh owner-created synthetic weekly task".into(),
    };
    (store, owner, request, dir)
}
async fn due(
    store: &Store,
    owner: &OwnerId,
    namespace: Uuid,
    now: i64,
) -> Result<TimerInputReceipt> {
    // Isolates durable grant/ordinary-writer semantics; not issuer acceptance.
    let mut tx = store.history_transaction(TOKEN, owner, true).await?;
    let result = admit_in_transaction(&mut tx, owner, namespace, now).await?;
    tx.commit().await.map_err(unavailable)?;
    Ok(result)
}
async fn cleanup(store: Store, dir: std::path::PathBuf) {
    store.close().await;
    std::fs::remove_dir_all(dir).unwrap();
}
#[tokio::test]
async fn imported_schedule_is_not_authority_and_weekly_enable_survives_reopen() {
    let (store, owner, request, dir) = fixture().await;
    assert!(due(&store, &owner, request.timer.namespace, i64::MAX)
        .await
        .is_err());
    let grant = store
        .enable_durable_timer(TOKEN, &owner, &request)
        .await
        .unwrap();
    let timer = store
        .dormant_timer_receipt(TOKEN, &owner, grant.namespace)
        .await
        .unwrap();
    let future = timer.next_due_ms.unwrap();
    assert!(future > 1_700_000_000_000);
    assert!(due(&store, &owner, grant.namespace, future - 1)
        .await
        .is_err());
    store.close().await;
    let store = Store::open(&dir.join("store.sqlite3")).await.unwrap();
    let replay = store
        .enable_durable_timer(TOKEN, &owner, &request)
        .await
        .unwrap();
    assert_eq!(replay.authority_id, grant.authority_id);
    assert!(replay.duplicate);
    let admitted = due(&store, &owner, grant.namespace, future).await.unwrap();
    assert_eq!(admitted.claim.generation, grant.generation);
    assert!(due(&store, &owner, grant.namespace, future).await.is_err());
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM dormant_timer_inputs")
        .fetch_one(&store.pool)
        .await
        .unwrap();
    assert_eq!(count, 1);
    cleanup(store, dir).await;
}
#[tokio::test]
async fn immutable_instructions_changed_retry_and_logout_refuse_owner_replay() {
    let (store, owner, mut request, dir) = fixture().await;
    let first = store
        .enable_durable_timer(TOKEN, &owner, &request)
        .await
        .unwrap();
    request.instruction.push_str(" changed");
    assert!(matches!(
        store.enable_durable_timer(TOKEN, &owner, &request).await,
        Err(HistoryError::Conflict)
    ));
    assert!(sqlx::query(
        "UPDATE durable_timer_authorities SET instruction='changed' WHERE authority_id=?"
    )
    .bind(first.authority_id.to_string())
    .execute(&store.pool)
    .await
    .is_err());
    assert!(sqlx::query("DELETE FROM durable_timer_authorities")
        .execute(&store.pool)
        .await
        .is_err());
    sqlx::query("DELETE FROM auth_sessions")
        .execute(&store.pool)
        .await
        .unwrap();
    assert!(matches!(
        store.enable_durable_timer(TOKEN, &owner, &request).await,
        Err(HistoryError::Unauthorized)
    ));
    // Durable authority intentionally remains: creator logout is not grant revoke.
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM durable_timer_authorities")
        .fetch_one(&store.pool)
        .await
        .unwrap();
    assert_eq!(count, 1);
    cleanup(store, dir).await;
}
#[tokio::test]
async fn revoke_retains_provenance_holds_input_and_exact_retry_cannot_rearm() {
    let (store, owner, mut request, dir) = fixture().await;
    let grant = store
        .enable_durable_timer(TOKEN, &owner, &request)
        .await
        .unwrap();
    let enabled = store
        .dormant_timer_receipt(TOKEN, &owner, grant.namespace)
        .await
        .unwrap();
    due(
        &store,
        &owner,
        grant.namespace,
        enabled.next_due_ms.unwrap(),
    )
    .await
    .unwrap();
    let disabled = store
        .revoke_durable_timer(
            TOKEN,
            &owner,
            grant.namespace,
            enabled.revision,
            "owner-revoke".into(),
        )
        .await
        .unwrap();
    let retry = store
        .enable_durable_timer(TOKEN, &owner, &request)
        .await
        .unwrap();
    assert!(retry.duplicate);
    assert_eq!(retry.authority_id, grant.authority_id);
    assert!(due(
        &store,
        &owner,
        grant.namespace,
        enabled.next_due_ms.unwrap() + 7 * 86_400_000
    )
    .await
    .is_err());
    let holds: i64 = sqlx::query_scalar("SELECT count(*) FROM ordinary_input_holds")
        .fetch_one(&store.pool)
        .await
        .unwrap();
    assert_eq!(holds, 1);
    request.timer.expected_revision = disabled.revision;
    request.timer.request_key = "fresh-owner-reenable".into();
    let fresh = store
        .enable_durable_timer(TOKEN, &owner, &request)
        .await
        .unwrap();
    assert!(!fresh.duplicate);
    assert_ne!(fresh.authority_id, grant.authority_id);
    cleanup(store, dir).await;
}
#[tokio::test]
async fn terminal_stop_prevents_due_and_new_enable() {
    let (store, owner, mut request, dir) = fixture().await;
    let grant = store
        .enable_durable_timer(TOKEN, &owner, &request)
        .await
        .unwrap();
    let enabled = store
        .dormant_timer_receipt(TOKEN, &owner, grant.namespace)
        .await
        .unwrap();
    let stopped = store
        .control_dormant_timer(
            TOKEN,
            &owner,
            &TimerControlRequest {
                namespace: grant.namespace,
                expected_revision: enabled.revision,
                request_key: "owner-stop".into(),
                action: TimerControl::Stop,
            },
        )
        .await
        .unwrap();
    assert!(due(
        &store,
        &owner,
        grant.namespace,
        enabled.next_due_ms.unwrap()
    )
    .await
    .is_err());
    request.timer.expected_revision = stopped.revision;
    request.timer.request_key = "cannot-resurrect".into();
    assert!(store
        .enable_durable_timer(TOKEN, &owner, &request)
        .await
        .is_err());
    cleanup(store, dir).await;
}

#[tokio::test]
async fn two_pool_revoke_race_never_leaves_eligible_timer_input() {
    let (store, owner, request, dir) = fixture().await;
    let grant = store
        .enable_durable_timer(TOKEN, &owner, &request)
        .await
        .unwrap();
    let enabled = store
        .dormant_timer_receipt(TOKEN, &owner, grant.namespace)
        .await
        .unwrap();
    let other = Store::open(&dir.join("store.sqlite3")).await.unwrap();
    let (admitted, revoked) = tokio::join!(
        due(
            &store,
            &owner,
            grant.namespace,
            enabled.next_due_ms.unwrap()
        ),
        other.revoke_durable_timer(
            TOKEN,
            &owner,
            grant.namespace,
            enabled.revision,
            "race-revoke".into()
        )
    );
    revoked.unwrap();
    // Admission may win serialization, but must then be held; otherwise zero rows.
    let eligible:i64=sqlx::query_scalar("SELECT count(*) FROM dormant_timer_inputs i WHERE NOT EXISTS(SELECT 1 FROM ordinary_input_holds h WHERE h.event_id=i.event_id)").fetch_one(&store.pool).await.unwrap();
    assert_eq!(eligible, 0);
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM dormant_timer_inputs")
        .fetch_one(&store.pool)
        .await
        .unwrap();
    assert_eq!(count, i64::from(admitted.is_ok()));
    other.close().await;
    cleanup(store, dir).await;
}

#[tokio::test]
async fn authority_insert_failure_rolls_back_enable_and_guard() {
    let (store, owner, request, dir) = fixture().await;
    sqlx::raw_sql("CREATE TRIGGER synthetic_fail_authority BEFORE INSERT ON durable_timer_authorities BEGIN SELECT RAISE(ABORT,'synthetic failure'); END;").execute(&store.pool).await.unwrap();
    assert!(store
        .enable_durable_timer(TOKEN, &owner, &request)
        .await
        .is_err());
    let receipt = store
        .dormant_timer_receipt(TOKEN, &owner, request.timer.namespace)
        .await
        .unwrap();
    assert_eq!(receipt.state, TimerState::Paused);
    assert_eq!(receipt.revision, 1);
    let guards: i64 = sqlx::query_scalar("SELECT count(*) FROM dormant_timer_input_guards")
        .fetch_one(&store.pool)
        .await
        .unwrap();
    assert_eq!(guards, 0);
    cleanup(store, dir).await;
}
