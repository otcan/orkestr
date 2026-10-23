use super::*;
use crate::production_runtime::{observation_tests, tests as fixture};
use orkestr_v2_application::IntakeStore;
use orkestr_v2_contracts::{ExecutionWindowRequest, MessageInput, Receipt};
use std::time::Duration;

fn request() -> OwnerInputRetirementRequest {
    OwnerInputRetirementRequest {
        request_key: "retire-exact-one".into(),
        reason: "Duplicate input; never replay".into(),
    }
}
async fn input(f: &fixture::Case, key: &str) -> Receipt {
    f.store
        .admit(
            &f.owner,
            &f.conversation,
            &MessageInput {
                client_message_id: key.into(),
                text: "synthetic owner input".into(),
            },
        )
        .await
        .unwrap()
        .receipt
}
async fn retire(f: &fixture::Case, input: &Receipt) -> Result<OwnerInputRetirementReceipt> {
    f.store
        .retire_owner_input_for_browser(&f.token, &f.conversation, &input.message_id, &request())
        .await
}
fn window(input: &Receipt, key: &str) -> ExecutionWindowRequest {
    ExecutionWindowRequest {
        request_key: format!("window:{key}"),
        input_message_id: input.message_id.clone(),
        input_event_id: input.event_id.clone(),
        input_request_key: key.into(),
        expected_generation: 0,
        window_id: None,
        predecessor_window_id: None,
    }
}
async fn effects(store: &Store) -> String {
    sqlx::query_scalar("SELECT json_array((SELECT count(*) FROM messages),(SELECT count(*) FROM events),(SELECT count(*) FROM outbox),(SELECT count(*) FROM production_runs),(SELECT count(*) FROM fixture_runs),(SELECT count(*) FROM execution_windows),(SELECT count(*) FROM execution_window_queue))")
        .fetch_one(&store.pool).await.unwrap()
}

#[tokio::test]
async fn retired_input_stays_retired_across_stop_fresh_intent_and_store_restart() {
    let f = fixture::setup().await;
    let old = input(&f, "old-duplicate").await;
    retire(&f, &old).await.unwrap();
    let binding = fixture::ready(&f).await;
    let initial = fixture::claim(&f, &binding).await;
    let run = f
        .handle
        .admit_run(
            &initial,
            &binding.session_id,
            binding.generation,
            "separate-current-turn",
        )
        .await
        .unwrap();
    f.handle
        .request_cancel(&f.owner, &run.provider.run.run_id, "owner-stop")
        .await
        .unwrap();
    let fresh = input(&f, "fresh-after-stop").await;
    let ready = f
        .handle
        .ensure_role_bindings(&f.owner, &f.conversation)
        .await
        .unwrap()
        .deep;
    let reopened = Store::open(&f.root.join("core.sqlite3")).await.unwrap();
    let attached = f.handle.reattach_supervisor(&reopened).await.unwrap();
    let claim = attached
        .claim_next(
            &f.owner,
            &f.conversation,
            &ready.session_id,
            Duration::from_secs(60),
        )
        .await
        .unwrap()
        .unwrap();
    assert_eq!(claim.message_id, fresh.message_id);
    attached
        .admit_run(
            &claim,
            &ready.session_id,
            ready.generation,
            "only-fresh-after-stop",
        )
        .await
        .unwrap();
    let state: String = sqlx::query_scalar("SELECT state FROM reasoning_inbox WHERE event_id=?")
        .bind(old.event_id.to_string())
        .fetch_one(&reopened.pool)
        .await
        .unwrap();
    assert_eq!(state, "retired");
    assert!(attached
        .next_fast_source(&f.token, &f.conversation, 0)
        .await
        .unwrap()
        .is_none_or(|source| source.message_id != old.message_id));
    assert!(reopened
        .admit_execution_window_authenticated(
            &f.token,
            &f.conversation,
            &window(&old, "old-duplicate")
        )
        .await
        .is_err());
}

#[tokio::test]
async fn retired_input_admission_race_has_only_one_winner() {
    let f = fixture::setup().await;
    let old = input(&f, "old").await;
    let opening = window(&old, "old");
    let (retired, admitted) = tokio::join!(
        retire(&f, &old),
        f.store
            .admit_execution_window_authenticated(&f.token, &f.conversation, &opening)
    );
    assert_ne!(retired.is_ok(), admitted.is_ok());
    let counts: (i64, i64) = sqlx::query_as("SELECT (SELECT count(*) FROM owner_input_retirements),(SELECT count(*) FROM execution_windows)").fetch_one(&f.store.pool).await.unwrap();
    assert!(counts == (1, 0) || counts == (0, 1));
}

#[tokio::test]
async fn retired_input_is_terminal_idempotent_and_preserves_history_without_effects() {
    let f = fixture::setup().await;
    let old = input(&f, "old").await;
    let before = effects(&f.store).await;
    let first = retire(&f, &old).await.unwrap();
    assert!(!first.duplicate);
    assert_eq!(first.message_id, old.message_id);
    assert_eq!(first.event_id, old.event_id);
    assert_eq!(effects(&f.store).await, before);
    let state: String = sqlx::query_scalar("SELECT state FROM reasoning_inbox WHERE event_id=?")
        .bind(old.event_id.to_string())
        .fetch_one(&f.store.pool)
        .await
        .unwrap();
    assert_eq!(state, "retired");
    let reopened = Store::open(&f.root.join("core.sqlite3")).await.unwrap();
    let mut replay = reopened
        .retire_owner_input_for_browser(&f.token, &f.conversation, &old.message_id, &request())
        .await
        .unwrap();
    assert!(replay.duplicate);
    replay.duplicate = false;
    assert_eq!(replay, first);
    let mut changed = request();
    changed.reason = "Changed disposition".into();
    assert!(matches!(
        f.store
            .retire_owner_input_for_browser(&f.token, &f.conversation, &old.message_id, &changed)
            .await,
        Err(RuntimeStoreError::Conflict)
    ));
    for sql in [
        "UPDATE reasoning_inbox SET state='queued' WHERE state='retired'",
        "DELETE FROM reasoning_inbox WHERE state='retired'",
        "UPDATE owner_input_retirements SET reason='changed'",
        "DELETE FROM owner_input_retirements",
    ] {
        assert!(
            sqlx::query(sql).execute(&f.store.pool).await.is_err(),
            "{sql}"
        );
    }
    assert_eq!(effects(&f.store).await, before);
}

#[tokio::test]
async fn retired_input_never_reenters_deep_fast_or_window_admission_after_reopen() {
    let f = fixture::setup().await;
    let old = input(&f, "old").await;
    // Capture an immutable Fast locator before the owner's retirement wins.
    let source = f
        .handle
        .next_fast_source(&f.token, &f.conversation, 0)
        .await
        .unwrap()
        .unwrap();
    retire(&f, &old).await.unwrap();
    let reopened = Store::open(&f.root.join("core.sqlite3")).await.unwrap();
    let handle = f.handle.reattach_supervisor(&reopened).await.unwrap();
    assert!(handle
        .next_fast_source(&f.token, &f.conversation, 0)
        .await
        .unwrap()
        .is_none());
    assert!(reopened
        .admit_execution_window_authenticated(&f.token, &f.conversation, &window(&old, "old"))
        .await
        .is_err());
    assert!(reopened
        .enqueue_execution_window_authenticated(&f.token, &f.conversation, &window(&old, "old"))
        .await
        .is_err());
    let roles = handle
        .ensure_role_bindings(&f.owner, &f.conversation)
        .await
        .unwrap();
    let fast = handle
        .confirm_native_session(NativeSessionConfirmation {
            session_id: roles.fast.session_id,
            expected_generation: roles.fast.generation,
            native_session_id: "synthetic-retirement-fast".into(),
            protocol_version: "synthetic-1".into(),
            source_event_key: "fast-ready".into(),
        })
        .await
        .unwrap();
    let stale = crate::FastAdmissionInput {
        source_message_id: source.message_id,
        source_event_id: source.event_id,
        fast_binding_id: fast.session_id,
        expected_binding_generation: fast.generation,
        request_key: "stale-fast".into(),
    };
    assert!(handle.admit_fast(&f.token, &stale).await.is_err());
    let deep = fixture::ready(&f).await;
    assert!(handle
        .claim_next(
            &f.owner,
            &f.conversation,
            &deep.session_id,
            Duration::from_secs(60)
        )
        .await
        .unwrap()
        .is_none());
    let fresh = input(&f, "fresh").await;
    assert_eq!(
        handle
            .next_fast_source(&f.token, &f.conversation, 0)
            .await
            .unwrap()
            .unwrap()
            .message_id,
        fresh.message_id
    );
    let claim = handle
        .claim_next(
            &f.owner,
            &f.conversation,
            &deep.session_id,
            Duration::from_secs(60),
        )
        .await
        .unwrap()
        .unwrap();
    assert_eq!(claim.message_id, fresh.message_id);
}

#[tokio::test]
async fn retired_input_scope_auth_and_claim_guards_are_atomic() {
    let f = fixture::setup().await;
    let old = input(&f, "old").await;
    for token in ["", "invalid-owner-session"] {
        assert!(matches!(
            f.store
                .retire_owner_input_for_browser(token, &f.conversation, &old.message_id, &request())
                .await,
            Err(RuntimeStoreError::Unauthorized)
        ));
    }
    assert!(matches!(
        f.handle
            .retire_owner_input_for_browser(&f.token, &f.conversation, &old.message_id, &request())
            .await,
        Err(RuntimeStoreError::Unauthorized)
    ));
    assert!(matches!(
        f.store
            .retire_owner_input_for_browser(
                &f.token,
                &ConversationId(Uuid::new_v4()),
                &old.message_id,
                &request()
            )
            .await,
        Err(RuntimeStoreError::NotFound)
    ));
    let deep = fixture::ready(&f).await;
    let _claim = f
        .handle
        .claim_next(
            &f.owner,
            &f.conversation,
            &deep.session_id,
            Duration::from_secs(60),
        )
        .await
        .unwrap()
        .unwrap();
    assert!(matches!(
        retire(&f, &old).await,
        Err(RuntimeStoreError::Conflict)
    ));
    let audits: i64 = sqlx::query_scalar("SELECT count(*) FROM owner_input_retirements")
        .fetch_one(&f.store.pool)
        .await
        .unwrap();
    assert_eq!(audits, 0);
}

#[tokio::test]
async fn retired_input_refuses_pending_window_or_existing_run_without_writes() {
    for queued in [false, true] {
        let f = fixture::setup().await;
        let old = input(&f, "old").await;
        if queued {
            f.store
                .enqueue_execution_window_authenticated(
                    &f.token,
                    &f.conversation,
                    &window(&old, "old"),
                )
                .await
                .unwrap();
        } else {
            f.store
                .admit_execution_window_authenticated(
                    &f.token,
                    &f.conversation,
                    &window(&old, "old"),
                )
                .await
                .unwrap();
        }
        let before = effects(&f.store).await;
        assert!(matches!(
            retire(&f, &old).await,
            Err(RuntimeStoreError::Conflict)
        ));
        assert_eq!(effects(&f.store).await, before);
    }
    let f = fixture::setup().await;
    let p = observation_tests::consumed(&f).await;
    let before = effects(&f.store).await;
    let source: String = sqlx::query_scalar("SELECT message_id FROM production_runs WHERE id=?")
        .bind(p.run.run_id.to_string())
        .fetch_one(&f.store.pool)
        .await
        .unwrap();
    let message = MessageId(source.parse().unwrap());
    assert!(matches!(
        f.store
            .retire_owner_input_for_browser(&f.token, &f.conversation, &message, &request())
            .await,
        Err(RuntimeStoreError::Conflict)
    ));
    assert_eq!(effects(&f.store).await, before);
}
