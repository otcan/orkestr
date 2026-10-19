use super::*;
use crate::production_runtime::tests::{setup, Case};
pub(super) async fn enabled(f: &Case) -> AutomaticReplyProducer {
    let p = f
        .handle
        .bind_automatic_reply_route(
            &f.token,
            &f.conversation,
            Uuid::new_v4(),
            "synthetic-account",
            0,
        )
        .await
        .unwrap();
    permission(f, &p, true, 0, "enable").await;
    p
}
async fn permission(f: &Case, p: &AutomaticReplyProducer, enabled: bool, revision: i64, key: &str) {
    f.store
        .set_automatic_reply_permission_authenticated(
            &f.token,
            &f.conversation,
            &AutomaticReplyPermissionRequest {
                route_id: p.route,
                expected_route_generation: p.generation,
                expected_permission_revision: revision,
                request_key: key.into(),
                enabled,
            },
        )
        .await
        .unwrap();
}
pub(super) async fn input(f: &Case, p: &AutomaticReplyProducer) -> Uuid {
    f.handle
        .register_automatic_reply_input(&f.token, p, Uuid::new_v4(), "synthetic-input")
        .await
        .unwrap()
        .input_id
}
pub(super) async fn reserved(
    f: &Case,
    p: &AutomaticReplyProducer,
    id: Uuid,
) -> AutomaticReplyReservation {
    let AutomaticReplyReservationResult::Reserved(r) = f
        .handle
        .reserve_automatic_reply(&f.token, p, id, "reply", b"exact output")
        .await
        .unwrap()
    else {
        panic!()
    };
    r
}
async fn delivery(f: &Case, p: &AutomaticReplyProducer, id: Uuid) -> AutomaticReplyDelivery {
    let r = reserved(f, p, id).await;
    let AutomaticReplyConsumption::Deliver(d) =
        f.handle.consume_automatic_reply(&f.token, r).await.unwrap()
    else {
        panic!()
    };
    d
}
async fn cleanup(f: Case) {
    f.handle.close().await;
    f.store.close().await;
    std::fs::remove_dir_all(f.root).unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn exact_output_once_unknown_replay_and_reopen() {
    let f = setup().await;
    let p = enabled(&f).await;
    let id = input(&f, &p).await;
    let r = reserved(&f, &p, id).await;
    assert!(matches!(
        f.handle
            .reserve_automatic_reply(&f.token, &p, id, "other-key", b"exact output")
            .await,
        Err(RuntimeStoreError::Conflict)
    ));
    assert!(matches!(
        f.handle
            .reserve_automatic_reply(&f.token, &p, id, "reply", b"changed")
            .await,
        Err(RuntimeStoreError::Conflict)
    ));
    let AutomaticReplyConsumption::Deliver(mut d) =
        f.handle.consume_automatic_reply(&f.token, r).await.unwrap()
    else {
        panic!()
    };
    assert_eq!(d.account_scope(), "synthetic-account");
    let mut output = Vec::new();
    assert_eq!(
        f.handle
            .with_automatic_reply_fence(&f.token, &mut d, 0, 4, |bytes| {
                output.extend_from_slice(bytes);
                Ok::<_, ()>(bytes.len())
            })
            .unwrap(),
        Ok(4)
    );
    assert_eq!(
        f.handle
            .with_automatic_reply_fence(&f.token, &mut d, 4, 8, |bytes| {
                output.extend_from_slice(bytes);
                Ok::<_, ()>(bytes.len())
            })
            .unwrap(),
        Ok(8)
    );
    assert_eq!(output, b"exact output");
    let receipt = f
        .handle
        .finish_automatic_reply_write(&f.token, d)
        .await
        .unwrap();
    assert_eq!(receipt.state, AutomaticReplySendState::DeliveryUnknown);
    assert_eq!(receipt.written_bytes, 12);
    let AutomaticReplyReservationResult::Replay(replay) = f
        .handle
        .reserve_automatic_reply(&f.token, &p, id, "reply", b"exact output")
        .await
        .unwrap()
    else {
        panic!()
    };
    assert_eq!(replay, receipt);
    let reopened = Store::open(&f.root.join("core.sqlite3")).await.unwrap();
    let row: (String, i64) =
        sqlx::query_as("SELECT state,written_bytes FROM automatic_reply_sends WHERE input_id=?")
            .bind(id.to_string())
            .fetch_one(&reopened.pool)
            .await
            .unwrap();
    assert_eq!(row, ("delivery_unknown".into(), 12));
    reopened.close().await;
    cleanup(f).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn disable_hold_route_and_revocation_fence_every_suffix_and_consume() {
    for mode in 0..4 {
        let f = setup().await;
        let p = enabled(&f).await;
        let id = input(&f, &p).await;
        let mut d = delivery(&f, &p, id).await;
        f.handle
            .with_automatic_reply_fence(&f.token, &mut d, 0, 1, |_| Ok::<_, ()>(1))
            .unwrap()
            .unwrap();
        match mode {
            0 => permission(&f, &p, false, 1, "disable").await,
            1 => f
                .store
                .hold_automatic_reply_input_authenticated(
                    &f.token,
                    &f.conversation,
                    id,
                    AutomaticReplyHoldReason::OperatorPreserved,
                )
                .await
                .unwrap(),
            2 => {
                f.handle
                    .bind_automatic_reply_route(
                        &f.token,
                        &f.conversation,
                        p.route,
                        "new-account",
                        1,
                    )
                    .await
                    .unwrap();
            }
            _ => f.store.revoke_session(&f.token).await.unwrap(),
        }
        let mut calls = 0;
        assert!(f
            .handle
            .with_automatic_reply_fence(&f.token, &mut d, 1, 1, |_| {
                calls += 1;
                Ok::<_, ()>(1)
            })
            .is_err());
        assert_eq!(calls, 0);
        assert!(f
            .handle
            .reserve_automatic_reply(&f.token, &p, id, "reply", b"exact output")
            .await
            .is_err());
        let row: (String, i64) = sqlx::query_as(
            "SELECT state,written_bytes FROM automatic_reply_sends WHERE input_id=?",
        )
        .bind(id.to_string())
        .fetch_one(&f.store.pool)
        .await
        .unwrap();
        assert_eq!(row, ("delivery_unknown".into(), 1));
        cleanup(f).await;
    }
    let f = setup().await;
    let p = enabled(&f).await;
    let id = input(&f, &p).await;
    let r = reserved(&f, &p, id).await;
    permission(&f, &p, false, 1, "disable").await;
    permission(&f, &p, true, 2, "reenable").await;
    assert!(matches!(
        f.handle.consume_automatic_reply(&f.token, r).await,
        Err(RuntimeStoreError::Fenced)
    ));
    cleanup(f).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn action_error_poison_and_no_reissue_after_restart() {
    let f = setup().await;
    let p = enabled(&f).await;
    let id = input(&f, &p).await;
    let mut d = delivery(&f, &p, id).await;
    assert!(f
        .handle
        .with_automatic_reply_fence(&f.token, &mut d, 0, 1, |_| Err::<usize, _>(()))
        .unwrap()
        .is_err());
    let mut calls = 0;
    assert!(f
        .handle
        .with_automatic_reply_fence(&f.token, &mut d, 0, 1, |_| {
            calls += 1;
            Ok::<_, ()>(1)
        })
        .is_err());
    assert_eq!(calls, 0);
    assert!(matches!(
        f.handle
            .reserve_automatic_reply(&f.token, &p, id, "reply", b"exact output")
            .await
            .unwrap(),
        AutomaticReplyReservationResult::Replay(_)
    ));
    cleanup(f).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn imported_no_record_sent_and_independent_revisions_never_promote() {
    let f = setup().await;
    let p = enabled(&f).await;
    let ns = Uuid::new_v4();
    let evidence = AutomaticReplyPreservedInput {
        source_namespace: ns,
        source_input_identity: "private-opaque-synthetic".into(),
        source_revision: AutomaticReplySourceRevision::Known("a".repeat(64)),
        hold_source_revision: AutomaticReplySourceRevision::Known("b".repeat(64)),
        source_route_generation: AutomaticReplySourceGeneration::Known(u64::MAX),
        historical_effects: vec![
            AutomaticReplyHistoricalEffect {
                classification: AutomaticReplyEffectClass::Sent,
                count: u64::MAX,
            },
            AutomaticReplyHistoricalEffect {
                classification: AutomaticReplyEffectClass::NoRecord,
                count: 0,
            },
        ],
        hold_reason: AutomaticReplyHoldReason::OperatorPreserved,
        created_at: "after-any-cutoff".into(),
        observed_at: Some("2026-01-01T00:00:00Z".into()),
    };
    let a = f
        .store
        .preserve_automatic_reply_input_authenticated(&f.token, &f.conversation, &evidence)
        .await
        .unwrap();
    assert!(a.dormant && a.never_replay);
    let b = f
        .store
        .preserve_automatic_reply_input_authenticated(&f.token, &f.conversation, &evidence)
        .await
        .unwrap();
    assert_eq!(a, b);
    assert!(f
        .handle
        .register_automatic_reply_input(&f.token, &p, ns, &evidence.source_input_identity)
        .await
        .is_err());
    assert!(f
        .handle
        .reserve_automatic_reply(&f.token, &p, a.input_id, "reply", b"exact output")
        .await
        .is_err());
    let stored: String =
        sqlx::query_scalar("SELECT provenance_json FROM automatic_reply_inputs WHERE id=?")
            .bind(a.input_id.to_string())
            .fetch_one(&f.store.pool)
            .await
            .unwrap();
    assert_eq!(
        serde_json::from_str::<AutomaticReplyPreservedInput>(&stored).unwrap(),
        evidence
    );
    let mut changed = evidence.clone();
    changed.hold_source_revision = AutomaticReplySourceRevision::Unknown;
    assert!(matches!(
        f.store
            .preserve_automatic_reply_input_authenticated(&f.token, &f.conversation, &changed)
            .await,
        Err(RuntimeStoreError::Conflict)
    ));
    f.store.revoke_session(&f.token).await.unwrap();
    assert!(f
        .store
        .preserve_automatic_reply_input_authenticated(&f.token, &f.conversation, &evidence)
        .await
        .is_err());
    cleanup(f).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn reserve_two_pools_one_fresh_capability() {
    let f = setup().await;
    let p = enabled(&f).await;
    let id = input(&f, &p).await;
    let pool = Store::open(&f.root.join("core.sqlite3")).await.unwrap();
    let other = f.handle.reattach_supervisor(&pool).await.unwrap();
    let (a, b) = tokio::join!(
        f.handle
            .reserve_automatic_reply(&f.token, &p, id, "reply", b"exact output"),
        other.reserve_automatic_reply(&f.token, &p, id, "reply", b"exact output")
    );
    let fresh = usize::from(matches!(
        a.unwrap(),
        AutomaticReplyReservationResult::Reserved(_)
    )) + usize::from(matches!(
        b.unwrap(),
        AutomaticReplyReservationResult::Reserved(_)
    ));
    assert_eq!(fresh, 1);
    pool.close().await;
    cleanup(f).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn current_guards_refuse_before_consume_without_unknown_transition() {
    for mode in 0..4 {
        let f = setup().await;
        let p = enabled(&f).await;
        let id = input(&f, &p).await;
        let r = reserved(&f, &p, id).await;
        match mode {
            0 => permission(&f, &p, false, 1, "disable").await,
            1 => f
                .store
                .hold_automatic_reply_input_authenticated(
                    &f.token,
                    &f.conversation,
                    id,
                    AutomaticReplyHoldReason::OperatorPreserved,
                )
                .await
                .unwrap(),
            2 => {
                f.handle
                    .bind_automatic_reply_route(
                        &f.token,
                        &f.conversation,
                        p.route,
                        "replacement-account",
                        1,
                    )
                    .await
                    .unwrap();
            }
            _ => f.store.revoke_session(&f.token).await.unwrap(),
        }
        assert!(f.handle.consume_automatic_reply(&f.token, r).await.is_err());
        let row: (String, i64) = sqlx::query_as(
            "SELECT state,written_bytes FROM automatic_reply_sends WHERE input_id=?",
        )
        .bind(id.to_string())
        .fetch_one(&f.store.pool)
        .await
        .unwrap();
        assert_eq!(row, ("reserved".into(), 0));
        cleanup(f).await;
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn route_starts_disabled_and_key_cannot_select_another_input() {
    let f = setup().await;
    let p = f
        .handle
        .bind_automatic_reply_route(
            &f.token,
            &f.conversation,
            Uuid::new_v4(),
            "synthetic-account",
            0,
        )
        .await
        .unwrap();
    let first = input(&f, &p).await;
    assert!(f
        .handle
        .reserve_automatic_reply(&f.token, &p, first, "reply", b"bytes")
        .await
        .is_err());
    permission(&f, &p, true, 0, "enable").await;
    let _r = reserved(&f, &p, first).await;
    let second = input(&f, &p).await;
    assert!(matches!(
        f.handle
            .reserve_automatic_reply(&f.token, &p, second, "reply", b"exact output",)
            .await,
        Err(RuntimeStoreError::Conflict)
    ));
    cleanup(f).await;
}
