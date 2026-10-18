use super::observation_tests::{consumed, input};
use super::tests::{setup, snapshot};
use super::*;
use orkestr_v2_application::IntakeStore;
use orkestr_v2_contracts::{ExecutionAcceptanceRequest, ExecutionPhase, MessageInput};
use std::time::Duration;

async fn proposal(f: &tests::Case) -> (ProviderAdmission, ExecutionAcceptanceRequest) {
    let p = consumed(f).await;
    f.handle
        .append_provider_event(&f.owner, &p, &input(&p, 1, ProviderEvent::Started))
        .await
        .unwrap();
    let done = f
        .handle
        .append_provider_event(
            &f.owner,
            &p,
            &input(&p, 2, ProviderEvent::CompletedProposal { synthetic: false }),
        )
        .await
        .unwrap();
    let revision = f
        .store
        .execution_status(&f.owner, &f.conversation)
        .await
        .unwrap()
        .unwrap()
        .revision;
    let request = ExecutionAcceptanceRequest {
        run_id: p.run.run_id.clone(),
        completion_event_id: done.event_id,
        expected_revision: revision,
        request_key: "accept:1".into(),
    };
    (p, request)
}

#[tokio::test]
async fn concurrent_owner_acceptance_replays_without_releasing_successor() {
    let f = setup().await;
    let (p, request) = proposal(&f).await;
    let other = Store::open(&f.root.join("core.sqlite3")).await.unwrap();
    let (a, b) = tokio::join!(
        f.store
            .accept_execution(&f.owner, &f.conversation, &request),
        other.accept_execution(&f.owner, &f.conversation, &request)
    );
    let accepted = a.unwrap();
    assert_eq!(accepted, b.unwrap());
    assert!(accepted.is_valid());
    assert_eq!(
        f.store
            .execution_status(&f.owner, &f.conversation)
            .await
            .unwrap()
            .unwrap()
            .phase,
        ExecutionPhase::Completed
    );
    let binding = f
        .handle
        .ensure_role_bindings(&f.owner, &f.conversation)
        .await
        .unwrap()
        .deep;
    assert_eq!(binding.session_id, p.run.session_id);
    assert_eq!(binding.state, SessionState::Ready);
    f.store
        .admit(
            &f.owner,
            &f.conversation,
            &MessageInput {
                client_message_id: "next-input".into(),
                text: "next turn".into(),
            },
        )
        .await
        .unwrap();
    let claim = f
        .handle
        .claim_next(
            &f.owner,
            &f.conversation,
            &binding.session_id,
            Duration::from_secs(60),
        )
        .await
        .unwrap()
        .unwrap();
    let run = f
        .handle
        .admit_run(&claim, &binding.session_id, binding.generation, "next-turn")
        .await
        .unwrap();
    assert_eq!(run.disposition, AdmissionDisposition::FreshCandidate);
    let before = snapshot(&f.store).await;
    assert_eq!(
        other
            .accept_execution(&f.owner, &f.conversation, &request)
            .await
            .unwrap(),
        accepted
    );
    assert_eq!(snapshot(&f.store).await, before);
    let mut changed = request.clone();
    changed.request_key = "accept:other".into();
    assert!(matches!(
        f.store
            .accept_execution(&f.owner, &f.conversation, &changed)
            .await,
        Err(RuntimeStoreError::Fenced)
    ));
    assert_eq!(snapshot(&f.store).await, before);
    let history = f
        .store
        .events(&f.owner, &f.conversation, 0, 100)
        .await
        .unwrap();
    assert_eq!(
        history
            .iter()
            .filter(|e| e.sse_name() == "execution_accepted")
            .count(),
        1
    );
}

#[tokio::test]
async fn acceptance_refusals_preserve_complete_rows_and_never_self_accept() {
    let f = setup().await;
    let (_, request) = proposal(&f).await;
    let before = snapshot(&f.store).await;
    assert!(matches!(
        f.handle
            .accept_execution(&f.owner, &f.conversation, &request)
            .await,
        Err(RuntimeStoreError::Unauthorized)
    ));
    assert_eq!(snapshot(&f.store).await, before);
    for field in ["completion", "run", "revision"] {
        let mut bad = request.clone();
        match field {
            "completion" => bad.completion_event_id = orkestr_v2_contracts::EventId(Uuid::new_v4()),
            "run" => bad.run_id = orkestr_v2_contracts::RunId(Uuid::new_v4()),
            _ => bad.expected_revision += 1,
        }
        assert!(f
            .store
            .accept_execution(&f.owner, &f.conversation, &bad)
            .await
            .is_err());
        assert_eq!(snapshot(&f.store).await, before);
    }
    assert!(f
        .store
        .accept_execution(&OwnerId(Uuid::new_v4()), &f.conversation, &request)
        .await
        .is_err());
    assert_eq!(snapshot(&f.store).await, before);
    let receipt = f
        .store
        .accept_execution(&f.owner, &f.conversation, &request)
        .await
        .unwrap();
    let committed = snapshot(&f.store).await;
    let mut bad = request.clone();
    bad.expected_revision += 1;
    assert!(matches!(
        f.store
            .accept_execution(&f.owner, &f.conversation, &bad)
            .await,
        Err(RuntimeStoreError::Conflict)
    ));
    assert_eq!(snapshot(&f.store).await, committed);
    let reopened = Store::open(&f.root.join("core.sqlite3")).await.unwrap();
    assert_eq!(
        reopened
            .accept_execution(&f.owner, &f.conversation, &request)
            .await
            .unwrap(),
        receipt
    );
    assert_eq!(snapshot(&f.store).await, committed);
}

#[tokio::test]
async fn failed_or_blocked_output_never_grants_acceptance() {
    for event in [ProviderEvent::Failed, ProviderEvent::Lost] {
        let f = setup().await;
        let p = consumed(&f).await;
        let evidence = f
            .handle
            .append_provider_event(&f.owner, &p, &input(&p, 1, event))
            .await
            .unwrap();
        let request = ExecutionAcceptanceRequest {
            run_id: p.run.run_id,
            completion_event_id: evidence.event_id,
            expected_revision: f
                .store
                .execution_status(&f.owner, &f.conversation)
                .await
                .unwrap()
                .unwrap()
                .revision,
            request_key: "not-a-proposal".into(),
        };
        let before = snapshot(&f.store).await;
        assert!(matches!(
            f.store
                .accept_execution(&f.owner, &f.conversation, &request)
                .await,
            Err(RuntimeStoreError::Fenced)
        ));
        assert_eq!(snapshot(&f.store).await, before);
    }
}

#[tokio::test]
async fn acceptance_write_failure_rolls_back_binding_event_outbox_and_revision() {
    let f = setup().await;
    let (_, request) = proposal(&f).await;
    sqlx::query("CREATE TRIGGER reject_acceptance BEFORE INSERT ON production_acceptances BEGIN SELECT RAISE(ABORT,'synthetic persistence failure'); END")
        .execute(&f.store.pool).await.unwrap();
    let before = snapshot(&f.store).await;
    assert!(matches!(
        f.store
            .accept_execution(&f.owner, &f.conversation, &request)
            .await,
        Err(RuntimeStoreError::Unavailable)
    ));
    assert_eq!(snapshot(&f.store).await, before);
    sqlx::query("DROP TRIGGER reject_acceptance")
        .execute(&f.store.pool)
        .await
        .unwrap();
    assert!(f
        .store
        .accept_execution(&f.owner, &f.conversation, &request)
        .await
        .unwrap()
        .is_valid());
}

#[tokio::test]
async fn authenticated_acceptance_fences_revocation_before_commit_and_receipt_replay() {
    let f = setup().await;
    let (_, request) = proposal(&f).await;
    assert_eq!(
        f.store.authenticate(&f.token).await.unwrap(),
        Some(f.owner.clone())
    );
    f.store.revoke_session(&f.token).await.unwrap();
    let before = snapshot(&f.store).await;
    // Model a route that cached owner before revocation: the in-transaction
    // guard must refuse even when its preliminary lookup had succeeded.
    assert!(matches!(
        f.store
            .accept_execution_guarded(&f.owner, &f.conversation, &request, Some(&f.token))
            .await,
        Err(RuntimeStoreError::Unauthorized)
    ));
    assert!(matches!(
        f.store
            .accept_execution_authenticated(&f.token, &f.conversation, &request)
            .await,
        Err(RuntimeStoreError::Unauthorized)
    ));
    assert_eq!(snapshot(&f.store).await, before);
    f.store.save_session(&f.token, &f.owner).await.unwrap();
    let receipt = f
        .store
        .accept_execution_authenticated(&f.token, &f.conversation, &request)
        .await
        .unwrap();
    assert_eq!(
        f.store
            .accept_execution_authenticated(&f.token, &f.conversation, &request)
            .await
            .unwrap(),
        receipt
    );
    f.store.revoke_session(&f.token).await.unwrap();
    let other = Store::open(&f.root.join("core.sqlite3")).await.unwrap();
    let before = snapshot(&other).await;
    assert!(matches!(
        other
            .accept_execution_authenticated(&f.token, &f.conversation, &request)
            .await,
        Err(RuntimeStoreError::Unauthorized)
    ));
    assert_eq!(snapshot(&other).await, before);
    other.close().await;
}

#[tokio::test]
async fn acceptance_candidate_is_exact_atomic_completion_and_disappears_after_decision() {
    let f = setup().await;
    let (_, request) = proposal(&f).await;
    let status = f
        .store
        .execution_status(&f.owner, &f.conversation)
        .await
        .unwrap()
        .unwrap();
    assert!(status.is_valid());
    let candidate = status.acceptance_candidate.as_ref().unwrap();
    assert_eq!(candidate.run_id, request.run_id);
    assert_eq!(candidate.completion_event_id, request.completion_event_id);
    assert_eq!(status.revision, request.expected_revision);
    let mut forged = status.clone();
    forged.acceptance_candidate.as_mut().unwrap().run_id =
        orkestr_v2_contracts::RunId(Uuid::new_v4());
    assert!(!forged.is_valid());
    assert!(!status.same_revision_state(&forged));
    forged = status.clone();
    forged.phase = orkestr_v2_contracts::ExecutionPhase::Completed;
    assert!(!forged.is_valid());
    let mut legacy = serde_json::to_value(&status).unwrap();
    legacy
        .as_object_mut()
        .unwrap()
        .remove("acceptance_candidate");
    let legacy: orkestr_v2_contracts::ExecutionStatus = serde_json::from_value(legacy).unwrap();
    assert!(legacy.is_valid());
    assert!(legacy.acceptance_candidate.is_none());
    f.store
        .accept_execution_authenticated(&f.token, &f.conversation, &request)
        .await
        .unwrap();
    let accepted = f
        .store
        .execution_status(&f.owner, &f.conversation)
        .await
        .unwrap()
        .unwrap();
    assert!(accepted.is_valid());
    assert!(accepted.acceptance_candidate.is_none());
}

#[cfg(feature = "fixture-test-controls")]
#[tokio::test]
async fn public_authentication_checkpoint_resumes_after_committed_logout() {
    let mut f = setup().await;
    let (_, request) = proposal(&f).await;
    let marker = f.root.join("auth-checkpoint");
    f.store
        .production_arm_owner_checkpoint(
            &f.owner,
            &f.conversation,
            crate::ProductionCheckpoint::AcceptanceAfterAuthentication,
            marker.clone(),
        )
        .await
        .unwrap();
    let writer = f.store.clone();
    let conversation = f.conversation.clone();
    let token = f.token.clone();
    let pending = tokio::spawn(async move {
        writer
            .accept_execution_authenticated(&token, &conversation, &request)
            .await
    });
    tokio::time::timeout(Duration::from_secs(5), async {
        while !marker.exists() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    assert_eq!(
        std::fs::read(&marker).unwrap(),
        b"acceptance-after-authentication"
    );
    let other = Store::open(&f.root.join("core.sqlite3")).await.unwrap();
    other.revoke_session(&f.token).await.unwrap();
    let before = snapshot(&other).await;
    std::fs::remove_file(&marker).unwrap();
    assert!(matches!(
        pending.await.unwrap(),
        Err(RuntimeStoreError::Unauthorized)
    ));
    assert_eq!(snapshot(&other).await, before);
    other.close().await;
}

#[tokio::test]
async fn followup_ingress_advances_revision_without_changing_completion_candidate() {
    let f = setup().await;
    let (_, mut request) = proposal(&f).await;
    let original = f
        .store
        .execution_status(&f.owner, &f.conversation)
        .await
        .unwrap()
        .unwrap();
    let followup = MessageInput {
        client_message_id: "browser-conflict-followup".into(),
        text: "synthetic queued followup; do not claim".into(),
    };
    f.store
        .admit(&f.owner, &f.conversation, &followup)
        .await
        .unwrap();
    let refreshed = f
        .store
        .execution_status(&f.owner, &f.conversation)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(refreshed.phase, ExecutionPhase::AwaitingAcceptance);
    assert_eq!(refreshed.run_id, original.run_id);
    assert_eq!(
        refreshed.acceptance_candidate,
        original.acceptance_candidate
    );
    assert!(refreshed.revision > original.revision);
    // Same ingress identity must not manufacture another conflict/revision.
    f.store
        .admit(&f.owner, &f.conversation, &followup)
        .await
        .unwrap();
    assert_eq!(
        f.store
            .execution_status(&f.owner, &f.conversation)
            .await
            .unwrap()
            .unwrap()
            .revision,
        refreshed.revision
    );
    let before = snapshot(&f.store).await;
    assert!(matches!(
        f.store
            .accept_execution_authenticated(&f.token, &f.conversation, &request)
            .await,
        Err(RuntimeStoreError::Conflict)
    ));
    assert_eq!(snapshot(&f.store).await, before);
    // A deliberate refreshed owner decision uses the same immutable completion,
    // not a guessed later event. The refused request did not reserve its key.
    request.expected_revision = refreshed.revision;
    let accepted = f
        .store
        .accept_execution_authenticated(&f.token, &f.conversation, &request)
        .await
        .unwrap();
    assert_eq!(accepted.completion_event_id, request.completion_event_id);
}
