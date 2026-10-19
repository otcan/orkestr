//! Additional failure-window tests for the registered 0029 candidate.
use super::super::input::TimerInputRequest;
use super::*;

#[tokio::test]
async fn provenance_failure_rolls_back_native_rows_and_cadence() {
    let (store, owner, conversation, directory) = fixture().await;
    let installed: i64 =
        sqlx::query_scalar("SELECT count(*) FROM sqlite_master WHERE name='dormant_timer_inputs'")
            .fetch_one(&store.pool)
            .await
            .unwrap();
    assert_eq!(installed, 1, "requires authoritative 0029");
    let source = input();
    store
        .import_dormant_timer(TOKEN, &owner, &source)
        .await
        .unwrap();
    let enabled = store
        .enable_timer_input(TOKEN, &owner, &enable(&source, &conversation), NOW)
        .await
        .unwrap();
    let before = inert_counts(&store).await;
    let sequence: i64 = sqlx::query_scalar("SELECT sequence FROM conversations WHERE id=?")
        .bind(conversation.to_string())
        .fetch_one(&store.pool)
        .await
        .unwrap();
    sqlx::raw_sql("CREATE TRIGGER fail_timer_provenance BEFORE INSERT ON dormant_timer_inputs BEGIN SELECT RAISE(ABORT,'synthetic provenance failure'); END;")
        .execute(&store.pool).await.unwrap();
    let request = TimerInputRequest {
        claim: claim(&source, &enabled),
        text: "Synthetic timer work".into(),
    };
    assert!(store
        .admit_timer_input(TOKEN, &owner, &request, NOW + 60_000)
        .await
        .is_err());
    assert_eq!(inert_counts(&store).await, before);
    assert_eq!(
        store
            .dormant_timer_receipt(TOKEN, &owner, source.namespace)
            .await
            .unwrap(),
        enabled
    );
    let after_sequence: i64 = sqlx::query_scalar("SELECT sequence FROM conversations WHERE id=?")
        .bind(conversation.to_string())
        .fetch_one(&store.pool)
        .await
        .unwrap();
    assert_eq!(after_sequence, sequence);
    let claims: i64 = sqlx::query_scalar("SELECT count(*) FROM dormant_timer_claims")
        .fetch_one(&store.pool)
        .await
        .unwrap();
    assert_eq!(claims, 0);
    sqlx::raw_sql("DROP TRIGGER fail_timer_provenance")
        .execute(&store.pool)
        .await
        .unwrap();
    let admitted = store
        .admit_timer_input(TOKEN, &owner, &request, NOW + 60_000)
        .await
        .unwrap();
    assert!(!admitted.duplicate);
    cleanup(store, directory).await;
}

#[tokio::test]
async fn revoked_current_credential_refuses_existing_input_receipt() {
    let (store, owner, conversation, directory) = fixture().await;
    let source = input();
    store
        .import_dormant_timer(TOKEN, &owner, &source)
        .await
        .unwrap();
    let enabled = store
        .enable_timer_input(TOKEN, &owner, &enable(&source, &conversation), NOW)
        .await
        .unwrap();
    let request = TimerInputRequest {
        claim: claim(&source, &enabled),
        text: "Synthetic timer work".into(),
    };
    store
        .admit_timer_input(TOKEN, &owner, &request, NOW + 60_000)
        .await
        .unwrap();
    let before = inert_counts(&store).await;
    sqlx::query("DELETE FROM auth_sessions")
        .execute(&store.pool)
        .await
        .unwrap();
    assert!(matches!(
        store
            .admit_timer_input(TOKEN, &owner, &request, NOW + 60_000)
            .await,
        Err(HistoryError::Unauthorized)
    ));
    assert!(matches!(
        store
            .enable_timer_input(TOKEN, &owner, &enable(&source, &conversation), NOW)
            .await,
        Err(HistoryError::Unauthorized)
    ));
    assert_eq!(inert_counts(&store).await, before);
    cleanup(store, directory).await;
}
