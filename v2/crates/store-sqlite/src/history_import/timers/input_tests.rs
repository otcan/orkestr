use super::super::input::TimerInputRequest;
use super::*;
async fn bridge_fixture() -> (Store, OwnerId, ConversationId, std::path::PathBuf) {
    let fixture = fixture().await;
    let exists: i64 =
        sqlx::query_scalar("SELECT count(*) FROM sqlite_master WHERE name='dormant_timer_inputs'")
            .fetch_one(&fixture.0.pool)
            .await
            .unwrap();
    assert_eq!(exists, 1, "authoritative migration 0029 must be installed");
    fixture
}
#[tokio::test]
async fn ordinary_input_replay_payload_and_disable_fence() {
    let (store, owner, conversation, directory) = bridge_fixture().await;
    let source = input();
    store
        .import_dormant_timer(TOKEN, &owner, &source)
        .await
        .unwrap();
    let enabled = store
        .enable_timer_input(TOKEN, &owner, &enable(&source, &conversation), NOW)
        .await
        .unwrap();
    let mut request = TimerInputRequest {
        claim: claim(&source, &enabled),
        text: "Synthetic owner work".into(),
    };
    let first = store
        .admit_timer_input(TOKEN, &owner, &request, NOW + 60_000)
        .await
        .unwrap();
    assert!(!first.duplicate);
    let replay = store
        .admit_timer_input(TOKEN, &owner, &request, NOW + 60_000)
        .await
        .unwrap();
    assert!(replay.duplicate);
    assert_eq!(first.input.event_id, replay.input.event_id);
    request.text.push('!');
    assert!(matches!(
        store
            .admit_timer_input(TOKEN, &owner, &request, NOW + 60_000)
            .await,
        Err(HistoryError::Conflict)
    ));
    store
        .control_dormant_timer(
            TOKEN,
            &owner,
            &TimerControlRequest {
                namespace: source.namespace,
                expected_revision: enabled.revision,
                request_key: "disable-input".into(),
                action: TimerControl::Disable,
            },
        )
        .await
        .unwrap();
    let held: i64 =
        sqlx::query_scalar("SELECT count(*) FROM ordinary_input_holds WHERE event_id=?")
            .bind(first.input.event_id.to_string())
            .fetch_one(&store.pool)
            .await
            .unwrap();
    assert_eq!(held, 1);
    assert!(matches!(
        store
            .admit_timer_input(TOKEN, &owner, &request, NOW + 60_000)
            .await,
        Err(HistoryError::Conflict)
    ));
    cleanup(store, directory).await;
}
#[tokio::test]
async fn failed_native_input_rolls_back_cadence_claim_and_provenance() {
    let (store, owner, conversation, directory) = bridge_fixture().await;
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
        text: " ".into(),
    };
    assert!(store
        .admit_timer_input(TOKEN, &owner, &request, NOW + 60_000)
        .await
        .is_err());
    assert_eq!(
        store
            .dormant_timer_receipt(TOKEN, &owner, source.namespace)
            .await
            .unwrap(),
        enabled
    );
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM dormant_timer_claims")
        .fetch_one(&store.pool)
        .await
        .unwrap();
    assert_eq!(count, 0);
    assert!(store
        .admit_timer_input("revoked", &owner, &request, NOW + 60_000)
        .await
        .is_err());
    cleanup(store, directory).await;
}
#[tokio::test]
async fn inert_enable_cannot_be_promoted_or_dispatch() {
    let (store, owner, conversation, directory) = bridge_fixture().await;
    let source = input();
    store
        .import_dormant_timer(TOKEN, &owner, &source)
        .await
        .unwrap();
    let enable = enable(&source, &conversation);
    let enabled = store
        .enable_dormant_timer(TOKEN, &owner, &enable, NOW)
        .await
        .unwrap();
    assert!(store
        .enable_timer_input(TOKEN, &owner, &enable, NOW)
        .await
        .is_err());
    let request = TimerInputRequest {
        claim: claim(&source, &enabled),
        text: "Synthetic work".into(),
    };
    assert!(store
        .admit_timer_input(TOKEN, &owner, &request, NOW + 60_000)
        .await
        .is_err());
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM dormant_timer_claims")
        .fetch_one(&store.pool)
        .await
        .unwrap();
    assert_eq!(count, 0);
    cleanup(store, directory).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn disable_fences_already_admitted_candidate_and_next_claim() {
    for stage in 0..3 {
        use orkestr_v2_application::runtime::ProviderKind;
        use orkestr_v2_application::runtime::RuntimeStore;
        use orkestr_v2_application::runtime::{
            NativeSessionConfirmation, ProductionSupervisorConfig, ProductionTakeover,
        };
        let (store, owner, conversation, directory) = bridge_fixture().await;
        let machine = "ab".repeat(32);
        store.save_session(&machine, &owner).await.unwrap();
        let handle = store
            .authorize_supervisor(
                &machine,
                ProductionSupervisorConfig {
                    provider: ProviderKind::Codex,
                    namespace: "synthetic-timer-provider".into(),
                    supervisor_key: "timer-test".into(),
                    takeover: ProductionTakeover::First,
                },
            )
            .await
            .unwrap();
        let roles = handle
            .ensure_role_bindings(&owner, &conversation)
            .await
            .unwrap();
        let binding = handle
            .confirm_native_session(NativeSessionConfirmation {
                session_id: roles.deep.session_id,
                expected_generation: roles.deep.generation,
                native_session_id: "synthetic-timer-native".into(),
                protocol_version: "codex-rpc-1".into(),
                source_event_key: "ready:1".into(),
            })
            .await
            .unwrap();
        let source = input();
        store
            .import_dormant_timer(TOKEN, &owner, &source)
            .await
            .unwrap();
        let enabled = store
            .enable_timer_input(TOKEN, &owner, &enable(&source, &conversation), NOW)
            .await
            .unwrap();
        store
            .admit_timer_input(
                TOKEN,
                &owner,
                &TimerInputRequest {
                    claim: claim(&source, &enabled),
                    text: "Synthetic timer work".into(),
                },
                NOW + 60_000,
            )
            .await
            .unwrap();
        let claim = handle
            .claim_next(
                &owner,
                &conversation,
                &binding.session_id,
                std::time::Duration::from_secs(60),
            )
            .await
            .unwrap()
            .unwrap();
        let candidate = handle
            .admit_run(&claim, &binding.session_id, binding.generation, "timer-run")
            .await
            .unwrap();
        let reservation = if stage > 0 {
            let orkestr_v2_application::runtime::DispatchClaimResult::Reserved(value) = handle
                .claim_provider_dispatch(&candidate, "reserve")
                .await
                .unwrap()
            else {
                panic!()
            };
            Some(value)
        } else {
            None
        };
        if stage == 2 {
            assert!(matches!(
                handle
                    .consume_execution(reservation.as_ref().unwrap())
                    .await
                    .unwrap(),
                crate::ExecutionConsumption::Dispatch(_)
            ));
        }
        store
            .control_dormant_timer(
                TOKEN,
                &owner,
                &TimerControlRequest {
                    namespace: source.namespace,
                    expected_revision: enabled.revision,
                    request_key: "disable-before-reserve".into(),
                    action: TimerControl::Disable,
                },
            )
            .await
            .unwrap();
        assert!(matches!(
            handle.claim_provider_dispatch(&candidate, "reserve").await,
            Err(orkestr_v2_application::runtime::RuntimeStoreError::Fenced)
        ));
        if stage == 1 {
            assert!(matches!(
                handle
                    .consume_execution(reservation.as_ref().unwrap())
                    .await,
                Err(orkestr_v2_application::runtime::RuntimeStoreError::Fenced)
            ));
        }
        if stage == 2 {
            let mut invoked = false;
            assert!(matches!(
                handle.with_execution_fence(&candidate.provider, || {
                    invoked = true;
                    Ok::<_, ()>(())
                }),
                Err(orkestr_v2_application::runtime::RuntimeStoreError::Fenced)
            ));
            assert!(!invoked);
        }
        assert!(handle
            .claim_next(
                &owner,
                &conversation,
                &binding.session_id,
                std::time::Duration::from_secs(60)
            )
            .await
            .unwrap()
            .is_none());
        handle.close().await;
        cleanup(store, directory).await;
    }
}
