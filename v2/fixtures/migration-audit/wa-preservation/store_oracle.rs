//! Independent schema39 Store oracle. Synthetic state; no transport callback.
use orkestr_v2_application::runtime::{
    ProductionSupervisorConfig, ProductionTakeover, ProviderKind,
};
use orkestr_v2_contracts::*;
use orkestr_v2_store_sqlite::{AutomaticReplyReservationResult, Store};
use uuid::Uuid;

#[tokio::test]
async fn seven_imports_retain_provenance_and_never_acquire_reservation() {
    let root = std::env::temp_dir().join(format!("wa-preservation-oracle-{}", Uuid::new_v4()));
    std::fs::create_dir(&root).unwrap();
    let path = root.join("core.sqlite3");
    let store = Store::open(&path).await.unwrap();
    let conversation = store.setup("fake-owner", "fake-hash").await.unwrap();
    let owner = store.credentials("fake-owner").await.unwrap().unwrap().0;
    let token = "ab".repeat(32);
    store.save_session(&token, &owner).await.unwrap();
    let handle = store
        .authorize_supervisor(
            &token,
            ProductionSupervisorConfig {
                provider: ProviderKind::Codex,
                namespace: "fake-wa-preservation".into(),
                supervisor_key: "fake-supervisor".into(),
                takeover: ProductionTakeover::First,
            },
        )
        .await
        .unwrap();
    let route_id = Uuid::new_v4();
    let producer = handle
        .bind_automatic_reply_route(&token, &conversation, route_id, "fake-account", 0)
        .await
        .unwrap();
    let enable = AutomaticReplyPermissionRequest {
        route_id,
        expected_route_generation: 1,
        expected_permission_revision: 0,
        request_key: "fake-enable".into(),
        enabled: true,
    };
    store
        .set_automatic_reply_permission_authenticated(&token, &conversation, &enable)
        .await
        .unwrap();
    let pool = sqlx::SqlitePool::connect(&format!("sqlite://{}?mode=ro", path.display()))
        .await
        .unwrap();
    let namespace = Uuid::from_u128(111);
    let mut originals = Vec::new();
    for i in 0..7 {
        let evidence = AutomaticReplyPreservedInput {
            source_namespace: namespace,
            source_input_identity: format!("fake-held-input-{i}"),
            source_revision: AutomaticReplySourceRevision::Known("a".repeat(64)),
            hold_source_revision: AutomaticReplySourceRevision::Known("b".repeat(64)),
            source_route_generation: if i == 6 {
                AutomaticReplySourceGeneration::Unknown
            } else {
                AutomaticReplySourceGeneration::Known(u64::MAX)
            },
            historical_effects: vec![AutomaticReplyHistoricalEffect {
                classification: [
                    AutomaticReplyEffectClass::Sent,
                    AutomaticReplyEffectClass::Sending,
                    AutomaticReplyEffectClass::Uncertain,
                    AutomaticReplyEffectClass::Unknown,
                    AutomaticReplyEffectClass::NoRecord,
                ][i % 5],
                count: u64::MAX,
            }],
            hold_reason: AutomaticReplyHoldReason::OperatorPreserved,
            created_at: "2026-10-19T00:00:00Z".into(),
            observed_at: Some("2026-10-19T01:00:00Z".into()),
        };
        let receipt = store
            .preserve_automatic_reply_input_authenticated(&token, &conversation, &evidence)
            .await
            .unwrap();
        assert!(receipt.dormant && receipt.never_replay);
        assert_eq!(
            receipt,
            store
                .preserve_automatic_reply_input_authenticated(&token, &conversation, &evidence)
                .await
                .unwrap()
        );
        let row: (String, i64, i64, Option<String>, Option<i64>) = sqlx::query_as(
            "SELECT provenance_json,dormant,held,route_id,route_generation FROM automatic_reply_inputs WHERE id=?"
        ).bind(receipt.input_id.to_string()).fetch_one(&pool).await.unwrap();
        assert_eq!(
            serde_json::from_str::<AutomaticReplyPreservedInput>(&row.0).unwrap(),
            evidence
        );
        assert_eq!((row.1, row.2, row.3, row.4), (1, 1, None, None));
        assert!(
            handle
                .register_automatic_reply_input(
                    &token,
                    &producer,
                    namespace,
                    &evidence.source_input_identity
                )
                .await
                .is_err()
        );
        assert!(
            handle
                .reserve_automatic_reply(
                    &token,
                    &producer,
                    receipt.input_id,
                    &format!("fake-import-{i}"),
                    b"never send"
                )
                .await
                .is_err()
        );
        let mut changed = evidence.clone();
        changed.hold_source_revision = AutomaticReplySourceRevision::Unknown;
        assert!(
            store
                .preserve_automatic_reply_input_authenticated(&token, &conversation, &changed)
                .await
                .is_err()
        );
        originals.push((evidence, receipt));
    }
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM automatic_reply_sends")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(count, 0);
    // Positive control: fresh trusted ingress can reserve, but receipt replay is not authority.
    let fresh = handle
        .register_automatic_reply_input(&token, &producer, namespace, "fake-fresh")
        .await
        .unwrap();
    assert!(matches!(
        handle
            .reserve_automatic_reply(
                &token,
                &producer,
                fresh.input_id,
                "fake-fresh-send",
                b"synthetic bytes"
            )
            .await
            .unwrap(),
        AutomaticReplyReservationResult::Reserved(_)
    ));
    assert!(matches!(
        handle
            .reserve_automatic_reply(
                &token,
                &producer,
                fresh.input_id,
                "fake-fresh-send",
                b"synthetic bytes"
            )
            .await
            .unwrap(),
        AutomaticReplyReservationResult::Replay(_)
    ));
    let reopened = Store::open(&path).await.unwrap();
    for (evidence, receipt) in &originals {
        assert_eq!(
            *receipt,
            reopened
                .preserve_automatic_reply_input_authenticated(&token, &conversation, evidence)
                .await
                .unwrap()
        );
    }
    store.revoke_session(&token).await.unwrap();
    assert!(
        reopened
            .preserve_automatic_reply_input_authenticated(&token, &conversation, &originals[0].0)
            .await
            .is_err()
    );
    pool.close().await;
    reopened.close().await;
    handle.close().await;
    store.close().await;
    std::fs::remove_dir_all(root).unwrap();
}
