//! Independent refusal matrix; every mutation is confined to synthetic returned DTOs.
use super::*;
use orkestr_v2_contracts::{ConversationId, OwnerId, SessionId};

#[tokio::test]
async fn authoritative_envelope_refusals_preserve_attempt_and_reservation() {
    let c = Case::new().await;
    let fresh = c.admit(&c.h).await;
    let before =
        c.h.inspect_fixture_scope(&c.claim.conversation_id)
            .await
            .unwrap();
    let mut variants = Vec::new();
    for n in 0..14 {
        let mut x = fresh.clone();
        match n {
            0 => x.provider.run.owner_id = OwnerId(x.provider.run.run_id.0),
            1 => x.provider.run.conversation_id = ConversationId(x.provider.run.run_id.0),
            2 => x.provider.run.session_id = SessionId(x.provider.run.run_id.0),
            3 => x.provider.run.role = Role::Fast,
            4 => x.provider.run.purpose = AdmissionPurpose::CancellationAcknowledgement,
            5 => x.provider.run.lease_generation += 1,
            6 => x.provider.run.dispatch_fence += 1,
            7 => x.provider.run.attempt += 1,
            8 => x.provider.run.lease_deadline_ms += 1,
            9 => x.provider.run.native_session_id = Some("synthetic-forgery".into()),
            10 => x.provider.binding.generation += 1,
            11 => x.provider.binding.role = Role::Worker,
            12 => x.provider.binding.state = SessionState::Lost,
            _ => x.provider.binding.native_session_id = None,
        }
        variants.push(x);
    }
    for (n, x) in variants.iter().enumerate() {
        assert!(
            c.h.claim_provider_dispatch(x, "reserve").await.is_err(),
            "reservation envelope mutation {n}"
        );
        assert_eq!(
            c.h.inspect_fixture_scope(&c.claim.conversation_id)
                .await
                .unwrap(),
            before
        );
    }
    let r = match c
        .h
        .claim_provider_dispatch(&fresh, "reserve")
        .await
        .unwrap()
    {
        DispatchClaimResult::Reserved(r) => r,
        _ => panic!("reserved"),
    };
    let before =
        c.h.inspect_fixture_attempt(&c.claim.conversation_id, "admit")
            .await
            .unwrap();
    for (n, x) in variants.into_iter().enumerate() {
        let changed = DispatchClaim {
            provider: x.provider,
            reservation_key: r.reservation_key.clone(),
        };
        assert!(
            c.h.consume_provider_dispatch(&changed).await.is_err(),
            "consume envelope mutation {n}"
        );
        assert_eq!(
            c.h.inspect_fixture_attempt(&c.claim.conversation_id, "admit")
                .await
                .unwrap(),
            before
        );
    }
    assert!(matches!(
        c.h.claim_provider_dispatch(&fresh, "different-key").await,
        Err(RuntimeStoreError::Conflict)
    ));
    assert_eq!(
        c.h.consume_provider_dispatch(&r).await.unwrap(),
        DispatchConsumption::DispatchNow
    );
    c.close().await;
}
#[tokio::test]
async fn unready_protocol_and_semantic_claim_refusals_leave_zero_attempts() {
    let c = Case::new().await;
    let roles =
        c.a.ensure_role_bindings(&c.claim.owner_id, &c.claim.conversation_id)
            .await
            .unwrap();
    assert!(matches!(
        c.h.confirm_fixture_readiness(&roles.fast.session_id, 1)
            .await,
        Err(RuntimeStoreError::InvalidInput)
    ));
    assert!(matches!(
        c.h.confirm_fixture_readiness(&c.binding.session_id, 2)
            .await,
        Err(RuntimeStoreError::InvalidInput)
    ));
    let before =
        c.h.inspect_fixture_scope(&c.claim.conversation_id)
            .await
            .unwrap();
    assert_eq!(before.attempts, 0);
    for n in 0..7 {
        let mut claim = c.claim.clone();
        let mut generation = c.binding.generation;
        match n {
            0 => claim.owner_id = OwnerId(c.binding.session_id.0),
            1 => claim.conversation_id = ConversationId(c.binding.session_id.0),
            2 => claim.consumer_session_id = roles.fast.session_id.clone(),
            3 => claim.claim_generation += 1,
            4 => claim.scope_sequence += 1,
            5 => claim.lease_deadline_ms += 1,
            _ => generation += 1,
        }
        assert!(
            c.h.admit_run(&claim, &c.binding.session_id, generation, "negative")
                .await
                .is_err(),
            "claim mutation {n}"
        );
        assert_eq!(
            c.h.inspect_fixture_scope(&c.claim.conversation_id)
                .await
                .unwrap(),
            before
        );
    }
    assert_eq!(
        c.admit(&c.h).await.disposition,
        AdmissionDisposition::FreshCandidate
    );
    c.close().await;
}

pub(super) async fn project_claim(c: &Case, key: &str, ready: bool) -> (Binding, InboxClaim) {
    let project =
        c.a.create_project(
            &c.claim.owner_id,
            &orkestr_v2_contracts::ProjectInput {
                client_request_id: key.into(),
                name: format!("Synthetic {key}"),
            },
        )
        .await
        .unwrap()
        .project;
    let roles =
        c.a.ensure_role_bindings(&c.claim.owner_id, &project.conversation_id)
            .await
            .unwrap();
    let binding = if ready {
        c.h.confirm_fixture_readiness(&roles.deep.session_id, 1)
            .await
            .unwrap()
    } else {
        roles.deep
    };
    c.a.admit(
        &c.claim.owner_id,
        &project.conversation_id,
        &MessageInput {
            client_message_id: "input".into(),
            text: format!("Synthetic {key} input"),
        },
    )
    .await
    .unwrap();
    let claim =
        c.a.claim_next(
            &c.claim.owner_id,
            &project.conversation_id,
            &binding.session_id,
            Duration::from_secs(60),
        )
        .await
        .unwrap()
        .unwrap();
    (binding, claim)
}

#[tokio::test]
async fn existing_other_project_message_and_event_ids_refuse_before_and_after_admission() {
    let c = Case::new().await;
    let (a, claim_a) = project_claim(&c, "project-a", true).await;
    let (b, claim_b) = project_claim(&c, "project-b", true).await;
    assert_ne!(claim_a.conversation_id, claim_b.conversation_id);
    assert_ne!(claim_a.message_id, claim_b.message_id);
    assert_ne!(claim_a.event_id, claim_b.event_id);
    let b_before =
        c.h.inspect_fixture_scope(&claim_b.conversation_id)
            .await
            .unwrap();
    for admitted in [false, true] {
        let before =
            c.h.inspect_fixture_scope(&claim_a.conversation_id)
                .await
                .unwrap();
        for n in 0..3 {
            let mut changed = claim_a.clone();
            if n != 1 {
                changed.message_id = claim_b.message_id.clone();
            }
            if n != 0 {
                changed.event_id = claim_b.event_id.clone();
            }
            assert_eq!(
                c.h.admit_run(&changed, &a.session_id, a.generation, "project-run")
                    .await
                    .unwrap_err(),
                if admitted {
                    RuntimeStoreError::Conflict
                } else {
                    RuntimeStoreError::StaleLease
                }
            );
            assert_eq!(
                c.h.inspect_fixture_scope(&claim_a.conversation_id)
                    .await
                    .unwrap(),
                before
            );
            assert_eq!(
                c.h.inspect_fixture_scope(&claim_b.conversation_id)
                    .await
                    .unwrap(),
                b_before
            );
            assert!(c
                .h
                .inspect_fixture_attempt(&claim_b.conversation_id, "project-run")
                .await
                .unwrap()
                .is_none());
        }
        if !admitted {
            let valid =
                c.h.admit_run(&claim_a, &a.session_id, a.generation, "project-run")
                    .await
                    .unwrap();
            assert_eq!(valid.disposition, AdmissionDisposition::FreshCandidate);
            let r = match c
                .h
                .claim_provider_dispatch(&valid, "reserve-a")
                .await
                .unwrap()
            {
                DispatchClaimResult::Reserved(r) => r,
                _ => panic!("reserved"),
            };
            assert_eq!(
                c.h.consume_provider_dispatch(&r).await.unwrap(),
                DispatchConsumption::DispatchNow
            );
        }
    }
    // The untouched other project's original claim also remains usable.
    let valid =
        c.h.admit_run(&claim_b, &b.session_id, b.generation, "project-run")
            .await
            .unwrap();
    assert_eq!(valid.disposition, AdmissionDisposition::FreshCandidate);
    let r = match c
        .h
        .claim_provider_dispatch(&valid, "reserve-b")
        .await
        .unwrap()
    {
        DispatchClaimResult::Reserved(r) => r,
        _ => panic!("reserved"),
    };
    assert_eq!(
        c.h.consume_provider_dispatch(&r).await.unwrap(),
        DispatchConsumption::DispatchNow
    );
    c.close().await;
}

#[tokio::test]
async fn unconfirmed_deep_binding_refuses_without_spending_claim_then_readiness_allows_it() {
    let c = Case::new().await;
    let (binding, claim) = project_claim(&c, "unconfirmed-project", false).await;
    assert_eq!(binding.state, SessionState::Starting);
    assert_eq!(binding.provider_kind, ProviderKind::Unconfigured);
    let before =
        c.h.inspect_fixture_scope(&claim.conversation_id)
            .await
            .unwrap();
    assert_eq!(before.attempts, 0);
    assert!(c
        .h
        .inspect_fixture_attempt(&claim.conversation_id, "unconfirmed-run")
        .await
        .unwrap()
        .is_none());
    for _ in 0..2 {
        assert_eq!(
            c.h.admit_run(
                &claim,
                &binding.session_id,
                binding.generation,
                "unconfirmed-run"
            )
            .await
            .unwrap_err(),
            RuntimeStoreError::Unavailable
        );
        assert_eq!(
            c.h.inspect_fixture_scope(&claim.conversation_id)
                .await
                .unwrap(),
            before
        );
        assert!(c
            .h
            .inspect_fixture_attempt(&claim.conversation_id, "unconfirmed-run")
            .await
            .unwrap()
            .is_none());
    }
    let ready =
        c.h.confirm_fixture_readiness(&binding.session_id, 1)
            .await
            .unwrap();
    let valid =
        c.h.admit_run(
            &claim,
            &ready.session_id,
            ready.generation,
            "unconfirmed-run",
        )
        .await
        .unwrap();
    assert_eq!(valid.disposition, AdmissionDisposition::FreshCandidate);
    let r = match c
        .h
        .claim_provider_dispatch(&valid, "reserve-ready")
        .await
        .unwrap()
    {
        DispatchClaimResult::Reserved(r) => r,
        _ => panic!("reserved"),
    };
    assert_eq!(
        c.h.consume_provider_dispatch(&r).await.unwrap(),
        DispatchConsumption::DispatchNow
    );
    c.close().await;
}
