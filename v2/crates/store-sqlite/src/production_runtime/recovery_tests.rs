use super::tests::{claim, config, ready, setup, snapshot};
use super::*;
#[tokio::test]
async fn recovery_is_bound_readonly_and_preserves_unknown_cancellation() {
    for cancel in [false, true] {
        let f = setup().await;
        let b = ready(&f).await;
        let c = claim(&f, &b).await;
        let run = f
            .handle
            .admit_run(&c, &b.session_id, b.generation, "recover-run")
            .await
            .unwrap();
        let DispatchClaimResult::Reserved(reservation) = f
            .handle
            .claim_provider_dispatch(&run, "reserve")
            .await
            .unwrap()
        else {
            panic!()
        };
        f.handle.consume_execution(&reservation).await.unwrap();
        if cancel {
            f.handle
                .request_cancel(&f.owner, &run.provider.run.run_id, "cancel")
                .await
                .unwrap();
        }
        // A live supervisor must never fence its own current turn via recovery.
        let before = snapshot(&f.store).await;
        assert!(f
            .handle
            .recover_runtime(
                &f.owner,
                f.handle.supervisor_incarnation().unwrap(),
                i64::MAX,
                None,
                100
            )
            .await
            .unwrap()
            .records
            .is_empty());
        assert_eq!(snapshot(&f.store).await, before);
        sqlx::query("UPDATE production_supervisors SET lease_deadline_ms=0")
            .execute(&f.store.pool)
            .await
            .unwrap();
        let successor = f
            .store
            .authorize_supervisor(
                &f.token,
                config(ProductionTakeover::ExpiredPredecessor {
                    incarnation_id: f.handle.supervisor_incarnation().unwrap().into(),
                }),
            )
            .await
            .unwrap();
        let before = snapshot(&f.store).await;
        let page = successor
            .recover_runtime(
                &f.owner,
                successor.supervisor_incarnation().unwrap(),
                0,
                None,
                1,
            )
            .await
            .unwrap();
        assert_eq!(page.records.len(), 1);
        assert!(page.next_cursor.is_none());
        let record = &page.records[0];
        assert_eq!(
            record.state,
            Some(if cancel {
                RunState::CancelRequested
            } else {
                RunState::Blocked
            })
        );
        assert_eq!(record.inflight_status, InflightStatus::Unknown);
        assert!(record.requires_reconciliation);
        assert_eq!(record.binding.state, SessionState::Lost);
        assert_eq!(
            record.admission.as_ref().unwrap().run_id,
            run.provider.run.run_id
        );
        assert_eq!(
            record.admission.as_ref().unwrap().purpose,
            if cancel {
                AdmissionPurpose::CancellationAcknowledgement
            } else {
                AdmissionPurpose::Execution
            }
        );
        assert!(matches!(
            successor
                .recover_runtime(&f.owner, "caller-invented", 0, None, 1)
                .await,
            Err(RuntimeStoreError::Unauthorized)
        ));
        assert!(matches!(
            successor
                .recover_runtime(
                    &OwnerId(Uuid::new_v4()),
                    successor.supervisor_incarnation().unwrap(),
                    0,
                    None,
                    1
                )
                .await,
            Err(RuntimeStoreError::Unauthorized)
        ));
        assert!(successor
            .recover_runtime(
                &f.owner,
                successor.supervisor_incarnation().unwrap(),
                0,
                Some("invented"),
                1
            )
            .await
            .is_err());
        assert_eq!(snapshot(&f.store).await, before);
    }
}
#[tokio::test]
async fn recovery_pages_are_context_bound_and_terminal_history_is_not_rewritten() {
    use orkestr_v2_application::IntakeStore;
    use orkestr_v2_contracts::ProjectInput;
    let f = setup().await;
    let mut expected = Vec::new();
    for index in 0..3 {
        let project = f
            .store
            .create_project(
                &f.owner,
                &ProjectInput {
                    client_request_id: format!("project-{index}"),
                    name: format!("Synthetic {index}"),
                },
            )
            .await
            .unwrap()
            .project;
        let binding = f
            .handle
            .ensure_role_bindings(&f.owner, &project.conversation_id)
            .await
            .unwrap()
            .deep;
        let binding = f
            .handle
            .confirm_native_session(NativeSessionConfirmation {
                session_id: binding.session_id,
                expected_generation: binding.generation,
                native_session_id: format!("synthetic-native-{index}"),
                protocol_version: "codex-rpc-1".into(),
                source_event_key: format!("ready-{index}"),
            })
            .await
            .unwrap();
        let scoped = super::tests::Case {
            store: f.store.clone(),
            handle: f.handle.clone(),
            root: f.root.clone(),
            owner: f.owner.clone(),
            conversation: project.conversation_id,
            token: f.token.clone(),
        };
        let claim = claim(&scoped, &binding).await;
        let run = f
            .handle
            .admit_run(&claim, &binding.session_id, binding.generation, "run")
            .await
            .unwrap();
        if index == 2 {
            let DispatchClaimResult::Reserved(r) = f
                .handle
                .claim_provider_dispatch(&run, "reserve")
                .await
                .unwrap()
            else {
                panic!()
            };
            f.handle.consume_execution(&r).await.unwrap();
            f.handle
                .append_provider_event(
                    &f.owner,
                    &run.provider,
                    &ProviderEventInput {
                        run_id: run.provider.run.run_id.clone(),
                        session_id: binding.session_id,
                        sequence: 1,
                        lease_generation: run.provider.run.lease_generation,
                        dispatch_fence: run.provider.run.dispatch_fence,
                        event: ProviderEvent::Failed,
                    },
                )
                .await
                .unwrap();
        } else {
            expected.push(run.provider.run.run_id);
        }
    }
    sqlx::query("UPDATE production_supervisors SET lease_deadline_ms=0")
        .execute(&f.store.pool)
        .await
        .unwrap();
    let successor = f
        .store
        .authorize_supervisor(
            &f.token,
            config(ProductionTakeover::ExpiredPredecessor {
                incarnation_id: f.handle.supervisor_incarnation().unwrap().into(),
            }),
        )
        .await
        .unwrap();
    let before = snapshot(&f.store).await;
    let instance = successor.supervisor_incarnation().unwrap();
    let first = successor
        .recover_runtime(&f.owner, instance, 0, None, 1)
        .await
        .unwrap();
    let cursor = first.next_cursor.as_deref().unwrap();
    let second = successor
        .recover_runtime(&f.owner, instance, i64::MAX, Some(cursor), 1)
        .await
        .unwrap();
    assert!(second.next_cursor.is_none());
    let mut got = vec![
        first.records[0].admission.as_ref().unwrap().run_id.clone(),
        second.records[0].admission.as_ref().unwrap().run_id.clone(),
    ];
    got.sort_by_key(|id| id.to_string());
    expected.sort_by_key(|id| id.to_string());
    assert_eq!(got, expected);
    assert!(first
        .records
        .iter()
        .chain(&second.records)
        .all(|r| r.inflight_status == InflightStatus::NotDispatched));
    assert_eq!(
        successor
            .recover_runtime(&f.owner, instance, 0, None, 1)
            .await
            .unwrap(),
        first
    );
    let mut other_config = config(ProductionTakeover::First);
    other_config.supervisor_key = "other-supervisor".into();
    let other = f
        .store
        .authorize_supervisor(&f.token, other_config)
        .await
        .unwrap();
    let after_other = snapshot(&f.store).await;
    assert!(matches!(
        other
            .recover_runtime(
                &f.owner,
                other.supervisor_incarnation().unwrap(),
                0,
                Some(cursor),
                1
            )
            .await,
        Err(RuntimeStoreError::Unauthorized)
    ));
    assert_eq!(snapshot(&f.store).await, after_other);
    // The only expected change since the scoped read was the distinct bootstrap.
    assert_ne!(before, after_other);
    let failed: i64 =
        sqlx::query_scalar("SELECT count(*) FROM production_runs WHERE state='failed'")
            .fetch_one(&f.store.pool)
            .await
            .unwrap();
    assert_eq!(failed, 1);
}
