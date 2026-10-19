use super::super::tests::{self as harness, Case};
use super::*;
use orkestr_v2_application::IntakeStore;
use orkestr_v2_contracts::MessageInput;

async fn input(f: &Case) -> FastAdmissionInput {
    let roles = f
        .handle
        .ensure_role_bindings(&f.owner, &f.conversation)
        .await
        .unwrap();
    let fast = f
        .handle
        .confirm_native_session(NativeSessionConfirmation {
            session_id: roles.fast.session_id,
            expected_generation: roles.fast.generation,
            native_session_id: "synthetic-native-fast".into(),
            protocol_version: "codex-rpc-1".into(),
            source_event_key: "fast-ready:1".into(),
        })
        .await
        .unwrap();
    f.store
        .admit(
            &f.owner,
            &f.conversation,
            &MessageInput {
                client_message_id: "fast-input:1".into(),
                text: "immutable synthetic owner input".into(),
            },
        )
        .await
        .unwrap();
    let source = sqlx::query(
        "SELECT id,message_id FROM events WHERE conversation_id=? AND kind='message_accepted'",
    )
    .bind(f.conversation.to_string())
    .fetch_one(&f.store.pool)
    .await
    .unwrap();
    FastAdmissionInput {
        source_message_id: MessageId(Uuid::parse_str(source.get("message_id")).unwrap()),
        source_event_id: EventId(Uuid::parse_str(source.get("id")).unwrap()),
        fast_binding_id: fast.session_id,
        expected_binding_generation: fast.generation,
        request_key: "fast-input:1".into(),
    }
}
async fn inbox(f: &Case) -> Vec<String> {
    sqlx::query_scalar("SELECT json_array(conversation_id,sequence,message_id,event_id,state,claim_generation,claimant_session_id,claim_deadline_ms,admitted_run_id) FROM reasoning_inbox ORDER BY sequence")
        .fetch_all(&f.store.pool).await.unwrap()
}
#[tokio::test]
async fn independent_fast_race_replay_consume_reopen_never_spends_deep_claim() {
    let f = harness::setup().await;
    let i = input(&f).await;
    let deep = harness::ready(&f).await;
    let before = inbox(&f).await;
    let second = Store::open(&f.root.join("core.sqlite3")).await.unwrap();
    let h = f.handle.reattach_supervisor(&second).await.unwrap();
    let (a, b) = tokio::join!(
        f.handle.admit_fast(&f.token, &i),
        h.admit_fast(&f.token, &i)
    );
    let (a, b) = (a.unwrap(), b.unwrap());
    let (fresh, replay) = if a.disposition == AdmissionDisposition::FreshCandidate {
        (a, b)
    } else {
        (b, a)
    };
    assert_eq!(fresh.provider, replay.provider);
    assert_eq!(fresh.provider.run.role, Role::Fast);
    assert_eq!(fresh.provider.binding.role, Role::Fast);
    assert_ne!(fresh.provider.run.session_id, deep.session_id);
    assert_eq!(replay.disposition, AdmissionDisposition::Replay);
    assert!(replay.candidate_key.is_none());
    assert_eq!(inbox(&f).await, before);
    let reservation = match f
        .handle
        .claim_provider_dispatch(&fresh, "fast-reserve")
        .await
        .unwrap()
    {
        DispatchClaimResult::Reserved(c) => c,
        _ => panic!("fresh reservation"),
    };
    let cap = match f.handle.consume_execution(&reservation).await.unwrap() {
        ExecutionConsumption::Dispatch(cap) => cap,
        _ => panic!("fresh consumption"),
    };
    assert_eq!(cap.provider().run.role, Role::Fast);
    assert_eq!(cap.text(), "immutable synthetic owner input");
    let no_tools = harness::snapshot(&f.store).await;
    assert!(matches!(
        f.handle
            .delegate_offline_python(&f.token, &cap, "forbidden-fast-tool", "print(1)", 1000)
            .await,
        Err(RuntimeStoreError::Fenced)
    ));
    assert_eq!(no_tools, harness::snapshot(&f.store).await);
    assert!(matches!(
        f.handle.consume_execution(&reservation).await.unwrap(),
        ExecutionConsumption::ReconciliationRequired
    ));
    assert_eq!(inbox(&f).await, before);
    let deep_claim = f
        .handle
        .claim_next(
            &f.owner,
            &f.conversation,
            &deep.session_id,
            std::time::Duration::from_secs(60),
        )
        .await
        .unwrap()
        .unwrap();
    assert_eq!(deep_claim.event_id, i.source_event_id);
    let deep_run = f
        .handle
        .admit_run(
            &deep_claim,
            &deep.session_id,
            deep.generation,
            "deep-input:1",
        )
        .await
        .unwrap();
    assert_eq!(deep_run.provider.run.role, Role::Deep);
    second.close().await;
    let reopened = Store::open(&f.root.join("core.sqlite3")).await.unwrap();
    let attached = f.handle.reattach_supervisor(&reopened).await.unwrap();
    let snapshot = harness::snapshot(&reopened).await;
    let old = attached.admit_fast(&f.token, &i).await.unwrap();
    assert_eq!(
        old.disposition,
        AdmissionDisposition::ReconciliationRequired
    );
    assert!(old.candidate_key.is_none());
    assert_eq!(snapshot, harness::snapshot(&reopened).await);
}
#[tokio::test]
async fn fast_changed_source_key_binding_and_revocation_refuse_without_writes() {
    let f = harness::setup().await;
    let i = input(&f).await;
    let deep = harness::ready(&f).await;
    let before = harness::snapshot(&f.store).await;
    for mutation in 0..5 {
        let mut changed = i.clone();
        match mutation {
            0 => changed.source_message_id = MessageId(Uuid::new_v4()),
            1 => changed.source_event_id = EventId(Uuid::new_v4()),
            2 => changed.fast_binding_id = deep.session_id.clone(),
            3 => changed.expected_binding_generation += 1,
            _ => changed.fast_binding_id = SessionId(Uuid::new_v4()),
        }
        assert!(f.handle.admit_fast(&f.token, &changed).await.is_err());
        assert_eq!(before, harness::snapshot(&f.store).await);
    }
    let fresh = f.handle.admit_fast(&f.token, &i).await.unwrap();
    let after = harness::snapshot(&f.store).await;
    for mutation in 0..3 {
        let mut changed = i.clone();
        match mutation {
            0 => changed.request_key = "replacement-key".into(),
            1 => changed.fast_binding_id = deep.session_id.clone(),
            _ => changed.expected_binding_generation += 1,
        }
        assert!(matches!(
            f.handle.admit_fast(&f.token, &changed).await,
            Err(RuntimeStoreError::Conflict)
        ));
        assert_eq!(after, harness::snapshot(&f.store).await);
    }
    let mut forged = fresh.clone();
    forged.provider.run.role = Role::Deep;
    assert!(f
        .handle
        .claim_provider_dispatch(&forged, "forged")
        .await
        .is_err());
    assert_eq!(after, harness::snapshot(&f.store).await);
    f.store.revoke_session(&f.token).await.unwrap();
    assert!(matches!(
        f.handle.admit_fast(&f.token, &i).await,
        Err(RuntimeStoreError::Unauthorized)
    ));
    assert_eq!(after, harness::snapshot(&f.store).await);
    assert!(matches!(
        f.store.admit_fast(&f.token, &i).await,
        Err(RuntimeStoreError::Unavailable)
    ));
}

#[tokio::test]
async fn fast_observation_cancel_and_historical_receipts_keep_role_and_inbox() {
    use super::super::observation_tests::input as observation;
    let f = harness::setup().await;
    let i = input(&f).await;
    let admission = f.handle.admit_fast(&f.token, &i).await.unwrap();
    let DispatchClaimResult::Reserved(reservation) = f
        .handle
        .claim_provider_dispatch(&admission, "fast-reserve")
        .await
        .unwrap()
    else {
        panic!()
    };
    assert!(matches!(
        f.handle.consume_execution(&reservation).await.unwrap(),
        ExecutionConsumption::Dispatch(_)
    ));
    let original = &admission.provider;
    let started = observation(original, 1, ProviderEvent::Started);
    let receipt = f
        .handle
        .append_provider_event(&f.owner, original, &started)
        .await
        .unwrap();
    assert_eq!(receipt.state, RunState::Running);
    let before = inbox(&f).await;
    let control = f
        .handle
        .request_cancel(&f.owner, &original.run.run_id, "fast-stop")
        .await
        .unwrap();
    assert_eq!(control.new_fenced_admission.role, Role::Fast);
    assert_eq!(
        control.new_fenced_admission.purpose,
        AdmissionPurpose::CancellationAcknowledgement
    );
    let mut control_provider = original.clone();
    control_provider.run = control.new_fenced_admission.clone();
    assert!(f
        .handle
        .append_provider_event(
            &f.owner,
            original,
            &observation(
                original,
                2,
                ProviderEvent::CompletedProposal { synthetic: false }
            )
        )
        .await
        .is_err());
    let stopped = observation(&control_provider, 2, ProviderEvent::Stopped);
    let terminal = f
        .handle
        .append_provider_event(&f.owner, &control_provider, &stopped)
        .await
        .unwrap();
    assert_eq!(terminal.state, RunState::Cancelled);
    let after = harness::snapshot(&f.store).await;
    assert_eq!(
        f.handle
            .append_provider_event(&f.owner, original, &started)
            .await
            .unwrap()
            .event_id,
        receipt.event_id
    );
    assert_eq!(
        f.handle
            .request_cancel(&f.owner, &original.run.run_id, "fast-stop")
            .await
            .unwrap(),
        control
    );
    assert_eq!(after, harness::snapshot(&f.store).await);
    assert_eq!(before, inbox(&f).await);
}

#[path = "fast_tests/lifecycle.rs"]
mod lifecycle;
